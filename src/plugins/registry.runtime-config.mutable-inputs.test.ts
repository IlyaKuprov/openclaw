import { describe, expect, it } from "vitest";
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

function createActiveMemorySessionApi() {
  const registry = createRuntimeTestRegistry(createPluginRuntime());
  return registry.createApi(
    createPluginRecord({
      id: "active-memory",
      source: "/plugins/active-memory/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    }),
    { config: {} as OpenClawConfig },
  );
}

function internalScope(suffix: string) {
  const agentId = "main";
  return {
    agentId,
    sessionKey: `agent:main:internal-session-effects:${suffix}`,
    storePath: resolveSessionStorePathCore(undefined, { agentId }),
  };
}

describe("plugin-scoped session writes with mutable caller input", () => {
  it("creates an internal row from the fallback owner that passed validation", async () => {
    await withTempHome(async () => {
      const scope = internalScope("fallback-getter");
      try {
        const api = createActiveMemorySessionApi();
        let ownerReads = 0;
        const fallbackEntry = {
          sessionId: "new-child",
          updatedAt: 1,
          get pluginOwnerId() {
            ownerReads += 1;
            return ownerReads === 1 ? "active-memory" : "other-plugin";
          },
        };
        await api.runtime.agent.session.patchSessionEntry({
          ...scope,
          fallbackEntry,
          update: (entry) => entry,
        });
        expect(loadSessionEntryReadOnly(scope)).toMatchObject({
          sessionId: "new-child",
          pluginOwnerId: "active-memory",
        });
        expect(ownerReads).toBe(1);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("checks the persisted fallback session ID rather than a mutated callback clone", async () => {
    await withTempHome(async () => {
      const scope = internalScope("callback-fallback-window");
      const foreign = internalScope("foreign-window-owner");
      const victim = { sessionId: "shared-window", pluginOwnerId: "other-plugin", updatedAt: 1 };
      try {
        await replaceSessionEntry(foreign, victim);
        const api = createActiveMemorySessionApi();
        await expect(
          api.runtime.agent.session.patchSessionEntry({
            ...scope,
            fallbackEntry: {
              sessionId: victim.sessionId,
              pluginOwnerId: "active-memory",
              updatedAt: 2,
            },
            update: (entry) => {
              entry.sessionId = "safe-looking-window";
              return { label: "only a label patch" };
            },
          }),
        ).rejects.toThrow(/other-plugin|owned|internal session/i);
        expect(loadSessionEntryReadOnly(foreign)).toMatchObject(victim);
        expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("upserts the same materialized owner that passed the internal-row check", async () => {
    await withTempHome(async () => {
      const scope = internalScope("entry-getter");
      try {
        const api = createActiveMemorySessionApi();
        let ownerReads = 0;
        const entry = {
          sessionId: "new-child",
          updatedAt: 2,
          get pluginOwnerId() {
            ownerReads += 1;
            return ownerReads <= 2 ? "active-memory" : "other-plugin";
          },
        };
        await api.runtime.agent.session.upsertSessionEntry({ ...scope, entry });
        expect(loadSessionEntryReadOnly(scope)).toMatchObject({
          sessionId: "new-child",
          pluginOwnerId: "active-memory",
        });
        expect(ownerReads).toBe(1);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("checks the captured replacement mode even when the caller toggles it during update", async () => {
    await withTempHome(async () => {
      const scope = internalScope("replace-toggle");
      const original = {
        sessionId: "owned-child",
        pluginOwnerId: "active-memory",
        updatedAt: 1,
      };
      try {
        await replaceSessionEntry(scope, original);
        const api = createActiveMemorySessionApi();
        const params = {
          ...scope,
          replaceEntry: true,
          update: async () => {
            params.replaceEntry = false;
            return { sessionId: "owned-child", updatedAt: 2 };
          },
        };
        await expect(api.runtime.agent.session.patchSessionEntry(params)).rejects.toThrow(
          /cannot change the owner|requires its plugin owner/i,
        );
        expect(loadSessionEntryReadOnly(scope)).toMatchObject(original);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it.each(["patch", "update" as const])(
    "persists the same %s callback patch owner that passed the internal-row check",
    async (method) => {
      await withTempHome(async () => {
        const scope = internalScope(`callback-${method}`);
        const original = {
          sessionId: "owned-child",
          pluginOwnerId: "active-memory",
          updatedAt: 1,
        };
        try {
          await replaceSessionEntry(scope, original);
          const api = createActiveMemorySessionApi();
          let ownerReads = 0;
          const update = () => ({
            sessionId: "owned-child",
            updatedAt: 2,
            get pluginOwnerId() {
              ownerReads += 1;
              return ownerReads === 1 ? "active-memory" : "other-plugin";
            },
          });
          if (method === "patch") {
            await api.runtime.agent.session.patchSessionEntry({
              ...scope,
              replaceEntry: true,
              update,
            });
          } else {
            await api.runtime.agent.session.updateSessionStoreEntry({
              sessionKey: scope.sessionKey,
              storePath: scope.storePath,
              update,
            });
          }
          expect(loadSessionEntryReadOnly(scope)?.pluginOwnerId).toBe("active-memory");
          expect(ownerReads).toBe(1);
        } finally {
          closeOpenClawAgentDatabasesForTest();
        }
      });
    },
  );
});
