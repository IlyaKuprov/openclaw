import { describe, expect, it, vi } from "vitest";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createPluginRuntime } from "./index.js";

const importGate = vi.hoisted(() => {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
});
const runCore = vi.hoisted(() => vi.fn());
vi.mock("./runtime-embedded-agent.runtime.js", async (importOriginal) => {
  importGate.enter();
  await importGate.waiting;
  return await importOriginal<typeof import("./runtime-embedded-agent.runtime.js")>();
});
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runCore }));

describe("plugin embedded-agent target snapshot", () => {
  it("executes against the original owned store when the caller redirects its target during lazy load", async () => {
    await withOpenClawTestState({ label: "plugin-embedded-target-mutation" }, async () => {
      const runtime = createPluginRuntime();
      const registry = createEmptyPluginRegistry();
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:active-memory:target-mutation";
      const sessionId = "target-mutation-child";
      const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
      const foreignStorePath = `${storePath}.foreign.sqlite`;
      const ownScope = { agentId, sessionKey, storePath };
      const foreignScope = { ...ownScope, storePath: foreignStorePath };
      for (const [scope, pluginOwnerId] of [
        [ownScope, "active-memory"],
        [foreignScope, "foreign-plugin"],
      ] as const) {
        await runtime.agent.session.patchSessionEntry({
          ...scope,
          fallbackEntry: { sessionId, pluginOwnerId, updatedAt: 1 },
          replaceEntry: true,
          skipMaintenance: true,
          update: (entry, context) => (context.existingEntry ? null : { ...entry, pluginOwnerId }),
        });
      }
      runCore.mockImplementationOnce(async (params) => {
        const { resolvePreparedRunAdmission } =
          await import("../../agents/admitted-run-context.js");
        await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          preparedRunAdmission: params.preparedRunAdmission,
        });
        return {
          payloads: [],
          executedStorePath: params.sessionTarget?.storePath,
          executedOwner: loadExactSessionEntryReadOnly(params.sessionTarget)?.entry.pluginOwnerId,
          executedFrozen: Object.isFrozen(params.sessionTarget),
        };
      });
      const sessionTarget = { ...ownScope, sessionId };
      let targetReads = 0;
      const pending = withPluginRuntimePluginScope(
        { pluginId: "active-memory" },
        () =>
          runtime.agent.runEmbeddedAgent({
            config: {},
            prompt: "recall",
            runId: sessionId,
            sessionId,
            sessionKey,
            agentId,
            get sessionTarget() {
              targetReads += 1;
              return targetReads === 1 ? sessionTarget : { ...foreignScope, sessionId };
            },
            workspaceDir: "/tmp/workspace",
            timeoutMs: 1000,
          }),
        registry,
      );
      const enteredImport = await Promise.race([
        importGate.entered.then(() => true),
        pending.then(
          () => false,
          () => false,
        ),
      ]);
      expect(enteredImport).toBe(true);
      expect(runCore).not.toHaveBeenCalled();
      sessionTarget.storePath = foreignStorePath;
      importGate.release();
      await expect(pending).resolves.toMatchObject({
        executedStorePath: storePath,
        executedOwner: "active-memory",
        executedFrozen: true,
      });
      expect(targetReads).toBe(1);
      expect(runCore).toHaveBeenCalledOnce();
    });
  });
});
