import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
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
  const normalizedKey = target?.sessionKey
    ? normalizeStoreSessionKey(target.sessionKey)
    : undefined;
  const internalTarget =
    normalizedKey !== undefined &&
    (isInternalSessionEffectsKey(normalizedKey) ||
      normalizedKey.startsWith("internal-session-effects:"));
  const scopedAgentId =
    target?.agentId ??
    (target && !internalTarget ? parseAgentSessionKey(target.sessionKey)?.agentId : undefined);
  const scopeKey =
    internalTarget && scopedAgentId && normalizedKey
      ? normalizedKey.startsWith("agent:")
        ? normalizedKey
        : `agent:${normalizeAgentId(scopedAgentId)}:${normalizedKey}`
      : target?.sessionKey;
  const scope =
    pluginId && scopedAgentId && scopeKey && target?.storePath
      ? { agentId: scopedAgentId, sessionKey: scopeKey, storePath: target.storePath }
      : undefined;
  if (pluginId && internalTarget && (!scope || !target?.sessionId)) {
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
            current?.pluginOwnerId !== original?.pluginOwnerId ||
            current?.lifecycleRevision !== original?.lifecycleRevision
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
        current?.lifecycleRevision !== original?.lifecycleRevision ||
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
