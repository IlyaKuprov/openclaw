import { describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveSessionOwnershipBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";

describe("plugin scoped session window ownership", () => {
  it.each(["upsert", "patch"] as const)(
    "rejects %s of an ordinary key using a foreign internal window ID",
    async (method) => {
      await withTempHome(async () => {
        const agentId = "main";
        const storePath = resolveSessionStorePathCore(undefined, { agentId });
        const sessionId = "foreign-hidden-window";
        const victim = {
          agentId,
          storePath,
          sessionKey: "agent:main:internal-session-effects:foreign-hidden-window",
        };
        const ordinary = {
          agentId,
          storePath,
          sessionKey: `agent:main:telegram:direct:foreign-window-${method}`,
        };
        const ownerEntry = { sessionId, pluginOwnerId: "active-memory", updatedAt: 1 };
        try {
          await replaceSessionEntry(victim, ownerEntry);
          const registry = createRuntimeTestRegistry(createPluginRuntime());
          const api = registry.createApi(
            createPluginRecord({
              id: "other-plugin",
              source: "/plugins/other-plugin/index.js",
              origin: "bundled",
              enabled: true,
              configSchema: false,
            }),
            { config: {} as OpenClawConfig },
          );
          const write =
            method === "upsert"
              ? api.runtime.agent.session.upsertSessionEntry({
                  ...ordinary,
                  entry: { sessionId, updatedAt: 2 },
                })
              : api.runtime.agent.session.patchSessionEntry({
                  ...ordinary,
                  fallbackEntry: { sessionId, updatedAt: 2 },
                  update: (entry) => entry,
                });
          await expect(write).rejects.toThrow(/active-memory|owned|internal session/i);
          expect(resolveSessionOwnershipBySessionId({ agentId, storePath, sessionId })).toEqual({
            sessionKey: victim.sessionKey,
            pluginOwnerId: "active-memory",
          });
          expect(loadSessionEntryReadOnly(victim)).toMatchObject(ownerEntry);
          expect(loadSessionEntryReadOnly(ordinary)).toBeUndefined();
        } finally {
          closeOpenClawAgentDatabasesForTest();
        }
      });
    },
  );
});
