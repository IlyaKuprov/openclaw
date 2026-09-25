import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

describe("plugin registry SQLite session ownership", () => {
  it("rejects a queued upsert after its plugin runtime is revoked", async () => {
    await withTempHome(async () => {
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:revoked-child";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      try {
        const runtime = createPluginRuntime();
        const originalPatch = runtime.agent.session.patchSessionEntry;
        const registry = createRuntimeTestRegistry(runtime);
        const record = createPluginRecord({
          id: "other-plugin",
          source: "/plugins/other-plugin/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const api = registry.createApi(record, { config: {} as OpenClawConfig });
        Object.defineProperty(runtime.agent.session, "patchSessionEntry", {
          configurable: true,
          value: async (params: Parameters<typeof originalPatch>[0]) => {
            registry.registry.plugins.splice(registry.registry.plugins.indexOf(record), 1);
            return await originalPatch(params);
          },
        });
        await expect(
          api.runtime.agent.session.upsertSessionEntry({
            agentId,
            sessionKey,
            storePath,
            entry: { sessionId: "revoked", pluginOwnerId: "other-plugin", updatedAt: 1 },
          }),
        ).rejects.toThrow(/runtime is no longer active/);
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })).toBeUndefined();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("does not let a foreign plugin forge a new internal child's ownership proof", async () => {
    await withTempHome(async () => {
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:review-6:active-memory:recall-6";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      try {
        const registry = createRuntimeTestRegistry(createPluginRuntime());
        const otherApi = registry.createApi(
          createPluginRecord({
            id: "other-plugin",
            source: "/plugins/other-plugin/index.js",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} as OpenClawConfig },
        );
        await expect(
          otherApi.runtime.agent.session.upsertSessionEntry({
            agentId,
            sessionKey,
            storePath,
            entry: { sessionId: "forged-child", pluginOwnerId: "active-memory", updatedAt: 1 },
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })).toBeUndefined();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("does not let a foreign plugin claim an owned internal child through a folded alias", async () => {
    await withTempHome(async () => {
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:review-5:active-memory:recall-5";
      const aliasKey = "INTERNAL-SESSION-EFFECTS:review-5:active-memory:recall-5";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      const owner = {
        sessionId: "owned-alias-child",
        pluginOwnerId: "active-memory",
        updatedAt: 1,
      };
      try {
        await replaceSessionEntry({ agentId, sessionKey, storePath }, owner);
        const registry = createRuntimeTestRegistry(createPluginRuntime());
        const otherApi = registry.createApi(
          createPluginRecord({
            id: "other-plugin",
            source: "/plugins/other-plugin/index.js",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} as OpenClawConfig },
        );
        await expect(
          otherApi.runtime.agent.session.patchSessionEntry({
            agentId,
            sessionKey: aliasKey,
            storePath,
            update: () => ({ label: "foreign alias mutation" }),
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        await expect(
          otherApi.runtime.agent.session.upsertSessionEntry({
            agentId,
            sessionKey: aliasKey,
            storePath,
            entry: { ...owner, pluginOwnerId: "other-plugin" },
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        await expect(
          otherApi.runtime.agent.session.upsertSessionEntry({
            agentId,
            sessionKey: sessionKey.toUpperCase(),
            storePath,
            entry: { ...owner, pluginOwnerId: "other-plugin" },
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })).toMatchObject(owner);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("does not update an internal child created after a foreign store pre-read", async () => {
    await withTempHome(async () => {
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:review-4:active-memory:recall-4";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      const owner = {
        sessionId: "owned-store-child",
        pluginOwnerId: "active-memory",
        updatedAt: 1,
      };
      try {
        const runtime = createPluginRuntime();
        const originalUpdate = runtime.agent.session.updateSessionStoreEntry;
        Object.defineProperty(runtime.agent.session, "updateSessionStoreEntry", {
          configurable: true,
          value: async (params: Parameters<typeof originalUpdate>[0]) => {
            await replaceSessionEntry({ agentId, sessionKey, storePath }, owner);
            return await originalUpdate(params);
          },
        });
        const registry = createRuntimeTestRegistry(runtime);
        const otherApi = registry.createApi(
          createPluginRecord({
            id: "other-plugin",
            source: "/plugins/other-plugin/index.js",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} as OpenClawConfig },
        );
        await expect(
          otherApi.runtime.agent.session.updateSessionStoreEntry({
            sessionKey,
            storePath,
            update: () => ({ label: "foreign store mutation" }),
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })).toMatchObject(owner);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("does not patch an internal child created after a foreign plugin's pre-read", async () => {
    await withTempHome(async () => {
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:review-3:active-memory:recall-3";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      const owner = {
        sessionId: "owned-patch-child",
        pluginOwnerId: "active-memory",
        updatedAt: 1,
      };
      try {
        const runtime = createPluginRuntime();
        const originalPatch = runtime.agent.session.patchSessionEntry;
        Object.defineProperty(runtime.agent.session, "patchSessionEntry", {
          configurable: true,
          value: async (params: Parameters<typeof originalPatch>[0]) => {
            await replaceSessionEntry({ agentId, sessionKey, storePath }, owner);
            return await originalPatch(params);
          },
        });
        const registry = createRuntimeTestRegistry(runtime);
        const otherApi = registry.createApi(
          createPluginRecord({
            id: "other-plugin",
            source: "/plugins/other-plugin/index.js",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} as OpenClawConfig },
        );
        await expect(
          otherApi.runtime.agent.session.patchSessionEntry({
            agentId,
            sessionKey,
            storePath,
            update: () => ({ label: "foreign mutation" }),
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })).toMatchObject(owner);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("does not let a foreign upsert replace an internal child created after its pre-read", async () => {
    await withTempHome(async () => {
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:review-2:active-memory:recall-2";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      const owner = { sessionId: "owned-child", pluginOwnerId: "active-memory", updatedAt: 1 };
      const foreign = { sessionId: "foreign-child", pluginOwnerId: "other-plugin", updatedAt: 2 };
      try {
        const runtime = createPluginRuntime();
        const originalUpsert = runtime.agent.session.upsertSessionEntry;
        const originalPatch = runtime.agent.session.patchSessionEntry;
        let inserted = false;
        const seedOwner = async () => {
          if (!inserted) {
            inserted = true;
            await replaceSessionEntry({ agentId, sessionKey, storePath }, owner);
          }
        };
        Object.defineProperty(runtime.agent.session, "upsertSessionEntry", {
          configurable: true,
          value: async (params: Parameters<typeof originalUpsert>[0]) => {
            await seedOwner();
            return await originalUpsert(params);
          },
        });
        Object.defineProperty(runtime.agent.session, "patchSessionEntry", {
          configurable: true,
          value: async (params: Parameters<typeof originalPatch>[0]) => {
            await seedOwner();
            return await originalPatch(params);
          },
        });
        const registry = createRuntimeTestRegistry(runtime);
        const otherApi = registry.createApi(
          createPluginRecord({
            id: "other-plugin",
            source: "/plugins/other-plugin/index.js",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} as OpenClawConfig },
        );
        await expect(
          otherApi.runtime.agent.session.upsertSessionEntry({
            agentId,
            sessionKey,
            storePath,
            entry: foreign,
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })).toMatchObject(owner);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("admits a plugin-owned recall child under a hidden internal-effects parent", async () => {
    await withTempHome(async (home) => {
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:review-1:active-memory:recall-1";
      const sessionId = "active-memory-test-recall";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      const sessionFile = formatSqliteSessionFileMarker({ agentId, sessionId, storePath });
      try {
        await replaceSessionEntry(
          { agentId, sessionKey, storePath },
          { sessionId, sessionFile, pluginOwnerId: "active-memory", updatedAt: 1 },
        );
        expect(listSessionEntriesReadOnly({ agentId, storePath })).toEqual([]);
        expect(loadSessionEntryReadOnly({ agentId, sessionKey, storePath })?.sessionId).toBe(
          sessionId,
        );
        const runtime = createPluginRuntime();
        const runEmbeddedAgent = vi.fn(async () => ({
          ok: true,
        })) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
        Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
          configurable: true,
          value: runEmbeddedAgent,
        });
        const registry = createRuntimeTestRegistry(runtime);
        const api = registry.createApi(
          createPluginRecord({
            id: "active-memory",
            source: "/plugins/active-memory/index.js",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} as OpenClawConfig },
        );
        const target = { agentId, sessionKey, sessionId, storePath };
        const params = {
          ...target,
          sessionTarget: target,
          sessionFile,
          workspaceDir: path.join(home, "workspace"),
          prompt: "recall",
          timeoutMs: 1000,
          runId: sessionId,
        } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
        await expect(api.runtime.agent.runEmbeddedAgent(params)).resolves.toEqual({ ok: true });
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        const otherApi = registry.createApi(
          createPluginRecord({
            id: "other-plugin",
            source: "/plugins/other-plugin/index.js",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} as OpenClawConfig },
        );
        await expect(
          otherApi.runtime.agent.session.patchSessionEntry({
            agentId,
            sessionKey,
            storePath,
            update: () => ({ pluginOwnerId: "other-plugin" }),
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        await expect(
          otherApi.runtime.agent.session.upsertSessionEntry({
            agentId,
            sessionKey,
            storePath,
            entry: { sessionId, sessionFile, pluginOwnerId: "other-plugin", updatedAt: 2 },
          }),
        ).rejects.toThrow('owned by plugin "active-memory"');
        await expect(
          api.runtime.agent.session.patchSessionEntry({
            agentId,
            sessionKey,
            storePath,
            update: () => ({ pluginOwnerId: undefined }),
          }),
        ).rejects.toThrow("cannot change the owner of an internal session");
        await expect(otherApi.runtime.agent.runEmbeddedAgent(params)).rejects.toThrow(
          'owned by plugin "active-memory"',
        );
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        await expect(
          api.runtime.agent.runEmbeddedAgent({
            ...params,
            sessionFile: formatSqliteSessionFileMarker({
              agentId,
              sessionId: "not-the-recall-session",
              storePath,
            }),
          }),
        ).rejects.toThrow("only with its exact session target identity");
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("does not read runtime config before a logical session requires it", () => {
    const runtime = createPluginRuntime();
    const readConfig = vi.fn(() => {
      throw new Error("runtime config was accessed eagerly");
    });
    Object.defineProperty(runtime, "config", { configurable: true, get: readConfig });

    expect(() => createRuntimeTestRegistry(runtime)).not.toThrow();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("resolves unscoped worker keys through the configured default agent", async () => {
    await withTempHome(async () => {
      const config = {
        agents: { list: [{ id: "researcher", default: true }] },
      } as OpenClawConfig;
      const subagent = {
        complete: vi.fn(async () => ({ text: "completed" })),
        run: vi.fn(async () => ({ runId: "workboard-run" })),
        waitForRun: vi.fn(async () => ({ status: "ok" as const })),
        getSessionMessages: vi.fn(async () => ({ messages: [] })),
        deleteSession: vi.fn(async () => {}),
      } satisfies PluginRuntime["subagent"];
      const runtime = createPluginRuntime({ subagent });
      let runtimeConfig = config;
      runtime.config = { ...runtime.config, current: () => runtimeConfig };
      const pluginRegistry = createRuntimeTestRegistry(runtime);
      const record = createPluginRecord({
        id: "workboard",
        source: "/plugins/workboard/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const api = pluginRegistry.createApi(record, { config });
      const ownerRecord = createPluginRecord({
        id: "harness-owner",
        source: "/plugins/harness-owner/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const ownerApi = pluginRegistry.createApi(ownerRecord, { config });
      ownerApi.registerAgentHarness({
        id: "test-harness",
        label: "Test Harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused");
        },
      });

      try {
        const sessionKey = "subagent:workboard-default-unassigned";
        await expect(api.runtime.subagent.run({ sessionKey, message: "start" })).resolves.toEqual({
          runId: "workboard-run",
        });
        expect(subagent.run).toHaveBeenCalledWith({ sessionKey, message: "start" });

        for (const invalidSessionKey of ["agent::malformed", "global", "unknown"]) {
          await expect(
            api.runtime.subagent.run({ sessionKey: invalidSessionKey, message: "reject" }),
          ).rejects.toThrow("Cannot resolve SQLite session scope without an agent id");
        }

        const lockedSessionKey = "harness:test-harness:owned";
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey: `agent:researcher:${lockedSessionKey}` },
          {
            sessionId: "owned-session",
            updatedAt: 1,
            agentHarnessId: "test-harness",
            modelSelectionLocked: true,
          },
        );
        await expect(
          api.runtime.subagent.run({ sessionKey: lockedSessionKey, message: "continue" }),
        ).rejects.toThrow('owned by plugin "harness-owner"');
        expect(subagent.run).toHaveBeenCalledOnce();

        await replaceSessionEntry(
          { agentId: "replacement", sessionKey: `agent:replacement:${sessionKey}` },
          {
            sessionId: "replacement-owned-session",
            updatedAt: 2,
            agentHarnessId: "test-harness",
            modelSelectionLocked: true,
          },
        );
        const pending = api.runtime.subagent.run({ sessionKey, message: "continue" });
        runtimeConfig = { agents: { list: [{ id: "replacement", default: true }] } };
        await expect(pending).rejects.toThrow('owned by plugin "harness-owner"');
        expect(subagent.run).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("keeps embedded incognito ID scans in the key's agent store", async () => {
    await withTempHome(async (home) => {
      const sessionKey = "agent:researcher:dashboard:incognito-ownership-check";
      const sessionId = "incognito-session";
      const lockedKey = "agent:researcher:dashboard:incognito-locked-owner";
      const lockedSessionId = "locked-incognito-session";
      try {
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey },
          { sessionId, updatedAt: 1 },
        );
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey: lockedKey },
          {
            sessionId: lockedSessionId,
            updatedAt: 2,
            agentHarnessId: "test-harness",
            modelSelectionLocked: true,
          },
        );

        const runtime = createPluginRuntime();
        const runEmbeddedAgent = vi.fn(async () => ({
          ok: true,
        })) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
        Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
          configurable: true,
          value: runEmbeddedAgent,
        });
        const pluginRegistry = createRuntimeTestRegistry(runtime);
        const ownerRecord = createPluginRecord({
          id: "harness-owner",
          source: "/plugins/harness-owner/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const callerRecord = createPluginRecord({
          id: "extractor-plugin",
          source: "/plugins/extractor-plugin/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const ownerApi = pluginRegistry.createApi(ownerRecord, { config: {} as OpenClawConfig });
        const callerApi = pluginRegistry.createApi(callerRecord, {
          config: {} as OpenClawConfig,
        });
        ownerApi.registerAgentHarness({
          id: "test-harness",
          label: "Test Harness",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused");
          },
        });
        const runParams = {
          sessionId,
          sessionKey,
          workspaceDir: path.join(home, "workspace"),
          prompt: "continue",
          timeoutMs: 1,
          runId: "run-1",
        } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

        await expect(callerApi.runtime.agent.runEmbeddedAgent(runParams)).resolves.toEqual({
          ok: true,
        });
        await expect(
          callerApi.runtime.agent.runEmbeddedAgent({ ...runParams, agentId: "main" }),
        ).rejects.toThrow('does not match session key agent "researcher"');
        await expect(
          callerApi.runtime.agent.runEmbeddedAgent({
            ...runParams,
            sessionId: lockedSessionId,
          }),
        ).rejects.toThrow('owned by plugin "harness-owner"');
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });
});
