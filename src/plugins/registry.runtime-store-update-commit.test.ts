import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";

describe("plugin registry SQLite store-update commit authority", () => {
  it.each(["disabled", "replaced"] as const)(
    "rejects a store update when its plugin is %s after callback but before SQLite commit",
    async (change) => {
      await withTempHome(async (home) => {
        const agentId = "main";
        const sessionKey = "agent:main:internal-session-effects:store-commit-child";
        const storePath = resolveSessionStorePathCore(undefined, { agentId });
        const scope = { agentId, sessionKey, storePath };
        const otherStore = { ...scope, storePath: path.join(home, "other-sessions.sqlite") };
        const original = {
          sessionId: "owned-child",
          pluginOwnerId: "active-memory",
          updatedAt: 1,
          label: "before",
        };
        try {
          await replaceSessionEntry(scope, original);
          await replaceSessionEntry(otherStore, original);
          const runtime = createPluginRuntime();
          const originalUpdate = runtime.agent.session.updateSessionStoreEntry;
          const registry = createRuntimeTestRegistry(runtime);
          const recordParams = {
            id: "active-memory",
            source: "/plugins/active-memory/index.js",
            origin: "bundled" as const,
            enabled: true,
            configSchema: false,
          };
          const record = createPluginRecord(recordParams);
          const api = registry.createApi(record, { config: {} as OpenClawConfig });
          let callbackFinished = false;
          Object.defineProperty(runtime.agent.session, "updateSessionStoreEntry", {
            configurable: true,
            value: (params: Parameters<typeof originalUpdate>[0]) =>
              originalUpdate({
                ...params,
                update: async (entry) => {
                  const patch = await params.update(entry);
                  callbackFinished = true;
                  if (change === "replaced") {
                    registry.registry.plugins.splice(registry.registry.plugins.indexOf(record), 1);
                    registry.createApi(createPluginRecord(recordParams), {
                      config: {} as OpenClawConfig,
                    });
                  } else {
                    record.enabled = false;
                    record.status = "disabled";
                  }
                  return patch;
                },
              }),
          });
          const callerGuard = vi.fn();
          await expect(
            api.runtime.agent.session.updateSessionStoreEntry({
              sessionKey,
              storePath,
              assertCommitAllowed: callerGuard,
              update: () => ({ label: "stale", pluginOwnerId: "active-memory" }),
            }),
          ).rejects.toThrow(/runtime is no longer active/);
          expect(callbackFinished).toBe(true);
          expect(callerGuard).not.toHaveBeenCalled();
          expect(loadSessionEntryReadOnly(scope)).toMatchObject(original);
          expect(loadSessionEntryReadOnly(otherStore)).toMatchObject(original);
        } finally {
          closeOpenClawAgentDatabasesForTest();
        }
      });
    },
  );

  it("combines the store-update caller guard with the live runtime guard", async () => {
    await withTempHome(async () => {
      const scope = {
        sessionKey: "agent:main:internal-session-effects:store-caller-guard",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const original = { sessionId: "owned", pluginOwnerId: "active-memory", updatedAt: 1 };
      try {
        await replaceSessionEntry({ ...scope, agentId: "main" }, original);
        const registry = createRuntimeTestRegistry(createPluginRuntime());
        const record = createPluginRecord({
          id: "active-memory",
          source: "/plugins/active-memory/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        });
        const api = registry.createApi(record, { config: {} as OpenClawConfig });
        let allowed = false;
        const guard = vi.fn(() => {
          if (!allowed) {
            throw new Error("caller denied commit");
          }
        });
        const update = () =>
          api.runtime.agent.session.updateSessionStoreEntry({
            ...scope,
            assertCommitAllowed: guard,
            update: () => ({ label: "written" }),
          });
        await expect(update()).rejects.toThrow("caller denied commit");
        expect(loadSessionEntryReadOnly(scope)).toMatchObject(original);
        allowed = true;
        await expect(update()).resolves.toMatchObject({
          sessionId: original.sessionId,
          pluginOwnerId: original.pluginOwnerId,
          label: "written",
        });
        expect(guard).toHaveBeenCalledTimes(2);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });
});
