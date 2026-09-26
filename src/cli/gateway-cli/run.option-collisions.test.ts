// Gateway run option collision tests.
import { describe, expect, vi, it } from "vitest";
import type { ConfigFileSnapshot } from "../../config/types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import {
  installGatewayRunOptionCollisionsSuite,
  runGatewayCli,
  startGatewayServer,
  setGatewayWsLogStyle,
  forceFreePortAndWait,
  waitForPortBindable,
  findVerifiedGatewayListenerPidsOnPortSync,
  isTerminalInteractive,
  runGatewayLoop,
  normalizeStateDirEnv,
  pinConfigDir,
  pinRuntimePaths,
  beforeRun,
  callOrder,
  refreshManagedProxy,
  loadShellEnvFallback,
  clearShellEnvAppliedKeys,
  resolveShellEnvExpectedKeys,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
  configState,
  pristineStartupMigrationPlan,
  readConfigFileSnapshotWithPluginMetadata,
  callArg,
  gatewayStartOptions,
  runtimeErrors,
  defaultRuntime,
} from "./run.option-collisions.test-support.js";
import { installGatewayRunRuntimeHooks } from "./runtime-hooks.js";

describe("gateway run option collisions", () => {
  installGatewayRunOptionCollisionsSuite();

  it("composes gateway run registration through startup after the fast-path bootstrap", async () => {
    normalizeStateDirEnv.mockImplementation((_env?: NodeJS.ProcessEnv) => {
      callOrder.push("normalize");
    });
    startGatewayServer.mockImplementationOnce(async (_port: number, _opts?: unknown) => {
      callOrder.push("start");
      return { close: vi.fn(async () => {}) };
    });

    await runGatewayCli(["gateway", "--allow-unconfigured"]);

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(["bootstrap", "normalize", "normalize", "start"]);
    expect(runGatewayLoop).toHaveBeenCalledWith(
      expect.objectContaining({ ownsProcessLifecycle: true, runtime: defaultRuntime }),
    );
  });

  it("rejects invalid gateway ports before startup", async () => {
    await expect(
      runGatewayCli(["gateway", "--port", "0", "--token", "test-token"]),
    ).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Invalid --port. Use a port number from 1 to 65535");
  });

  it.each([{ options: [] as string[] }, { options: ["--dev"] }])(
    "suppresses ambient channel triggers by default with options %j",
    async ({ options }) => {
      await runGatewayCli(["gateway", "run", "--allow-unconfigured", ...options]);

      expect(gatewayStartOptions().ambientEnvTriggers).toBe("suppress");
    },
  );

  it.each([
    {
      label: "the primary subcommand flag",
      argv: ["gateway", "run", "--allow-unconfigured", "--ambient-channels"],
    },
    {
      label: "the inherited primary flag",
      argv: ["gateway", "--ambient-channels", "run", "--allow-unconfigured"],
    },
    {
      label: "the deprecated alias",
      argv: ["gateway", "run", "--allow-unconfigured", "--dev-ambient-channels"],
    },
  ])("allows ambient channel triggers with $label", async ({ argv }) => {
    await runGatewayCli(argv);

    expect(gatewayStartOptions().ambientEnvTriggers).toBe("allow");
  });

  it("drops the pristine core fact when guarded config becomes stateful", async () => {
    const initialConfig = {
      gateway: { mode: "local" },
      plugins: { load: { paths: ["/plugins/example"] } },
    };
    configState.snapshot = {
      config: initialConfig,
      exists: true,
      hash: "initial",
      parsed: initialConfig,
      path: "/tmp/openclaw.json",
      sourceConfig: initialConfig,
      valid: true,
    };
    pristineStartupMigrationPlan.state.mockReturnValue({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });
    const {
      prepareGatewayRunBootstrap,
      selectGatewayRunEnvironment,
      wasPreparedGatewayRunCoreStatePristine,
    } = await import("./pre-bootstrap.js");

    expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
    const recoveredConfig = {
      gateway: { mode: "local" },
      session: { store: "/tmp/sessions.json" },
    };
    configState.snapshot = {
      config: recoveredConfig,
      exists: true,
      hash: "recovered",
      parsed: recoveredConfig,
      path: "/tmp/openclaw.json",
      sourceConfig: recoveredConfig,
      valid: true,
    };

    expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
    expect(wasPreparedGatewayRunCoreStatePristine()).toBe(false);
    expect(pristineStartupMigrationPlan.config).toHaveBeenCalledWith(recoveredConfig, process.env);
  });

  it("refreshes the managed proxy from the final accepted config before gateway startup", async () => {
    const finalConfig = {
      gateway: { mode: "local" },
      proxy: { enabled: true, proxyUrl: "http://127.0.0.1:29876" },
    };
    configState.snapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      config: finalConfig,
      parsed: finalConfig,
      sourceConfig: finalConfig,
    };
    const uninstall = installGatewayRunRuntimeHooks({ refreshManagedProxy });
    try {
      await runGatewayCli(["gateway"]);
    } finally {
      uninstall();
    }

    expect(refreshManagedProxy).toHaveBeenCalledWith(finalConfig.proxy);
    const refreshOrder = refreshManagedProxy.mock.invocationCallOrder[0] ?? 0;
    const startOrder = startGatewayServer.mock.invocationCallOrder[0] ?? 0;
    expect(startOrder).toBeGreaterThan(refreshOrder);
  });

  it("loads configured shell env fallback before final proxy refresh and gateway startup", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      const finalConfig = {
        env: {
          shellEnv: { enabled: true, timeoutMs: 1234 },
          vars: { OPENCLAW_GATEWAY_TOKEN: "config-token" },
        },
        gateway: {
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
          mode: "local",
        },
        proxy: { enabled: true, proxyUrl: "http://127.0.0.1:29876" },
      };
      configState.snapshot = {
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        config: finalConfig,
        parsed: finalConfig,
        sourceConfig: finalConfig,
      };
      readConfigFileSnapshotWithPluginMetadata
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          return { snapshot: configState.snapshot };
        })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toEqual({
            OPENCLAW_GATEWAY_TOKEN: "shell-token",
          });
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("shell-token");
          return {
            snapshot: {
              ...configState.snapshot,
              config: {
                ...finalConfig,
                gateway: {
                  ...finalConfig.gateway,
                  auth: { mode: "token", token: "config-token" },
                },
              },
            },
          };
        });
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        callOrder.push("shell-env");
        (opts as { env: NodeJS.ProcessEnv }).env.OPENCLAW_GATEWAY_TOKEN = "shell-token";
      });
      const uninstall = installGatewayRunRuntimeHooks({ refreshManagedProxy });
      try {
        await runGatewayCli(["gateway"]);
      } finally {
        uninstall();
      }

      expect(loadShellEnvFallback).toHaveBeenCalledWith({
        enabled: true,
        env: process.env,
        expectedKeys: ["OPENCLAW_GATEWAY_TOKEN"],
        logger: expect.any(Object),
        timeoutMs: 1234,
      });
      expect(resolveShellEnvExpectedKeys).toHaveBeenCalledWith(
        expect.objectContaining({ OPENCLAW_GATEWAY_TOKEN: "config-token" }),
        finalConfig,
      );
      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          lowerPrecedenceEnv: { OPENCLAW_GATEWAY_TOKEN: "shell-token" },
        }),
      );
      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(2);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("config-token");
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["OPENCLAW_GATEWAY_TOKEN"]);
      const shellEnvOrder = loadShellEnvFallback.mock.invocationCallOrder[0] ?? 0;
      const initialConfigReadOrder =
        readConfigFileSnapshotWithPluginMetadata.mock.invocationCallOrder[0] ?? 0;
      const finalConfigReadOrder =
        readConfigFileSnapshotWithPluginMetadata.mock.invocationCallOrder[1] ?? 0;
      const refreshOrder = refreshManagedProxy.mock.invocationCallOrder[0] ?? 0;
      const startOrder = startGatewayServer.mock.invocationCallOrder[0] ?? 0;
      expect(shellEnvOrder).toBeGreaterThan(initialConfigReadOrder);
      expect(finalConfigReadOrder).toBeGreaterThan(shellEnvOrder);
      expect(refreshOrder).toBeGreaterThan(shellEnvOrder);
      expect(startOrder).toBeGreaterThan(refreshOrder);
    });
  });

  it("lets config env aliases replace canonical shell fallback values", async () => {
    await withEnvAsync({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, async () => {
      const finalConfig = {
        env: {
          shellEnv: { enabled: true },
          vars: { Z_AI_API_KEY: "config-key" },
        },
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      configState.snapshot = {
        config: finalConfig,
        exists: true,
        parsed: finalConfig,
        path: "/tmp/openclaw.json",
        sourceConfig: finalConfig,
        valid: true,
      };
      resolveShellEnvExpectedKeys
        .mockReturnValueOnce(["ZAI_API_KEY"])
        .mockReturnValueOnce(["ZAI_API_KEY"]);
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        (opts as { env: NodeJS.ProcessEnv }).env.ZAI_API_KEY = "shell-key";
      });

      await runGatewayCli(["gateway"]);

      expect(process.env.Z_AI_API_KEY).toBe("config-key");
      expect(process.env.ZAI_API_KEY).toBe("config-key");
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["ZAI_API_KEY"]);
    });
  });

  it("removes shell fallback values when the final accepted config disables fallback", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
      const enabledConfig = {
        env: { shellEnv: { enabled: true } },
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      const disabledConfig = {
        gateway: { auth: { mode: "none" }, mode: "local" },
      };
      const snapshot = (config: Record<string, unknown>) => ({
        config,
        exists: true,
        parsed: config,
        path: "/tmp/openclaw.json",
        sourceConfig: config,
        valid: true,
      });
      readConfigFileSnapshotWithPluginMetadata
        .mockResolvedValueOnce({ snapshot: snapshot(enabledConfig) })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toEqual({
            OPENCLAW_GATEWAY_TOKEN: "shell-token",
          });
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("shell-token");
          return { snapshot: snapshot(disabledConfig) };
        })
        .mockImplementationOnce(async (options) => {
          expect(options?.lowerPrecedenceEnv).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          return { snapshot: snapshot(disabledConfig) };
        });
      loadShellEnvFallback.mockImplementationOnce((opts?: unknown) => {
        (opts as { env: NodeJS.ProcessEnv }).env.OPENCLAW_GATEWAY_TOKEN = "shell-token";
      });

      await runGatewayCli(["gateway"]);

      expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(3);
      expect(loadShellEnvFallback).toHaveBeenCalledOnce();
      expect(clearShellEnvAppliedKeys).toHaveBeenCalledWith(["OPENCLAW_GATEWAY_TOKEN"]);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(startGatewayServer).toHaveBeenCalledOnce();
    });
  });

  it("uses config env shell fallback controls without mutating the live env during planning", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: undefined,
      },
      async () => {
        const finalConfig = {
          env: {
            vars: {
              OPENCLAW_LOAD_SHELL_ENV: "1",
              OPENCLAW_SHELL_ENV_TIMEOUT_MS: "4321",
            },
          },
          gateway: { auth: { mode: "none" }, mode: "local" },
        };
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          parsed: finalConfig,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };
        shouldEnableShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        resolveShellEnvFallbackTimeoutMs.mockImplementationOnce((env?: NodeJS.ProcessEnv) =>
          Number(env?.OPENCLAW_SHELL_ENV_TIMEOUT_MS),
        );

        await runGatewayCli(["gateway"]);

        expect(loadShellEnvFallback).toHaveBeenCalledWith(
          expect.objectContaining({ enabled: true, timeoutMs: 4321 }),
        );
        expect(process.env.OPENCLAW_LOAD_SHELL_ENV).toBe("1");
        expect(process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS).toBe("4321");
      },
    );
  });

  it("honors config env shell fallback deferral", async () => {
    await withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
      },
      async () => {
        const finalConfig = {
          env: {
            vars: {
              OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1",
              OPENCLAW_LOAD_SHELL_ENV: "1",
            },
          },
          gateway: { auth: { mode: "none" }, mode: "local" },
        };
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          parsed: finalConfig,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };
        shouldEnableShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        shouldDeferShellEnvFallback.mockImplementationOnce(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_DEFER_SHELL_ENV_FALLBACK === "1",
        );

        await runGatewayCli(["gateway"]);

        expect(resolveShellEnvExpectedKeys).not.toHaveBeenCalled();
        expect(loadShellEnvFallback).not.toHaveBeenCalled();
      },
    );
  });

  it("ignores shell fallback controls from invalid config", async () => {
    const { clearGatewayRunConfigEnvironment } = await import("./pre-bootstrap.js");
    clearGatewayRunConfigEnvironment();
    await withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: "1",
      },
      async () => {
        const invalidConfig = {
          env: { vars: { OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = {
          config: invalidConfig,
          exists: true,
          issues: [{ path: "gateway", message: "invalid" }],
          parsed: invalidConfig,
          path: "/tmp/openclaw.json",
          sourceConfig: invalidConfig,
          valid: false,
        };
        shouldEnableShellEnvFallback.mockImplementation(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_LOAD_SHELL_ENV === "1",
        );
        shouldDeferShellEnvFallback.mockImplementation(
          (env?: NodeJS.ProcessEnv) => env?.OPENCLAW_DEFER_SHELL_ENV_FALLBACK === "1",
        );

        await runGatewayCli(["gateway", "--allow-unconfigured"]);

        expect(loadShellEnvFallback).toHaveBeenCalledOnce();
        expect(startGatewayServer).toHaveBeenCalledOnce();
      },
    );
  });

  it("admits deterministic legacy repairs to gateway preflight and rejects unrelated drift", async () => {
    const selectedStateDir = "/tmp/openclaw-stable-upgrade-state";
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const stableConfig = {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true } },
          entries: { main: {} },
        },
        env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
        gateway: { mode: "local" },
        session: { idleMinutes: 45 },
      };
      configState.snapshot = {
        config: stableConfig,
        runtimeConfig: stableConfig,
        exists: true,
        issues: [
          { path: "meta", message: "retired" },
          { path: "agents.defaults.heartbeat", message: "retired" },
          { path: "session.idleMinutes", message: "retired" },
        ],
        legacyIssues: [{ path: "", message: "retired" }],
        parsed: stableConfig,
        path: "/tmp/openclaw.json",
        raw: JSON.stringify(stableConfig),
        resolved: stableConfig,
        sourceConfig: stableConfig,
        valid: false,
        warnings: [],
      };
      const {
        prepareGatewayRunBootstrap,
        recheckGatewayRunBootstrap,
        selectGatewayRunEnvironment,
      } = await import("./pre-bootstrap.js");

      expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);

      const repairedConfig = {
        agents: { defaults: {}, entries: { main: {} } },
        env: stableConfig.env,
        gateway: { mode: "local" as const },
        session: { reset: { mode: "idle", idleMinutes: 45 } },
        meta: {
          lastTouchedVersion: VERSION,
          migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
        },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      const repairedSnapshot = {
        config: repairedConfig,
        exists: true,
        issues: [],
        legacyIssues: [],
        parsed: repairedConfig,
        path: "/tmp/openclaw.json",
        raw: JSON.stringify(repairedConfig),
        resolved: repairedConfig,
        runtimeConfig: repairedConfig,
        sourceConfig: repairedConfig,
        valid: true,
        warnings: [],
      } satisfies ConfigFileSnapshot;
      expect(
        await recheckGatewayRunBootstrap({
          opts: {},
          runtime: defaultRuntime,
          snapshot: repairedSnapshot,
        }),
      ).toBe(true);
      await expect(
        recheckGatewayRunBootstrap({
          opts: {},
          runtime: defaultRuntime,
          snapshot: {
            ...repairedSnapshot,
            sourceConfig: { ...repairedConfig, gateway: { mode: "remote" } },
          },
        }),
      ).rejects.toMatchObject({ code: 1 });
    });
  });

  it("rejects an invalid final config after a prepared config selected runtime paths", async () => {
    const selectedStateDir = "/tmp/openclaw-prepared-selected-state";
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const selectedConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
        gateway: { mode: "local" },
      };
      configState.snapshot = {
        config: selectedConfig,
        exists: true,
        parsed: selectedConfig,
        path: "/tmp/openclaw.json",
        sourceConfig: selectedConfig,
        valid: true,
      };
      const {
        applyFinalGatewayRunConfigEnv,
        prepareGatewayRunBootstrap,
        selectGatewayRunEnvironment,
      } = await import("./pre-bootstrap.js");

      expect(await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime })).toBe(true);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);

      const invalidSnapshot = {
        ...configState.snapshot,
        issues: [{ message: "invalid", path: "gateway" }],
        valid: false,
      };
      await expect(
        applyFinalGatewayRunConfigEnv({
          runtime: defaultRuntime,
          snapshot: invalidSnapshot as ConfigFileSnapshot,
        }),
      ).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.join("\n")).toContain("final config read became invalid");
      expect(startGatewayServer).not.toHaveBeenCalled();
    });
  });

  it("replaces config-derived env when the final startup snapshot changes in place", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_PROXY_URL: undefined,
        OPENCLAW_RAW_STREAM: undefined,
      },
      async () => {
        const oldConfig = {
          env: {
            vars: {
              OPENCLAW_GATEWAY_TOKEN: "old-token",
              OPENCLAW_PROXY_URL: "http://127.0.0.1:19876",
              OPENCLAW_RAW_STREAM: "1",
            },
          },
          gateway: { mode: "local" },
        };
        const newConfig = {
          env: { vars: { OPENCLAW_GATEWAY_TOKEN: "new-token" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = {
          config: oldConfig,
          exists: true,
          hash: "old",
          path: "/tmp/openclaw.json",
          sourceConfig: oldConfig,
          valid: true,
        };
        const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
          await import("./pre-bootstrap.js");
        await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
        await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
        expect(pinRuntimePaths).toHaveBeenCalledWith(process.env);
        expect(pinConfigDir).toHaveBeenCalledWith(process.env);
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("old-token");
        expect(process.env.OPENCLAW_PROXY_URL).toBe("http://127.0.0.1:19876");

        configState.snapshot = {
          config: newConfig,
          exists: true,
          hash: "new",
          path: "/tmp/openclaw.json",
          sourceConfig: newConfig,
          valid: true,
        };
        readConfigFileSnapshotWithPluginMetadata.mockImplementationOnce(async () => {
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          expect(process.env.OPENCLAW_PROXY_URL).toBeUndefined();
          return { snapshot: configState.snapshot };
        });
        await runGatewayCli(["gateway", "--raw-stream"]);

        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("new-token");
        expect(process.env.OPENCLAW_PROXY_URL).toBeUndefined();
        expect(process.env.OPENCLAW_RAW_STREAM).toBe("1");
      },
    );
  });

  it("forwards parent-captured options to `gateway run` subcommand", async () => {
    normalizeStateDirEnv.mockImplementation((_env?: NodeJS.ProcessEnv) => {
      callOrder.push("normalize");
    });
    startGatewayServer.mockImplementationOnce(async (_port: number, _opts?: unknown) => {
      callOrder.push("start");
      return { close: vi.fn(async () => {}) };
    });

    await runGatewayCli([
      "gateway",
      "run",
      "--token",
      "tok_run",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(callArg(forceFreePortAndWait, 0, 0)).toBe(18789);
    expect(callArg(waitForPortBindable, 0, 0)).toBe(18789);
    expect(
      callArg(waitForPortBindable, 0, 1) as { intervalMs?: number; timeoutMs?: number },
    ).toEqual({ intervalMs: 150, timeoutMs: 3000 });
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(gatewayStartOptions().auth?.token).toBe("tok_run");
    expect(normalizeStateDirEnv).toHaveBeenCalledWith(process.env);
    expect(callOrder).toEqual(["bootstrap", "normalize", "normalize", "start"]);
  });

  it("refuses non-interactive --force when a verified gateway appears before signaling", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([]).mockReturnValueOnce([4242]);
    forceFreePortAndWait.mockImplementationOnce(async (_port, opts) => {
      (opts as { beforeSignal?: () => void }).beforeSignal?.();
      return { killed: [], waitedMs: 0, escalatedToSigkill: false };
    });

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18789);
    expect(forceFreePortAndWait).toHaveBeenCalledTimes(1);
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("openclaw gateway run --dev");
    expect(runtimeErrors.join("\n")).toContain("--profile <name> with a free port");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
