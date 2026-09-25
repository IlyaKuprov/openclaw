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
    const ownerEntry = { sessionId: "owned-child", updatedAt: 1, pluginOwnerId: "active-memory" };
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
      await expect(sdk.cleanupSessionLifecycleArtifacts(cleanup)).rejects.toThrow(
        /Cleaning internal sessions requires scoped plugin runtime/,
      );
    });
    expect(readStoredEntry(scope)).toMatchObject({
      sessionId: ownerEntry.sessionId,
      pluginOwnerId: ownerEntry.pluginOwnerId,
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
    await expect(
      foreignApi.runtime.agent.session.cleanupSessionLifecycleArtifacts({
        ...cleanup,
        pluginOwnerId: "active-memory",
      }),
    ).resolves.toMatchObject({ removedEntries: 0 });
    expect(readStoredEntry(scope)?.pluginOwnerId).toBe("active-memory");
    await expect(
      ownerApi.runtime.agent.session.cleanupSessionLifecycleArtifacts(cleanup),
    ).resolves.toMatchObject({ removedEntries: 1 });
    expect(readStoredEntry(scope)).toBeUndefined();
  });
});
