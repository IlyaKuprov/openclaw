// Gateway run option collision tests.
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, vi, it } from "vitest";
import { CONFIG_AUDIT_STORE_LABEL } from "../../config/io.audit.js";
import { createNewerSqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
import { OpenClawDatabaseSchemaPreflightError } from "../../state/openclaw-database-preflight.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "../../state/openclaw-state-db-schema-migration-required.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { getFreePort } from "../../test-utils/ports.js";
import { withTempSecretFiles } from "../../test-utils/secret-file-fixture.js";
import {
  installGatewayRunOptionCollisionsSuite,
  runGatewayCli,
  startGatewayServer,
  triageAfterFailure,
  offerInvalidConfigRecovery,
  parkCurrentLaunchAgentForMaintenance,
  ensureDevGatewayConfig,
  runGatewayLoop,
  detectRespawnSupervisor,
  beforeRun,
  refreshManagedProxy,
  gatewayLogMessages,
  gatewayErrorMessages,
  configState,
  readBestEffortConfig,
  readConfigFileSnapshotWithPluginMetadata,
  writeDiagnosticStabilityBundleForFailureSync,
  bootLifecycle,
  withoutSupervisorEnv,
  stateDirs,
  prepareGatewayReset,
  gatewayStartOptions,
  expectAuthOverrideMode,
  runtimeErrors,
  defaultRuntime,
} from "./run.option-collisions.test-support.js";
import type { GatewayLoopStart, GatewayLoopParams } from "./run.option-collisions.test-support.js";
import { installGatewayRunRuntimeHooks } from "./runtime-hooks.js";

describe("gateway run option collisions", () => {
  installGatewayRunOptionCollisionsSuite();

  it("uses the Gateway audit-deferred integrity path on its first boot database open", async () => {
    const stateDir = stateDirs.make("gateway-first-state-open-");
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      async () => {
        const { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } =
          await import("../../state/openclaw-state-db.js");
        const lifecycle = await vi.importActual<
          typeof import("../../infra/gateway-boot-lifecycle.js")
        >("../../infra/gateway-boot-lifecycle.js");
        // Seed a current-schema file so a migration's mandatory full check cannot
        // mask the ordinary first boot open's policy.
        openOpenClawStateDatabase({ env: process.env });
        closeOpenClawStateDatabaseForTest();
        const checks: string[] = [];
        // oxlint-disable-next-line typescript/unbound-method -- Forward the native method with its database receiver.
        const prepare = DatabaseSync.prototype.prepare;
        const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: DatabaseSync,
          sql: string,
        ) {
          if (sql.startsWith("PRAGMA integrity_check") || sql.startsWith("PRAGMA quick_check")) {
            checks.push(sql);
          }
          return prepare.call(this, sql);
        });
        bootLifecycle.inspect
          .mockImplementationOnce((env, nowMs) =>
            lifecycle.inspectGatewayCrashLoopBreaker(env, nowMs),
          )
          .mockImplementationOnce((env, nowMs) =>
            lifecycle.inspectGatewayCrashLoopBreaker(env, nowMs),
          );
        runGatewayLoop.mockImplementationOnce(async ({ beginBoot }) => {
          await beginBoot?.(Date.now());
          closeOpenClawStateDatabaseForTest();
          await beginBoot?.(Date.now() + 1);
        });
        try {
          await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);
          expect(checks).not.toContain("PRAGMA integrity_check;");
          expect(checks.filter((sql) => sql === "PRAGMA quick_check;")).toHaveLength(2);
          expect(checks.some((sql) => sql.includes("audit_events"))).toBe(false);
          // The CLI releases a verifier even if the loop exits without a server
          // close handle. Later direct-local work must recover its full proof.
          closeOpenClawStateDatabaseForTest();
          checks.length = 0;
          openOpenClawStateDatabase({ env: process.env });
          expect(checks).toContain("PRAGMA integrity_check;");
        } finally {
          spy.mockRestore();
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  });

  it("keeps the CLI boot verifier registered without starting its timer during slow startup", async () => {
    const stateDir = stateDirs.make("gateway-slow-start-state-open-");
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      async () => {
        const { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } =
          await import("../../state/openclaw-state-db.js");
        await import("../../state/openclaw-database-verify.js");
        openOpenClawStateDatabase({ env: process.env });
        closeOpenClawStateDatabaseForTest();
        const checks: string[] = [];
        let timersBeforeStartupOpen = -1;
        // oxlint-disable-next-line typescript/unbound-method -- Forward the native method with its exact receiver.
        const prepare = DatabaseSync.prototype.prepare;
        const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: DatabaseSync,
          sql: string,
        ) {
          if (sql.startsWith("PRAGMA integrity_check") || sql.startsWith("PRAGMA quick_check")) {
            checks.push(sql);
          }
          return prepare.call(this, sql);
        });
        runGatewayLoop.mockImplementationOnce(async ({ beginBoot }) => {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            await beginBoot?.(1000);
            timersBeforeStartupOpen = vi.getTimerCount();
            if (timersBeforeStartupOpen === 0) {
              await vi.advanceTimersByTimeAsync(300_001);
              openOpenClawStateDatabase({ env: process.env });
            }
          } finally {
            vi.useRealTimers();
          }
        });
        try {
          await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);
          expect(timersBeforeStartupOpen).toBe(0);
          expect(checks).toContain("PRAGMA quick_check;");
          expect(checks).not.toContain("PRAGMA integrity_check;");
        } finally {
          spy.mockRestore();
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  });

  it("re-inspects crash-loop breaker state for each boot iteration", async () => {
    let firstBootRecovery: (() => boolean) | undefined;
    bootLifecycle.record.mockReturnValueOnce("boot-1").mockReturnValueOnce("boot-2");
    runGatewayLoop.mockImplementationOnce(
      async ({
        beginBoot,
        start,
      }: {
        beginBoot?: (startedAtMs: number) => Promise<void> | void;
        start: GatewayLoopStart;
      }) => {
        await beginBoot?.(1000);
        await start({ startupStartedAt: 1000 });
        firstBootRecovery = gatewayStartOptions(0).tryRecoverChannelAutostartSuppression;
        await beginBoot?.(2000);
        await start({ startupStartedAt: 2000 });
      },
    );
    bootLifecycle.decisions.push(
      {
        tripped: true,
        uncleanBoots: 3,
        windowMs: 300_000,
        shouldWriteStabilityBundle: true,
        recovered: false,
      },
      {
        tripped: false,
        uncleanBoots: 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: false,
        recovered: true,
      },
    );

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.inspect.mock.calls.map((call) => call[1])).toEqual([1000, 2000]);
    expect(bootLifecycle.record.mock.calls.map((call) => call[2])).toEqual([
      "gateway.crash_loop_breaker",
      "gateway.crash_loop_recovered",
    ]);
    expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledTimes(1);
    expect(gatewayStartOptions(0).channelAutostartSuppression).toMatchObject({
      reason: "crash-loop-breaker",
    });
    expect(gatewayStartOptions(0).channelAutostartSuppression?.message).toContain(
      bootLifecycle.manualChannelStartHint,
    );
    expect(gatewayStartOptions(1).channelAutostartSuppression).toBeUndefined();
    bootLifecycle.decisions.push({
      tripped: false,
      uncleanBoots: 0,
      windowMs: 300_000,
      shouldWriteStabilityBundle: false,
      recovered: true,
    });
    expect(firstBootRecovery?.()).toBe(false);
    expect(bootLifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(bootLifecycle.recover).not.toHaveBeenCalled();
    expect(gatewayLogMessages.some((message) => message.includes("breaker recovered"))).toBe(true);
  });

  it.each([
    { supervised: false, transition: false, recorded: true, attempts: 1 },
    { supervised: false, transition: false, recorded: false, attempts: 0 },
    { supervised: true, transition: false, recorded: true, attempts: 0 },
    { supervised: true, transition: true, recorded: true, attempts: 1 },
    { supervised: true, transition: true, recorded: false, attempts: 0 },
    { supervised: false, transition: false, recorded: true, attempts: 0, cleanupFailure: "direct" },
    { supervised: true, transition: true, recorded: true, attempts: 0, cleanupFailure: "wrapped" },
  ])(
    "triages failed starts once with supervisor transition gating: %j",
    async ({ supervised, transition, recorded, attempts, cleanupFailure }) => {
      triageAfterFailure.mockClear();
      detectRespawnSupervisor.mockReturnValue(supervised ? "systemd" : null);
      bootLifecycle.record.mockReturnValueOnce(recorded ? "boot-id" : undefined);
      bootLifecycle.decisions.push({
        tripped: transition,
        uncleanBoots: transition ? 3 : 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: transition,
        recovered: false,
      });
      let failure: Error = new Error("configured plugin crashed during startup");
      if (cleanupFailure) {
        const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
        failure = new GatewayStartupCleanupError(
          failure,
          new Error("required cleanup unconfirmed"),
        );
        if (cleanupFailure === "wrapped") {
          failure = new Error("startup wrapper failed", { cause: failure });
        }
      }
      runGatewayLoop.mockImplementationOnce(
        async (
          params: GatewayLoopParams & {
            beginBoot?: (now: number) => Promise<void>;
            onRestartStartupFailure?: (error: unknown, signal: AbortSignal) => Promise<void>;
          },
        ) => {
          await params.beginBoot?.(1000);
          // Repeated in-process failures and the terminal catch share one handoff.
          await params.onRestartStartupFailure?.(failure, new AbortController().signal);
          await params.onRestartStartupFailure?.(failure, new AbortController().signal);
          throw failure;
        },
      );
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:1",
      );
      expect(triageAfterFailure).toHaveBeenCalledTimes(attempts);
      if (attempts) {
        expect(triageAfterFailure).toHaveBeenCalledWith(
          defaultRuntime,
          expect.objectContaining({
            kind: "gateway-startup",
            error: failure.message,
            gateway: "verify-running",
          }),
          expect.any(AbortSignal),
        );
      }
      expect(runtimeErrors.join("\n")).toContain(failure.message);
    },
  );

  it("recovers channel autostart only after the full breaker window drains", async () => {
    runGatewayLoop.mockImplementationOnce(
      async ({
        beginBoot,
        start,
      }: {
        beginBoot?: (startedAtMs: number) => Promise<void> | void;
        start: GatewayLoopStart;
      }) => {
        await beginBoot?.(1000);
        await start({ startupStartedAt: 1000 });
      },
    );
    bootLifecycle.decisions.push({
      tripped: true,
      uncleanBoots: 3,
      windowMs: 300_000,
      shouldWriteStabilityBundle: false,
      recovered: false,
    });

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    const recover = gatewayStartOptions().tryRecoverChannelAutostartSuppression;
    expect(recover).toBeTypeOf("function");
    bootLifecycle.decisions.push(
      {
        tripped: false,
        uncleanBoots: 1,
        windowMs: 300_000,
        shouldWriteStabilityBundle: false,
        recovered: true,
      },
      {
        tripped: false,
        uncleanBoots: 0,
        windowMs: 300_000,
        shouldWriteStabilityBundle: false,
        recovered: true,
      },
    );

    expect(recover?.()).toBe(false);
    expect(bootLifecycle.recover).not.toHaveBeenCalled();
    expect(recover?.()).toBe(true);
    expect(bootLifecycle.recover).toHaveBeenCalledWith("boot-id", process.env, undefined);
    expect(gatewayLogMessages.some((message) => message.includes("breaker recovered"))).toBe(true);
  });

  it.each(["initial", "restart", "cause", "aggregate"] as const)(
    "retains the actual legacy-session refusal without triage (%s)",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-legacy-refusal-"));
      const storePath = path.join(root, "sessions.json");
      const original = '{"main":{"sessionId":"legacy","updatedAt":1}}';
      await fs.writeFile(storePath, original);
      try {
        const { assertSessionStoreMigrationComplete } =
          await import("../../config/sessions/startup-migration.js");
        let refusal: unknown;
        try {
          assertSessionStoreMigrationComplete({ cfg: {}, targets: [{ storePath }] });
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(Error);
        const message = (refusal as Error).message;
        expect(message).toBe(
          `Legacy session store requires migration: ${storePath}. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.`,
        );
        const failure =
          kind === "cause"
            ? new Error("startup wrapper", { cause: refusal })
            : kind === "aggregate"
              ? new AggregateError([refusal], message)
              : refusal;
        runGatewayLoop.mockImplementationOnce(
          async (
            params: GatewayLoopParams & {
              beginBoot?: (now: number) => Promise<void>;
              onRestartStartupFailure?: (error: unknown, signal: AbortSignal) => Promise<void>;
            },
          ) => {
            await params.beginBoot?.(1000);
            if (kind === "restart") {
              await params.onRestartStartupFailure?.(failure, new AbortController().signal);
            }
            throw failure;
          },
        );
        await withEnvAsync({ CODEX_THREAD_ID: undefined }, async () => {
          await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
            "__exit__:78",
          );
        });
        expect(triageAfterFailure).not.toHaveBeenCalled();
        expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
        expect(runtimeErrors.join("\n")).toContain(message);
        expect(await fs.readFile(storePath, "utf8")).toBe(original);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("exits 78 when the only startup blocker is legacy workspace setup state", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-workspace-refusal-"));
    const source = path.join(workspaceDir, "openclaw-workspace-state.json");
    const original = JSON.stringify({ version: 1, setupCompletedAt: new Date().toISOString() });
    await fs.writeFile(source, original);
    try {
      const { assertWorkspaceStateMigrationReady } =
        await import("../../agents/workspace-legacy-state.js");
      startGatewayServer.mockImplementationOnce(async () => {
        assertWorkspaceStateMigrationReady({ workspaceDirs: [workspaceDir] });
        throw new Error("Legacy workspace setup state was unexpectedly accepted");
      });
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
      expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
      expect(triageAfterFailure).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toMatch(/gateway stop.*doctor --fix.*gateway start/s);
      expect(await fs.readFile(source, "utf8")).toBe(original);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("skips failure bundles but exits nonzero for unconfirmed gateway lock conflicts", async () => {
    const port = await getFreePort();
    configState.snapshot = {
      config: { gateway: { port } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const err = Object.assign(new Error(`gateway already running on port ${port}`), {
      name: "GatewayLockError",
    });
    startGatewayServer.mockRejectedValueOnce(err);

    await withEnvAsync(withoutSupervisorEnv, async () => {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:1",
      );
    });

    expect(writeDiagnosticStabilityBundleForFailureSync).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledWith(port, expect.any(Object));
    expect(runtimeErrors.join("\n")).toContain(`gateway already running on port ${port}`);
    expect(runtimeErrors.join("\n")).toContain("gateway stop");
    expect(triageAfterFailure).not.toHaveBeenCalled();
  });

  it("exits 78 and parks launchd for a repairable shared-state schema", async () => {
    bootLifecycle.record.mockReturnValueOnce(undefined);
    runGatewayLoop.mockImplementationOnce(async ({ start, completeBoot }: GatewayLoopParams) => {
      try {
        await start();
      } catch (error) {
        completeBoot?.({ outcome: "startup_failed", reason: "schema migration required" });
        throw error;
      }
    });
    startGatewayServer.mockRejectedValueOnce(
      new OpenClawStateDatabaseSchemaMigrationRequiredError(
        "agent-databases-composite-primary-key",
        "/tmp/openclaw.sqlite",
      ),
    );
    parkCurrentLaunchAgentForMaintenance.mockResolvedValueOnce(true);

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:78",
    );

    expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
    expect(bootLifecycle.complete).toHaveBeenCalledWith(undefined, {
      outcome: "startup_failed",
      reason: "schema migration required",
    });
    expect(triageAfterFailure).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "state database schema migration required (agent-databases-composite-primary-key)",
    );
  });

  it("does not park launchd for a nonrepairable shared-state schema", async () => {
    startGatewayServer.mockRejectedValueOnce(
      new Error(
        "OpenClaw state database /tmp/openclaw.sqlite has a noncanonical agent database registry schema that cannot be repaired automatically.",
      ),
    );

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(parkCurrentLaunchAgentForMaintenance).not.toHaveBeenCalled();
    expect(triageAfterFailure).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "server", kind: "state" },
    { phase: "server", kind: "agent" },
    { phase: "server", kind: "wrapped-reader" },
    { phase: "server", kind: "mixed-maintenance" },
    { phase: "bootstrap", kind: "reader" },
    { phase: "configuration", kind: "wrapped-reader" },
  ] as const)("stops newer-schema retries from $phase ($kind)", async ({ phase, kind }) => {
    const readerError = createNewerSqliteSchemaVersionError(
      "test database",
      "/tmp/newer.sqlite",
      999,
      998,
    );
    const error =
      kind === "state" || kind === "agent"
        ? new OpenClawDatabaseSchemaPreflightError([
            {
              kind,
              path: "/tmp/newer.sqlite",
              foundVersion: 999,
              supportedVersion: 998,
              writerAppVersion: "2026.9.4",
            },
          ])
        : kind === "reader"
          ? readerError
          : kind === "mixed-maintenance"
            ? new AggregateError(
                [
                  new OpenClawStateDatabaseSchemaMigrationRequiredError(
                    "audit-events-v2",
                    "/tmp/state.sqlite",
                  ),
                  readerError,
                ],
                "Multiple maintenance failures",
              )
            : new Error("Failed to open plugin state", { cause: readerError });
    if (phase === "bootstrap") {
      beforeRun.mockRejectedValueOnce(error);
    } else if (phase === "configuration") {
      refreshManagedProxy.mockRejectedValueOnce(error);
    } else {
      startGatewayServer.mockRejectedValueOnce(error);
    }
    parkCurrentLaunchAgentForMaintenance.mockResolvedValueOnce(true);
    const restoreHooks = installGatewayRunRuntimeHooks({ refreshManagedProxy });
    try {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    } finally {
      restoreHooks();
    }

    expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
    expect(offerInvalidConfigRecovery).not.toHaveBeenCalled();
    if (error instanceof OpenClawDatabaseSchemaPreflightError) {
      expect(gatewayErrorMessages).toEqual([`${error.message} Parked the managed LaunchAgent.`]);
      expect(gatewayErrorMessages[0]).toContain(
        "uses schema 999; this build supports 998; writer build 2026.9.4",
      );
      expect(runtimeErrors).toEqual([`Gateway failed to start: ${error.message}`]);
    } else {
      expect(runtimeErrors.join("\n")).toContain("newer");
      expect(runtimeErrors.join("\n")).toContain("restore your pre-update backup");
      expect(runtimeErrors.join("\n")).toMatch(
        /Stop the service.*then restore your pre-update backup created with openclaw backup create, then start it again/s,
      );
    }
    expect(triageAfterFailure).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledTimes(phase === "server" ? 1 : 0);
  });

  it.each([
    "gateway already running (pid 4242); lock timeout after 5000ms",
    "another gateway instance is already listening on ws://127.0.0.1",
  ])("exits 1 for unmanaged healthy-port lock conflicts: %s", async (message) => {
    const healthyGateway = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "live" }));
    });
    await new Promise<void>((resolve) => {
      healthyGateway.listen(0, "127.0.0.1", resolve);
    });
    const address = healthyGateway.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    const port = address.port;
    configState.snapshot = {
      config: { gateway: { port } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const err = Object.assign(new Error(`${message}:${port}`), {
      name: "GatewayLockError",
    });
    startGatewayServer.mockRejectedValueOnce(err);

    try {
      await withEnvAsync(withoutSupervisorEnv, async () => {
        await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
          "__exit__:1",
        );
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        healthyGateway.close((closeError) => (closeError ? reject(closeError) : resolve()));
      });
    }
  });

  it("blocks startup when the observed snapshot loses gateway.mode", async () => {
    configState.cfg = {
      gateway: {
        mode: "local",
      },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: {
        update: { channel: "beta" },
      },
      parsed: {
        update: { channel: "beta" },
      },
    };

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:78");

    expect(runtimeErrors).toContain(
      "Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
    );
    expect(runtimeErrors).toContain(`Config write audit: ${CONFIG_AUDIT_STORE_LABEL}`);
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(readBestEffortConfig).not.toHaveBeenCalled();
  });

  it("blocks invalid startup config without automatic recovery", async () => {
    configState.cfg = {};
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:78");

    expect(runtimeErrors).toContain(
      "Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set gateway.mode=local manually, or pass --allow-unconfigured.",
    );
    expect(runtimeErrors).toContain(`Config write audit: ${CONFIG_AUDIT_STORE_LABEL}`);
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledOnce();
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("keeps explicit dev reset as the recovery path for invalid config", async () => {
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await prepareGatewayReset();
    await runGatewayCli(["gateway", "--dev", "--reset", "--allow-unconfigured"]);

    expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
  });

  it("passes invalid startup snapshot through when explicitly allowed", async () => {
    configState.cfg = {};
    configState.snapshot = {
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      config: {},
      parsed: null,
      issues: [{ path: "<root>", message: "JSON5 parse failed" }],
      legacyIssues: [],
    };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    const options = gatewayStartOptions();
    expect(options.bind).toBe("loopback");
    expect(options.startupConfigSnapshotRead?.snapshot?.valid).toBe(false);
  });

  it("does not offer doctor repair after --allow-unconfigured reaches startup", async () => {
    const { createInvalidConfigError } = await import("../../config/io.invalid-config.js");
    startGatewayServer.mockRejectedValueOnce(
      createInvalidConfigError("/tmp/openclaw.json", "gateway.mode: invalid"),
    );

    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:78",
    );

    expect(offerInvalidConfigRecovery).not.toHaveBeenCalled();
    expect(startGatewayServer).toHaveBeenCalledOnce();
  });

  it.each(["none", "trusted-proxy"] as const)("accepts --auth %s override", async (mode) => {
    await runGatewayCli(["gateway", "run", "--auth", mode, "--allow-unconfigured"]);

    expectAuthOverrideMode(mode);
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --auth. Use "none", "token", "password", or "trusted-proxy".',
    );
  });

  it("accepts retired --tailscale-reset-on-exit as a no-op", async () => {
    await runGatewayCli(["gateway", "run", "--tailscale-reset-on-exit", "--allow-unconfigured"]);

    expect(runtimeErrors).toEqual([]);
    expect(startGatewayServer).toHaveBeenCalledOnce();
  });

  it("allows password mode preflight when password is configured via SecretRef", async () => {
    configState.cfg = {
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      config: configState.cfg,
      parsed: configState.cfg,
    };

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(gatewayStartOptions().bind).toBe("loopback");
  });

  it("reads gateway password from --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await runGatewayCli([
          "gateway",
          "run",
          "--auth",
          "password",
          "--password-file",
          passwordFile ?? "",
          "--allow-unconfigured",
        ]);
      },
    );

    const options = gatewayStartOptions();
    expect(options.auth?.mode).toBe("password");
    expect(options.auth?.password).toBe("pw_from_file"); // pragma: allowlist secret
    expect(runtimeErrors).not.toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("warns when gateway password is passed inline", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--auth",
      "password",
      "--password",
      "pw_inline",
      "--allow-unconfigured",
    ]);

    expect(runtimeErrors).toContain(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  });

  it("rejects using both --password and --password-file", async () => {
    await withTempSecretFiles(
      "openclaw-gateway-run-",
      { password: "pw_from_file\n" },
      async ({ passwordFile }) => {
        await expect(
          runGatewayCli([
            "gateway",
            "run",
            "--password",
            "pw_inline",
            "--password-file",
            passwordFile ?? "",
            "--allow-unconfigured",
          ]),
        ).rejects.toThrow("__exit__:1");
      },
    );
    expect(runtimeErrors[0]).toContain("Use either --password or --password-file.");
  });
});
