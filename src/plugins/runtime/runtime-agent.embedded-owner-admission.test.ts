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
  async function preparePendingRun(
    options: { legacyInternal?: boolean; missingTargetAgent?: boolean } = {},
  ) {
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
    const sessionKey =
      options.legacyInternal || options.missingTargetAgent
        ? "agent:main:internal-session-effects:active-memory:legacy-admission"
        : "agent:main:telegram:direct:owner:active-memory:recall-admission";
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
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
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
      ...(options.missingTargetAgent ? {} : { agentId }),
      ...(options.legacyInternal
        ? {}
        : {
            sessionTarget: options.missingTargetAgent
              ? { sessionKey, sessionId, storePath }
              : { ...scope, sessionId },
          }),
      workspaceDir: "/tmp/workspace",
      timeoutMs: 1000,
    });
    if (options.legacyInternal || options.missingTargetAgent) {
      // The fixed wrapper rejects before the runner; the old one reaches the
      // paused runner and can race with a same-ID replacement.
      await Promise.race([
        entered,
        pending.then(
          () => undefined,
          () => undefined,
        ),
      ]);
    } else {
      await entered;
    }
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

  it("rejects a legacy internal run before a same-ID replacement can reach downstream admission", async () => {
    await withOpenClawTestState({ label: "plugin-admission-legacy" }, async () => {
      const { pending, release, scope, create } = await preparePendingRun({ legacyInternal: true });
      await deleteSessionEntryLifecycle({
        agentId: scope.agentId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        storePath: scope.storePath,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });
      await create();
      release();
      await expect(pending).rejects.toThrow(/exact session target identity/);
    });
  });

  it("rejects an internal target without an agent ID before a same-ID replacement can reach admission", async () => {
    await withOpenClawTestState({ label: "plugin-admission-incomplete-target" }, async () => {
      const { pending, release, scope, create } = await preparePendingRun({
        missingTargetAgent: true,
      });
      await deleteSessionEntryLifecycle({
        agentId: scope.agentId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        storePath: scope.storePath,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });
      await create();
      release();
      await expect(pending).rejects.toThrow(/exact session target identity/);
      expect(runCore).not.toHaveBeenCalled();
    });
  });

  it("keeps the admitted run when an unrelated SQLite store mutates the same agent and key", async () => {
    await withOpenClawTestState({ label: "plugin-admission-other-store" }, async () => {
      const { pending, release, runtime, scope } = await preparePendingRun();
      const otherStore = { ...scope, storePath: `${scope.storePath}.unrelated.sqlite` };
      await runtime.agent.session.patchSessionEntry({
        ...otherStore,
        fallbackEntry: { sessionId: "same-child-id", pluginOwnerId: "active-memory", updatedAt: 1 },
        replaceEntry: true,
        skipMaintenance: true,
        update: (entry, context) =>
          context.existingEntry ? null : { ...entry, pluginOwnerId: "active-memory" },
      });
      await deleteSessionEntryLifecycle({
        agentId: otherStore.agentId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        storePath: otherStore.storePath,
        target: { canonicalKey: otherStore.sessionKey, storeKeys: [otherStore.sessionKey] },
      });
      release();
      await expect(pending).resolves.toEqual({ payloads: [] });
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
