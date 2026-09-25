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
    entered: new Promise<void>((resolve) => (enter = resolve)),
    waiting: new Promise<void>((resolve) => (release = resolve)),
    enter: () => enter(),
    release: () => release(),
  };
});
const runCore = vi.hoisted(() => vi.fn(async () => ({ payloads: [] })));
vi.mock("./runtime-embedded-agent.runtime.js", async (importOriginal) => {
  importGate.enter();
  await importGate.waiting;
  return await importOriginal<typeof import("./runtime-embedded-agent.runtime.js")>();
});
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runCore }));

describe("plugin embedded-agent session authority", () => {
  it("allows a metadata-only update during lazy load when owner and session identity remain current", async () => {
    await withOpenClawTestState({ label: "plugin-embedded-owner-metadata" }, async () => {
      const runtime = createPluginRuntime();
      const registry = createEmptyPluginRegistry();
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:active-memory:recall-metadata";
      const sessionId = "recall-metadata";
      const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
      const scope = { agentId, sessionKey, storePath };
      await runtime.agent.session.patchSessionEntry({
        ...scope,
        fallbackEntry: { sessionId, pluginOwnerId: "active-memory", updatedAt: 1 },
        update: (entry) => entry,
      });
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
            sessionTarget: { ...scope, sessionId },
            workspaceDir: "/tmp/workspace",
            timeoutMs: 1000,
          }),
        registry,
      );
      await importGate.entered;
      await runtime.agent.session.patchSessionEntry({
        ...scope,
        update: () => ({ label: "retitled without changing authority" }),
      });
      expect(loadExactSessionEntryReadOnly(scope)?.entry?.label).toBe(
        "retitled without changing authority",
      );
      importGate.release();
      await expect(pending).resolves.toEqual({ payloads: [] });
      expect(runCore).toHaveBeenCalledOnce();
    });
  });
});
