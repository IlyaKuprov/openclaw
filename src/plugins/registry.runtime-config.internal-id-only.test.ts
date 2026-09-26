import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

describe("plugin ID-only embedded session ownership", () => {
  it("requires an exact target for the caller's own internal session but retains ordinary ID-only runs", async () => {
    await withTempHome(async (home) => {
      const agentId = "main";
      const storePath = resolveSessionStorePathCore(undefined, { agentId });
      const internalKey = "agent:main:internal-session-effects:owned-id-only";
      const ordinaryKey = "agent:main:ordinary-id-only";
      try {
        await replaceSessionEntry(
          { agentId, sessionKey: internalKey, storePath },
          { sessionId: "owned-id-only", pluginOwnerId: "active-memory", updatedAt: 1 },
        );
        await replaceSessionEntry(
          { agentId, sessionKey: ordinaryKey, storePath },
          { sessionId: "ordinary-id-only", updatedAt: 1 },
        );
        const runtime = createPluginRuntime();
        const dispatch = vi.fn<PluginRuntime["agent"]["runEmbeddedAgent"]>();
        Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
          configurable: true,
          value: dispatch,
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
          { config: {} },
        );
        const common = {
          agentId,
          storePath,
          workspaceDir: path.join(home, "workspace"),
          prompt: "ID-only check",
          timeoutMs: 1_000,
          runId: "id-only-run",
        };
        await expect(
          api.runtime.agent.runEmbeddedAgent({ ...common, sessionId: "owned-id-only" }),
        ).rejects.toThrow(/exact session target identity/);
        expect(dispatch).not.toHaveBeenCalled();

        await expect(
          api.runtime.agent.runEmbeddedAgent({ ...common, sessionId: "ordinary-id-only" }),
        ).resolves.toBeUndefined();
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });
});
