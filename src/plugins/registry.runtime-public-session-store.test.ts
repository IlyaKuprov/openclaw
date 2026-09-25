// Exercise an executing plugin's public SDK import, not a core session helper.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionEntry as readStoredEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createPluginRecord } from "./loader-records.js";
import { PluginInstance } from "./plugin-instance.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";

describe("public plugin session-store writers", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cannot replace another plugin's internal-effects owner via the public SDK", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sdk-owner-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:internal-session-effects:owner-child";
    const scope = { agentId: "main", sessionKey, storePath };
    const ownerEntry = {
      sessionId: "owned-child",
      updatedAt: 1,
      pluginOwnerId: "active-memory",
      pluginExtensions: { fixture: { state: { active: true } } },
    };
    await upsertSessionEntryCore(scope, ownerEntry);
    const pluginRegistry = createRuntimeTestRegistry(createPluginRuntime());
    const { registry } = pluginRegistry;
    const record = createPluginRecord({
      id: "other-plugin",
      source: "/plugins/other-plugin/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    registry.plugins.push(record);
    const foreignPlugin = new PluginInstance(record.id, { record, registry });
    const cleanup = {
      agentId: "main",
      storePath,
      sessionKeySegmentPrefix: "internal-session-effects",
      transcriptContentMarker: '"nonexistent-marker"',
      orphanTranscriptMinAgeMs: 0,
    };

    await foreignPlugin.run(async () => {
      const sdk = await import("./fixtures/public-session-store-plugin.js");
      expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe("other-plugin");
      await expect(
        sdk.patchSessionEntry({
          ...scope,
          update: () => ({ pluginOwnerId: "other-plugin" }),
        }),
      ).rejects.toThrow(/internal session.*scoped plugin runtime/i);
      await expect(
        sdk.upsertSessionEntry({
          ...scope,
          entry: { ...ownerEntry, pluginOwnerId: "other-plugin" },
        }),
      ).rejects.toThrow(/internal session.*scoped plugin runtime/i);
      await expect(
        sdk.updateSessionStoreEntry({
          ...scope,
          update: () => ({ pluginOwnerId: "other-plugin" }),
        }),
      ).rejects.toThrow(/internal session.*scoped plugin runtime/i);
      await expect(sdk.deleteSessionEntry(scope)).rejects.toThrow(
        /internal session.*scoped plugin runtime/i,
      );
      await expect(
        sdk.updateSessionStore(storePath, (store) => {
          store[sessionKey] = { ...ownerEntry, pluginOwnerId: "other-plugin" };
        }),
      ).rejects.toThrow(/internal session.*scoped plugin runtime/i);
      await expect(
        sdk.updateSessionStore(storePath, (store) => {
          const entry = store[sessionKey];
          if (!entry) {
            throw new Error("expected owned session fixture");
          }
          const extensions = entry.pluginExtensions as {
            fixture: { state: { active: boolean } };
          };
          extensions.fixture.state.active = false;
        }),
      ).rejects.toThrow(/internal session.*scoped plugin runtime/i);
      await expect(sdk.cleanupSessionLifecycleArtifacts(cleanup)).rejects.toThrow(
        /Cleaning internal sessions requires scoped plugin runtime/,
      );
    });
    expect(readStoredEntry(scope)).toMatchObject({
      sessionId: ownerEntry.sessionId,
      pluginOwnerId: ownerEntry.pluginOwnerId,
      pluginExtensions: ownerEntry.pluginExtensions,
    });

    const ownerRecord = createPluginRecord({
      id: "active-memory",
      source: "/plugins/active-memory/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const ownerApi = pluginRegistry.createApi(ownerRecord, { config: {} });
    await expect(
      ownerApi.runtime.agent.session.patchSessionEntry({
        ...scope,
        update: () => ({ label: "owner can still write" }),
      }),
    ).resolves.toMatchObject({ pluginOwnerId: "active-memory", label: "owner can still write" });
    expect(readStoredEntry(scope)).toMatchObject({
      sessionId: ownerEntry.sessionId,
      pluginOwnerId: ownerEntry.pluginOwnerId,
      label: "owner can still write",
    });
    const foreignApi = pluginRegistry.createApi(record, { config: {} });
    const foreignCleanup = foreignApi.runtime.agent.session.cleanupSessionLifecycleArtifacts;
    const ownerCleanup = ownerApi.runtime.agent.session.cleanupSessionLifecycleArtifacts;
    if (!foreignCleanup || !ownerCleanup) {
      throw new Error("test runtime must provide lifecycle cleanup");
    }
    const coreScope = {
      ...scope,
      sessionKey: "agent:main:internal-session-effects:core-hidden",
    };
    await upsertSessionEntryCore(coreScope, { sessionId: "core-hidden", updatedAt: 1 });
    await expect(
      foreignCleanup({
        ...cleanup,
        pluginOwnerId: "active-memory",
      }),
    ).resolves.toMatchObject({ removedEntries: 0 });
    expect(readStoredEntry(scope)?.pluginOwnerId).toBe("active-memory");
    expect(readStoredEntry(coreScope)?.sessionId).toBe("core-hidden");
    await expect(ownerCleanup(cleanup)).resolves.toMatchObject({ removedEntries: 1 });
    expect(readStoredEntry(scope)).toBeUndefined();
    expect(readStoredEntry(coreScope)?.sessionId).toBe("core-hidden");
  });

  it("does not clean an owned session after its plugin runtime is revoked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-cleanup-revoked-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:internal-session-effects:owned-child",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "owned-child",
      pluginOwnerId: "active-memory",
      updatedAt: 1,
    });
    const runtime = createPluginRuntime();
    const originalCleanup = runtime.agent.session.cleanupSessionLifecycleArtifacts;
    if (!originalCleanup) {
      throw new Error("test runtime must provide lifecycle cleanup");
    }
    const registry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "active-memory",
      source: "/plugins/active-memory/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = registry.createApi(record, { config: {} });
    Object.defineProperty(runtime.agent.session, "cleanupSessionLifecycleArtifacts", {
      configurable: true,
      value: async (params: Parameters<typeof originalCleanup>[0]) => {
        registry.registry.plugins.splice(registry.registry.plugins.indexOf(record), 1);
        return await originalCleanup(params);
      },
    });
    const cleanup = api.runtime.agent.session.cleanupSessionLifecycleArtifacts;
    if (!cleanup) {
      throw new Error("test runtime must provide lifecycle cleanup");
    }
    await expect(
      cleanup({
        agentId: "main",
        storePath,
        sessionKeySegmentPrefix: "internal-session-effects",
        transcriptContentMarker: '"nonexistent-marker"',
        orphanTranscriptMinAgeMs: 0,
      }),
    ).rejects.toThrow(/runtime is no longer active/);
    expect(readStoredEntry(scope)?.pluginOwnerId).toBe("active-memory");
  });

  it("does not advertise lifecycle cleanup when an external runtime adapter lacks it", () => {
    const runtime = createPluginRuntime();
    delete runtime.agent.session.cleanupSessionLifecycleArtifacts;
    const pluginRegistry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "active-memory",
      source: "/plugins/active-memory/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} });
    expect(api.runtime.agent.session.cleanupSessionLifecycleArtifacts).toBeUndefined();
  });
});
