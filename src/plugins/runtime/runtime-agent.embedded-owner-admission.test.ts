import { describe, expect, it, vi } from "vitest";
import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  deleteSessionEntryLifecycle,
  loadExactSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "../loader-records.js";
import { createRuntimeTestRegistry } from "../registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./index.js";

const runCore = vi.hoisted(() => vi.fn());
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runCore }));

describe("registered plugin embedded-agent admission fence", () => {
  async function preparePendingRun() {
    const runtime = createPluginRuntime();
    const registry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "active-memory",
      source: "/plugins/active-memory/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = registry.createApi(record, { config: {} as OpenClawConfig });
    const agentId = "main";
    const sessionKey = "agent:main:telegram:direct:owner:active-memory:recall-admission";
    const sessionId = "same-child-id";
    const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
    const scope = { agentId, sessionKey, storePath };
    const create = async () =>
      await runtime.agent.session.patchSessionEntry({
        ...scope,
        fallbackEntry: { sessionId, pluginOwnerId: "active-memory", updatedAt: 1 },
        replaceEntry: true,
        skipMaintenance: true,
        update: (entry, context) =>
          context.existingEntry ? null : { ...entry, pluginOwnerId: "active-memory" },
      });
    await create();
    const original = loadExactSessionEntryReadOnly(scope)?.entry;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const waiting = new Promise<void>((resolve) => (release = resolve));
    runCore
      .mockReset()
      .mockImplementationOnce(
        async (params: { runId: string; preparedRunAdmission?: PreparedAgentRunAdmission }) => {
          enter();
          await waiting;
          const { resolvePreparedRunAdmission } =
            await import("../../agents/admitted-run-context.js");
          await resolvePreparedRunAdmission({
            runId: params.runId,
            runtimeKind: "embedded",
            preparedRunAdmission: params.preparedRunAdmission,
          });
          return { payloads: [] };
        },
      );
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
    return { pending, release, runtime, registry, record, scope, create, original };
  }

  it("rejects same-key and same-ID replacement between lazy load and actual admission", async () => {
    await withOpenClawTestState({ label: "plugin-admission-replaced" }, async () => {
      const { pending, release, scope, create, original } = await preparePendingRun();
      await deleteSessionEntryLifecycle({
        agentId: scope.agentId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        storePath: scope.storePath,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });
      await create();
      expect(loadExactSessionEntryReadOnly(scope)?.entry).toEqual(original);
      release();
      await expect(pending).rejects.toThrow(/owner|session/i);
      expect(runCore).toHaveBeenCalledOnce();
    });
  });

  it("rejects registered plugin revocation during downstream session preparation", async () => {
    await withOpenClawTestState({ label: "plugin-admission-revoked" }, async () => {
      const { pending, release, registry, record } = await preparePendingRun();
      registry.registry.plugins.splice(registry.registry.plugins.indexOf(record), 1);
      release();
      await expect(pending).rejects.toThrow(/runtime is no longer active/);
      expect(runCore).toHaveBeenCalledOnce();
    });
  });
});
