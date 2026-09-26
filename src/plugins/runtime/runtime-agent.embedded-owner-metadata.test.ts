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
const runCore = vi.hoisted(() => vi.fn(async () => ({ payloads: [] })));
vi.mock("./runtime-embedded-agent.runtime.js", async (importOriginal) => {
  importGate.enter();
  await importGate.waiting;
  return await importOriginal<typeof import("./runtime-embedded-agent.runtime.js")>();
});
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runCore }));

describe("plugin embedded-agent session authority", () => {
  it("allows metadata changes but rejects a same-owner generation change during lazy load", async () => {
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
      const generationSessionKey =
        "agent:main:internal-session-effects:active-memory:new-generation";
      const generationSessionId = "new-generation";
      const generationScope = { agentId, sessionKey: generationSessionKey, storePath };
      await runtime.agent.session.patchSessionEntry({
        ...generationScope,
        fallbackEntry: {
          sessionId: generationSessionId,
          pluginOwnerId: "active-memory",
          lifecycleRevision: "original-generation",
          updatedAt: 1,
        },
        update: (entry) => entry,
      });
      const staleGeneration = withPluginRuntimePluginScope(
        { pluginId: "active-memory" },
        () =>
          runtime.agent.runEmbeddedAgent({
            config: {},
            prompt: "stale generation",
            runId: generationSessionId,
            sessionId: generationSessionId,
            sessionKey: generationSessionKey,
            agentId,
            sessionTarget: { ...generationScope, sessionId: generationSessionId },
            workspaceDir: "/tmp/workspace",
            timeoutMs: 1000,
          }),
        registry,
      );
      const legacySessionKey = "agent:main:internal-session-effects:legacy-fenced";
      const legacyId = "legacy-fenced";
      const legacyScope = { agentId, sessionKey: legacySessionKey, storePath };
      await runtime.agent.session.patchSessionEntry({
        ...legacyScope,
        fallbackEntry: { sessionId: legacyId, pluginOwnerId: "active-memory", updatedAt: 1 },
        update: (entry) => entry,
      });
      const rawKey = "internal-session-effects:legacy-fenced";
      const staleLegacy = withPluginRuntimePluginScope(
        { pluginId: "active-memory" },
        () =>
          runtime.agent.runEmbeddedAgent({
            config: {},
            prompt: "legacy child",
            runId: legacyId,
            sessionId: legacyId,
            sessionKey: rawKey,
            agentId,
            sessionTarget: { agentId, sessionKey: rawKey, sessionId: legacyId, storePath },
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
      await runtime.agent.session.patchSessionEntry({
        ...generationScope,
        update: () => ({ lifecycleRevision: "replacement-generation" }),
      });
      expect(loadExactSessionEntryReadOnly(generationScope)?.entry?.lifecycleRevision).toBe(
        "replacement-generation",
      );
      await runtime.agent.session.patchSessionEntry({
        ...legacyScope,
        update: () => ({ pluginOwnerId: "foreign-plugin" }),
      });
      importGate.release();
      await expect(pending).resolves.toEqual({ payloads: [] });
      await expect(staleGeneration).rejects.toThrow(/owner|session/i);
      await expect(staleLegacy).rejects.toThrow(/owner|session/i);
      expect(runCore).toHaveBeenCalledOnce();
    });
  });

  it("accepts a qualified ordinary session target without an explicit agent ID", async () => {
    await withOpenClawTestState({ label: "plugin-embedded-partial-ordinary" }, async () => {
      runCore.mockClear();
      const runtime = createPluginRuntime();
      const agentId = "main";
      const sessionKey = "agent:main:telegram:direct:ordinary-partial";
      const sessionId = "ordinary-partial";
      const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
      await runtime.agent.session.patchSessionEntry({
        agentId,
        sessionKey,
        storePath,
        fallbackEntry: { sessionId, updatedAt: 1 },
        update: (entry) => entry,
      });
      await expect(
        withPluginRuntimePluginScope(
          { pluginId: "active-memory" },
          () =>
            runtime.agent.runEmbeddedAgent({
              config: {},
              prompt: "ordinary work",
              runId: sessionId,
              sessionId,
              sessionKey,
              sessionTarget: { sessionKey, sessionId, storePath },
              workspaceDir: "/tmp/workspace",
              timeoutMs: 1000,
            }),
          createEmptyPluginRegistry(),
        ),
      ).resolves.toEqual({ payloads: [] });
      expect(runCore).toHaveBeenCalledOnce();
      const internalKey = "agent:main:internal-session-effects:partial-denied";
      const internalId = "partial-denied";
      await runtime.agent.session.patchSessionEntry({
        agentId,
        sessionKey: internalKey,
        storePath,
        fallbackEntry: { sessionId: internalId, pluginOwnerId: "active-memory", updatedAt: 1 },
        update: (entry) => entry,
      });
      await expect(
        withPluginRuntimePluginScope(
          { pluginId: "active-memory" },
          () =>
            runtime.agent.runEmbeddedAgent({
              config: {},
              prompt: "internal work",
              runId: internalId,
              sessionId: internalId,
              sessionKey: internalKey,
              sessionTarget: { sessionKey: internalKey, sessionId: internalId, storePath },
              workspaceDir: "/tmp/workspace",
              timeoutMs: 1000,
            }),
          createEmptyPluginRegistry(),
        ),
      ).rejects.toThrow(/exact session target identity/);
      expect(runCore).toHaveBeenCalledOnce();
    });
  });
});
