import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeEmbeddedRunSessionScope,
} from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const loadEmbeddedAgentRuntime = createLazyRuntimeModule(
  () => import("./runtime-embedded-agent.runtime.js"),
);

export const runEmbeddedAgentWithOwnerFence: PluginRuntime["agent"]["runEmbeddedAgent"] = async (
  params,
) => {
  const requestScope = getPluginRuntimeGatewayRequestScope();
  const pluginId = requestScope?.pluginId;
  // Snapshot plugin-controlled arguments before lazy import; fence and
  // dispatch the same owned target, never the caller's nested object.
  const request = { ...params };
  const target = request.sessionTarget ? Object.freeze({ ...request.sessionTarget }) : undefined;
  const scope =
    pluginId && target?.agentId && target.sessionKey && target.storePath
      ? { agentId: target.agentId, sessionKey: target.sessionKey, storePath: target.storePath }
      : undefined;
  if (pluginId && target && (!scope || !target.sessionId)) {
    throw new Error("Plugin embedded-agent execution requires exact session target identity.");
  }
  // Capture the persisted child before the lazy import can yield. A key and
  // session ID alone can name a different plugin's replacement afterward.
  const original = scope ? loadExactSessionEntryReadOnly(scope)?.entry : undefined;
  let changed = false;
  const unsubscribe = scope
    ? onSessionIdentityMutation((mutation) => {
        if (
          mutation.previous.sessionKeys.includes(scope.sessionKey) ||
          ("current" in mutation && mutation.current.sessionKeys.includes(scope.sessionKey))
        ) {
          // Events omit the physical store. Only a change to this exact
          // row revokes the run; same-key mutations in another DB do not.
          const current = loadExactSessionEntryReadOnly(scope)?.entry;
          if (
            Boolean(current) !== Boolean(original) ||
            current?.sessionId !== original?.sessionId ||
            current?.pluginOwnerId !== original?.pluginOwnerId
          ) {
            changed = true;
          }
        }
      })
    : undefined;
  try {
    if (original?.pluginOwnerId && original.pluginOwnerId !== pluginId) {
      throw new Error("Plugin embedded-agent session owner changed");
    }
    const runtime = await loadEmbeddedAgentRuntime();
    const assertCurrent = () => {
      requestScope?.assertPluginRuntimeCurrent?.();
      const current = scope ? loadExactSessionEntryReadOnly(scope)?.entry : undefined;
      if (
        changed ||
        Boolean(current) !== Boolean(original) ||
        current?.sessionId !== original?.sessionId ||
        current?.pluginOwnerId !== original?.pluginOwnerId ||
        (current?.pluginOwnerId && current.pluginOwnerId !== pluginId) ||
        (current && target?.sessionId && current.sessionId !== target.sessionId)
      ) {
        throw new Error("Plugin embedded-agent session owner changed");
      }
    };
    assertCurrent();
    return await withPluginRuntimeEmbeddedRunSessionScope(assertCurrent, () =>
      runtime.runPluginEmbeddedAgent({ ...request, sessionTarget: target }),
    );
  } finally {
    unsubscribe?.();
  }
};
