import { describe, expect, it, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  loadExactSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "../loader-records.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createRuntimeTestRegistry } from "../registry-runtime.test-helpers.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createPluginRuntime } from "./index.js";

const importGate = vi.hoisted(() => {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    release: () => release(),
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
  };
});
const runCore = vi.hoisted(() => vi.fn(async () => ({ payloads: [] })));
vi.mock("./runtime-embedded-agent.runtime.js", async (importOriginal) => {
  importGate.enter();
  await importGate.waiting;
  return await importOriginal<typeof import("./runtime-embedded-agent.runtime.js")>();
});
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runCore }));

describe("plugin embedded-agent lazy import ownership", () => {
  it("rejects a foreign replacement with the same key, session ID, and spoofed owner after the import begins", async () => {
    await withOpenClawTestState({ label: "plugin-embedded-owner-lazy" }, async () => {
      const runtime = createPluginRuntime();
      const registry = createEmptyPluginRegistry();
      const sessionKey = "agent:main:telegram:direct:owner:active-memory:recall";
      const sessionId = "active-memory-child";
      const agentId = "main";
      const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
      const scope = { agentId, sessionKey, storePath };
      const create = async (pluginOwnerId: string) =>
        await runtime.agent.session.patchSessionEntry({
          ...scope,
          fallbackEntry: { sessionId, pluginOwnerId, updatedAt: 1234 },
          replaceEntry: true,
          skipMaintenance: true,
          update: (entry, context) => (context.existingEntry ? null : { ...entry, pluginOwnerId }),
        });
      expect((await create("active-memory"))?.sessionId).toBe(sessionId);
      const ownEntry = loadExactSessionEntryReadOnly(scope)?.entry;
      const runParams = {
        config: {},
        prompt: "search memory",
        runId: sessionId,
        sessionId,
        sessionKey,
        agentId,
        sessionTarget: { ...scope, sessionId },
        workspaceDir: "/tmp/workspace",
        timeoutMs: 1000,
      };
      const pending = withPluginRuntimePluginScope(
        { pluginId: "active-memory" },
        () => runtime.agent.runEmbeddedAgent(runParams),
        registry,
      );
      await importGate.entered;
      expect(runCore).not.toHaveBeenCalled();
      const deleted = await deleteSessionEntryLifecycle({
        agentId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expect(deleted.deleted).toBe(true);
      // The replacement was written by another plugin. Even copying the old
      // pluginOwnerId and every visible entry field cannot restore the old run.
      expect(
        (
          await withPluginRuntimePluginScope(
            { pluginId: "foreign-plugin" },
            () => create("active-memory"),
            registry,
          )
        )?.sessionId,
      ).toBe(sessionId);
      expect(loadExactSessionEntryReadOnly(scope)?.entry).toEqual(ownEntry);
      importGate.release();
      await expect(pending).rejects.toThrow(/owner|session/i);
      expect(runCore).not.toHaveBeenCalled();

      // The same registered runtime must still run an actively owned child.
      await deleteSessionEntryLifecycle({
        agentId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expect((await create("active-memory"))?.sessionId).toBe(sessionId);
      await expect(
        withPluginRuntimePluginScope(
          { pluginId: "active-memory" },
          () => runtime.agent.runEmbeddedAgent(runParams),
          registry,
        ),
      ).resolves.toEqual({ payloads: [] });
      expect(runCore).toHaveBeenCalledOnce();

      await deleteSessionEntryLifecycle({
        agentId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      await withPluginRuntimePluginScope(
        { pluginId: "foreign-plugin" },
        () => create("foreign-plugin"),
        registry,
      );
      await expect(
        withPluginRuntimePluginScope(
          { pluginId: "active-memory" },
          () => runtime.agent.runEmbeddedAgent(runParams),
          registry,
        ),
      ).rejects.toThrow(/owner/i);
      expect(runCore).toHaveBeenCalledOnce();
    });
  });

  it("revokes a registered plugin run that was admitted before an awaited runner handoff", async () => {
    await withOpenClawTestState({ label: "plugin-embedded-record-revocation" }, async () => {
      runCore.mockClear();
      const runtime = createPluginRuntime();
      const sessionKey = "agent:main:internal-session-effects:active-memory:recall-revoked";
      const agentId = "main";
      const sessionId = "revoked-recall";
      const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
      const scope = { agentId, sessionKey, storePath };
      await runtime.agent.session.patchSessionEntry({
        ...scope,
        fallbackEntry: { sessionId, pluginOwnerId: "active-memory", updatedAt: 1 },
        update: (entry) => entry,
      });
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const waiting = new Promise<void>((resolve) => (release = resolve));
      const originalRun = runtime.agent.runEmbeddedAgent;
      Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
        configurable: true,
        value: async (params: Parameters<typeof originalRun>[0]) => {
          enter();
          await waiting;
          return await originalRun(params);
        },
      });
      const registry = createRuntimeTestRegistry(runtime);
      const record = createPluginRecord({
        id: "active-memory",
        source: "/plugins/active-memory/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const api = registry.createApi(record, { config: {} as OpenClawConfig });
      const pending = api.runtime.agent.runEmbeddedAgent({
        config: {},
        prompt: "recall",
        runId: sessionId,
        sessionId,
        sessionKey,
        agentId,
        sessionTarget: { ...scope, sessionId },
        workspaceDir: "/tmp/workspace",
        timeoutMs: 1000,
      });
      await entered;
      registry.registry.plugins.splice(registry.registry.plugins.indexOf(record), 1);
      release();
      await expect(pending).rejects.toThrow(/runtime is no longer active/);
      expect(runCore).not.toHaveBeenCalled();
    });
  });
});
