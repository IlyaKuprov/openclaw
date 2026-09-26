import { describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "../loader-records.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createRuntimeTestRegistry } from "../registry-runtime.test-helpers.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createPluginRuntime } from "./index.js";
import type { PluginRuntime } from "./types.js";

const importGate = vi.hoisted(() => {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
});
const runCore = vi.hoisted(() => vi.fn());
vi.mock("./runtime-embedded-agent.runtime.js", async (importOriginal) => {
  importGate.enter();
  await importGate.waiting;
  return await importOriginal<typeof import("./runtime-embedded-agent.runtime.js")>();
});
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runCore }));

describe("plugin embedded-agent target snapshot", () => {
  it("executes against the original owned store when the caller redirects its target during lazy load", async () => {
    await withOpenClawTestState({ label: "plugin-embedded-target-mutation" }, async () => {
      const runtime = createPluginRuntime();
      const registry = createEmptyPluginRegistry();
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:active-memory:target-mutation";
      const sessionId = "target-mutation-child";
      const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
      const foreignStorePath = `${storePath}.foreign.sqlite`;
      const ownScope = { agentId, sessionKey, storePath };
      const foreignScope = { ...ownScope, storePath: foreignStorePath };
      for (const [scope, pluginOwnerId] of [
        [ownScope, "active-memory"],
        [foreignScope, "foreign-plugin"],
      ] as const) {
        await runtime.agent.session.patchSessionEntry({
          ...scope,
          fallbackEntry: { sessionId, pluginOwnerId, updatedAt: 1 },
          replaceEntry: true,
          skipMaintenance: true,
          update: (entry, context) => (context.existingEntry ? null : { ...entry, pluginOwnerId }),
        });
      }
      runCore.mockImplementationOnce(async (params) => {
        const { resolvePreparedRunAdmission } =
          await import("../../agents/admitted-run-context.js");
        await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          preparedRunAdmission: params.preparedRunAdmission,
        });
        return {
          payloads: [],
          executedStorePath: params.sessionTarget?.storePath,
          executedOwner: loadExactSessionEntryReadOnly(params.sessionTarget)?.entry.pluginOwnerId,
          executedFrozen: Object.isFrozen(params.sessionTarget),
        };
      });
      const sessionTarget = { ...ownScope, sessionId };
      let targetReads = 0;
      const pending = withPluginRuntimePluginScope(
        { pluginId: "active-memory" },
        () =>
          runtime.agent.runEmbeddedAgent({
            config: {},
            prompt: "recall",
            runId: sessionId,
            sessionId,
            sessionKey,
            agentId,
            get sessionTarget() {
              targetReads += 1;
              return targetReads === 1 ? sessionTarget : { ...foreignScope, sessionId };
            },
            workspaceDir: "/tmp/workspace",
            timeoutMs: 1000,
          }),
        registry,
      );
      const enteredImport = await Promise.race([
        importGate.entered.then(() => true),
        pending.then(
          () => false,
          () => false,
        ),
      ]);
      expect(enteredImport).toBe(true);
      expect(runCore).not.toHaveBeenCalled();
      sessionTarget.storePath = foreignStorePath;
      importGate.release();
      await expect(pending).resolves.toMatchObject({
        executedStorePath: storePath,
        executedOwner: "active-memory",
        executedFrozen: true,
      });
      expect(targetReads).toBe(1);
      expect(runCore).toHaveBeenCalledOnce();
    });
  });
  it("keeps a getter-switching internal target on the owned row across registry preflight and dispatch", async () => {
    importGate.release();
    await withOpenClawTestState({ label: "plugin-embedded-registry-target" }, async () => {
      const runtime = createPluginRuntime();
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
      const agentId = "main";
      const sessionKey = "agent:main:internal-session-effects:active-memory:target-switch";
      const sessionId = "target-switch-child";
      const storePath = runtime.agent.session.resolveStorePath(undefined, { agentId });
      const coreStorePath = `${storePath}.core.sqlite`;
      const ownedTarget = { agentId, sessionKey, sessionId, storePath };
      const coreTarget = { ...ownedTarget, storePath: coreStorePath };
      await replaceSessionEntry(ownedTarget, {
        sessionId,
        pluginOwnerId: "active-memory",
        updatedAt: 1,
      });
      await replaceSessionEntry(coreTarget, { sessionId, updatedAt: 1 });
      const ordinaryTarget = {
        agentId,
        sessionKey: "agent:main:ordinary-target-switch",
        sessionId: "ordinary-target-switch-child",
        storePath,
      };
      await replaceSessionEntry(ordinaryTarget, {
        sessionId: ordinaryTarget.sessionId,
        updatedAt: 1,
      });
      runCore.mockClear();
      runCore.mockImplementation(async (params) => {
        const { resolvePreparedRunAdmission } =
          await import("../../agents/admitted-run-context.js");
        await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          preparedRunAdmission: params.preparedRunAdmission,
        });
        return {
          payloads: [],
          executedStorePath: params.sessionTarget?.storePath,
          executedOwner: loadExactSessionEntryReadOnly(params.sessionTarget)?.entry.pluginOwnerId,
          executedFrozen: Object.isFrozen(params.sessionTarget),
        };
      });
      const run = (target: typeof ownedTarget) =>
        api.runtime.agent.runEmbeddedAgent({
          ...target,
          sessionTarget: target,
          workspaceDir: "/tmp/workspace",
          prompt: "recall",
          timeoutMs: 1000,
          runId: target.sessionId,
        } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]);
      let storePathReads = 0;
      const switchingTarget = {
        agentId,
        sessionKey,
        sessionId,
        get storePath() {
          storePathReads += 1;
          return storePathReads === 1 ? storePath : coreStorePath;
        },
      };
      await expect(
        api.runtime.agent.runEmbeddedAgent({
          agentId,
          sessionKey,
          sessionId,
          sessionTarget: switchingTarget,
          workspaceDir: "/tmp/workspace",
          prompt: "recall",
          timeoutMs: 1000,
          runId: sessionId,
        } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0]),
      ).resolves.toMatchObject({
        executedStorePath: storePath,
        executedOwner: "active-memory",
        executedFrozen: true,
      });
      expect(storePathReads).toBe(1);
      expect(runCore).toHaveBeenCalledOnce();
      await expect(run(coreTarget)).rejects.toThrow(/ownerless internal session/);
      expect(runCore).toHaveBeenCalledOnce();
      await expect(run(ownedTarget)).resolves.toMatchObject({
        executedStorePath: storePath,
        executedOwner: "active-memory",
        executedFrozen: true,
      });
      await expect(run(ordinaryTarget)).resolves.toMatchObject({
        executedStorePath: storePath,
        executedFrozen: true,
      });
      expect(runCore).toHaveBeenCalledTimes(3);
    });
  });
});
