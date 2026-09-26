// Gateway run option collision tests.
import { describe, expect, vi, it } from "vitest";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../../daemon/constants.js";
import { setTestEnvValue, withEnvAsync } from "../../test-utils/env.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import {
  installGatewayRunOptionCollisionsSuite,
  runGatewayCli,
  startGatewayServer,
  setConsoleSubsystemFilter,
  forceFreePortAndWait,
  cleanStaleGatewayProcessesSync,
  warnAboutGatewayRestartStorm,
  ensureDevGatewayConfig,
  runGatewayLoop,
  normalizeStateDirEnv,
  detectRespawnSupervisor,
  loadGlobalRuntimeDotEnvFiles,
  resolveShellEnvExpectedKeys,
  gatewayLogMessages,
  configState,
  readBestEffortConfig,
  readConfigFileSnapshotWithPluginMetadata,
  netState,
  withoutGatewayAuthEnv,
  prepareGatewayReset,
  gatewayStartOptions,
  runtimeErrors,
  defaultRuntime,
} from "./run.option-collisions.test-support.js";
import type { GatewayLoopStart } from "./run.option-collisions.test-support.js";

describe("gateway run option collisions", () => {
  installGatewayRunOptionCollisionsSuite();

  it("reports forced port cleanup failures before startup", async () => {
    forceFreePortAndWait.mockRejectedValueOnce(new Error("boom"));

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Could not free port 18789: boom");
    expect(runtimeErrors.join("\n")).toContain("openclaw gateway status --deep");
  });

  it("marks service-mode gateway descendants with the live gateway pid", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: undefined,
      },
      async () => {
        await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

        expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
      },
    );
    expect(normalizeStateDirEnv).toHaveBeenCalledWith(process.env);
  });

  it.each([
    { platform: "darwin", managed: true, warns: true },
    { platform: "darwin", managed: false, warns: false },
    { platform: "linux", managed: true, warns: false },
  ] as const)(
    "reports restart storms before server startup only for managed macOS Gateways ($platform, managed=$managed)",
    async ({ platform, managed, warns }) => {
      const warning = "Gateway restart storm: inspect launchd jobs with openclaw gateway status.";
      warnAboutGatewayRestartStorm.mockImplementation(async (_env, warn) => warn(warning));
      startGatewayServer.mockImplementationOnce(async () => {
        expect(gatewayLogMessages.includes(warning)).toBe(warns);
        return { close: vi.fn(async () => {}) };
      });
      await withMockedPlatform(platform, () =>
        withEnvAsync({ OPENCLAW_SERVICE_MARKER: managed ? "openclaw" : undefined }, async () => {
          await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);
        }),
      );
      expect(startGatewayServer).toHaveBeenCalledTimes(1);
    },
  );

  it("protects the inherited service pid before replacing it", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: "4242",
      },
      async () => {
        await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

        expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(18789, {
          protectedPid: 4242,
        });
        expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
      },
    );
  });

  it("marks descendants when the final config supplies the service marker", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: undefined,
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: undefined,
      },
      async () => {
        const finalConfig = {
          env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
          gateway: { mode: "local" },
        };
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };

        await runGatewayCli(["gateway"]);

        expect(process.env.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
        expect(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBe(String(process.pid));
      },
    );
  });

  it("rechecks future config after the final config enters service mode", async () => {
    await withEnvAsync(
      {
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
        OPENCLAW_SERVICE_MARKER: undefined,
      },
      async () => {
        const finalConfig = {
          env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
          gateway: { mode: "local" },
          meta: { lastTouchedVersion: "9999.1.1" },
        };
        configState.cfg = finalConfig;
        configState.snapshot = {
          config: finalConfig,
          exists: true,
          path: "/tmp/openclaw.json",
          sourceConfig: finalConfig,
          valid: true,
        };

        await expect(runGatewayCli(["gateway"])).rejects.toThrow("__exit__:78");

        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
        expect(startGatewayServer).not.toHaveBeenCalled();
        expect(runtimeErrors.join("\n")).toContain("start the gateway service");
      },
    );
  });

  it("blocks --force port cleanup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };

    await expect(
      runGatewayCli(["gateway", "run", "--allow-unconfigured", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to force-kill gateway port listeners");
  });

  it("blocks service-mode startup from an older binary with newer config", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };
    const previousMarker = process.env.OPENCLAW_SERVICE_MARKER;
    process.env.OPENCLAW_SERVICE_MARKER = "gateway";
    try {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    } finally {
      if (previousMarker === undefined) {
        delete process.env.OPENCLAW_SERVICE_MARKER;
      } else {
        process.env.OPENCLAW_SERVICE_MARKER = previousMarker;
      }
    }

    expect(forceFreePortAndWait).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to start the gateway service");
  });

  it("blocks dev reset from an older binary before deleting state", async () => {
    configState.snapshot = {
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    };

    await expect(prepareGatewayReset()).rejects.toThrow("__exit__:1");

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to reset the dev gateway state");
  });

  it("blocks dev reset when parseable future-version metadata is schema-invalid", async () => {
    configState.snapshot = {
      config: {},
      exists: true,
      issues: [{ message: "unknown newer field", path: "gateway.newerField" }],
      parsed: { gateway: { newerField: true }, meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: {
        gateway: { newerField: true },
        meta: { lastTouchedVersion: "9999.1.1" },
      },
      valid: false,
    };

    await expect(prepareGatewayReset()).rejects.toThrow("__exit__:1");

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Refusing to reset the dev gateway state");
  });

  it("does not retain targets or credentials from the config deleted by dev reset", async () => {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_WORKSPACE_DIR: undefined,
      },
      async () => {
        configState.snapshot = {
          exists: true,
          valid: true,
          config: { gateway: { mode: "local" } },
          sourceConfig: {
            env: {
              vars: {
                OPENCLAW_CONFIG_PATH: "/tmp/openclaw-reset/openclaw.json",
                OPENCLAW_GATEWAY_TOKEN: "old-token",
                OPENCLAW_HOME: "/tmp/openclaw-reset-home",
                OPENCLAW_STATE_DIR: "/tmp/openclaw-reset",
              },
            },
            gateway: { mode: "local" },
          },
        };
        ensureDevGatewayConfig.mockImplementationOnce(async () => {
          expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
          expect(process.env.OPENCLAW_HOME).toBeUndefined();
          expect(process.env.OPENCLAW_PROFILE).toBe("dev");
          expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
          expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
          expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/tmp/openclaw-reset-workspace");
          configState.snapshot = {
            exists: true,
            valid: true,
            config: { gateway: { mode: "local" } },
            sourceConfig: { gateway: { mode: "local" } },
          };
        });
        loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
          process.env.OPENCLAW_GATEWAY_TOKEN ??= "trusted-token";
          process.env.OPENCLAW_PROFILE ??= "dev";
          if (process.env.OPENCLAW_WORKSPACE_DIR === undefined) {
            setTestEnvValue("OPENCLAW_WORKSPACE_DIR", "/tmp/openclaw-reset-workspace");
          }
        });

        await prepareGatewayReset();
        await runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev", "--reset"]);

        expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("trusted-token");
        expect(loadGlobalRuntimeDotEnvFiles).toHaveBeenCalled();
      },
    );
  });

  it("refuses dev reset if trusted dotenv retargets after pre-bootstrap", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: "/tmp/openclaw-reset-original" }, async () => {
      configState.snapshot = {
        config: { gateway: { mode: "local" } },
        exists: true,
        path: "/tmp/openclaw-reset-original/openclaw.json",
        sourceConfig: { gateway: { mode: "local" } },
        valid: true,
      };
      await prepareGatewayReset();
      loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
        setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-reset-retargeted");
        return {
          dotenvPresentKeys: ["OPENCLAW_STATE_DIR"],
          gatewayEnvAppliedKeys: [],
          stateEnvAppliedKeys: ["OPENCLAW_STATE_DIR"],
        };
      });

      await expect(
        runGatewayCli(["gateway", "run", "--allow-unconfigured", "--dev", "--reset"]),
      ).rejects.toThrow("__exit__:1");

      expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-reset-original");
      expect(runtimeErrors.join("\n")).toContain(
        "selected config or state target changed during startup",
      );
    });
  });

  it.each([
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_INCLUDE_ROOTS",
    "OPENCLAW_NIX_MODE",
    "OPENCLAW_OAUTH_DIR",
    "OPENCLAW_PACKAGE_DIR",
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKSPACE_DIR",
    "PI_CODING_AGENT_DIR",
  ])("blocks trusted dotenv selector drift for %s after startup mutations", async (selector) => {
    await withEnvAsync({ [selector]: "/tmp/openclaw-reset-value" }, async () => {
      loadGlobalRuntimeDotEnvFiles.mockImplementation(() => {
        setTestEnvValue(selector, "/tmp/openclaw-reset-retargeted");
      });
      const { reloadTrustedGatewayRunEnvironment } = await import("./pre-bootstrap.js");

      await expect(reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime })).rejects.toThrow(
        "__exit__:1",
      );

      expect(process.env[selector]).toBe("/tmp/openclaw-reset-value");
      expect(runtimeErrors.join("\n")).toContain(
        "trusted dotenv reload after startup mutations changed config or state selection",
      );
    });
  });

  it("blocks a final startup snapshot that changes guarded config selection", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      configState.snapshot = {
        exists: true,
        valid: true,
        config: { gateway: { mode: "local" } },
        sourceConfig: {
          env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-late-selection" } },
          gateway: { mode: "local" },
        },
      };

      await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      expect(startGatewayServer).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toContain(
        "final config read changed config or state selection",
      );
    });
  });

  it("blocks a final startup snapshot that changes an already-selected config selector", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: undefined }, async () => {
      const guardedConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-guarded-state" } },
        gateway: { mode: "local" },
      };
      configState.snapshot = {
        config: guardedConfig,
        exists: true,
        hash: "guarded",
        path: "/tmp/openclaw.json",
        sourceConfig: guardedConfig,
        valid: true,
      };
      const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
        await import("./pre-bootstrap.js");
      await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
      await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-guarded-state");

      const finalConfig = {
        env: { vars: { OPENCLAW_STATE_DIR: "/tmp/openclaw-final-state" } },
        gateway: { mode: "local" },
      };
      configState.snapshot = {
        config: finalConfig,
        exists: true,
        hash: "final",
        path: "/tmp/openclaw.json",
        sourceConfig: finalConfig,
        valid: true,
      };

      await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-guarded-state");
      expect(startGatewayServer).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toContain(
        "final config read changed config or state selection",
      );
    });
  });

  it.each([
    ["--cli-backend-logs", "generic flag"],
    ["--claude-cli-logs", "deprecated alias"],
  ])("enables CLI backend log filtering via %s (%s)", async (flag) => {
    delete process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT;

    await runGatewayCli(["gateway", "run", flag, "--allow-unconfigured"]);

    expect(setConsoleSubsystemFilter).toHaveBeenCalledWith(["agent/cli-backend"]);
    expect(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT).toBe("1");
  });

  it("starts gateway when token mode has no configured token (startup bootstrap path)", async () => {
    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);
    });

    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(1);
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledWith({
      isolateEnv: true,
      observe: false,
    });
    expect(resolveShellEnvExpectedKeys).not.toHaveBeenCalled();
    expect(readBestEffortConfig).not.toHaveBeenCalled();
    const options = gatewayStartOptions();
    expect(options.bind).toBe("loopback");
    expect(options.startupConfigSnapshotRead).toEqual({ snapshot: configState.snapshot });
  });

  it("allows authless auto startup when it resolves to loopback", async () => {
    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await runGatewayCli(["gateway", "run", "--bind", "auto", "--allow-unconfigured"]);
    });

    const options = gatewayStartOptions();
    expect(options.bind).toBe("auto");
  });

  it("blocks container auto startup without explicit gateway auth", async () => {
    netState.autoBindHost = "0.0.0.0";
    netState.container = true;

    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
    });

    expect(runtimeErrors.join("\n")).toContain("Refusing to bind gateway to auto without auth.");
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("blocks non-loopback startup without explicit gateway auth", async () => {
    await withEnvAsync(withoutGatewayAuthEnv, async () => {
      await expect(
        runGatewayCli(["gateway", "run", "--bind", "lan", "--allow-unconfigured"]),
      ).rejects.toThrow("__exit__:78");
    });

    expect(runtimeErrors.join("\n")).toContain("Refusing to bind gateway to lan without auth.");
    expect(startGatewayServer).not.toHaveBeenCalled();
  });

  it("allows non-loopback startup when token auth is explicit", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--bind",
      "lan",
      "--token",
      "tok_run",
      "--allow-unconfigured",
    ]);

    const options = gatewayStartOptions();
    expect(options.bind).toBe("lan");
    expect(options.auth?.token).toBe("tok_run");
  });

  it("uses the startup snapshot only for the first in-process gateway start", async () => {
    runGatewayLoop.mockImplementationOnce(async ({ start }: { start: GatewayLoopStart }) => {
      await start({ startupStartedAt: 1000 });
      await start({ startupStartedAt: 2000 });
    });

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledTimes(2);
    const firstOptions = gatewayStartOptions(0);
    expect(firstOptions.startupStartedAt).toBe(1000);
    expect(firstOptions.startupConfigSnapshotRead).toEqual({ snapshot: configState.snapshot });
    const secondOptions = gatewayStartOptions(1);
    expect(secondOptions.startupConfigSnapshotRead).toBeUndefined();
    expect(secondOptions.startupStartedAt).toBe(2000);
  });

  it("lets gateway bootstrap refresh inherited service-managed dotenv keys", async () => {
    detectRespawnSupervisor.mockReturnValue("systemd");
    await withMockedPlatform("linux", () =>
      withEnvAsync(
        {
          INVOCATION_ID: "systemd-invocation",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY,ANTHROPIC_API_KEY",
        },
        async () => {
          const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
            await import("./pre-bootstrap.js");
          await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
          await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
        },
      ),
    );

    expect(loadGlobalRuntimeDotEnvFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideKeys: new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
      }),
    );
  });

  it("limits inherited service-managed dotenv refresh to systemd launches", async () => {
    const serviceManagedEnv = await import("../../daemon/service-managed-env.js");
    detectRespawnSupervisor.mockReturnValueOnce("systemd");
    expect(
      serviceManagedEnv.readManagedSystemdServiceEnvKeysFromEnvironment(
        {
          INVOCATION_ID: "systemd-invocation",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY",
        },
        "linux",
      ),
    ).toEqual(new Set(["OPENAI_API_KEY"]));
    expect(
      serviceManagedEnv.readManagedSystemdServiceEnvKeysFromEnvironment(
        { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY" },
        "linux",
      ),
    ).toEqual(new Set());
    expect(
      serviceManagedEnv.readManagedSystemdServiceEnvKeysFromEnvironment(
        { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY" },
        "darwin",
      ),
    ).toEqual(new Set());
    expect(
      serviceManagedEnv.readManagedSystemdServiceEnvKeysFromEnvironment(
        { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY" },
        "win32",
      ),
    ).toEqual(new Set());
  });

  it("clears only missing managed keys after reading the selected config", async () => {
    detectRespawnSupervisor.mockReturnValue("systemd");
    configState.snapshot = {
      config: {},
      exists: true,
      sourceConfig: {
        models: {
          providers: {
            openai: {
              apiKey: { source: "env", id: "SECRET_REF_KEY" },
            },
          },
        },
      },
      valid: true,
    };
    loadGlobalRuntimeDotEnvFiles.mockReturnValue({
      dotenvPresentKeys: [],
      gatewayEnvAppliedKeys: [],
      stateEnvAppliedKeys: [],
    });

    await withMockedPlatform("linux", () =>
      withEnvAsync(
        {
          INVOCATION_ID: "systemd-invocation",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "REMOVED_KEY,SECRET_REF_KEY",
          REMOVED_KEY: "stale-service-value",
          SECRET_REF_KEY: "file-backed-value",
          OPENAI_API_KEY: "operator-owned-provider-key",
          OPERATOR_KEY: "operator-value",
        },
        async () => {
          const { prepareGatewayRunBootstrap, selectGatewayRunEnvironment } =
            await import("./pre-bootstrap.js");
          await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
          expect(process.env.REMOVED_KEY).toBeUndefined();
          expect(process.env.SECRET_REF_KEY).toBe("file-backed-value");
          expect(process.env.OPENAI_API_KEY).toBe("operator-owned-provider-key");
          expect(process.env.OPERATOR_KEY).toBe("operator-value");
          await prepareGatewayRunBootstrap({ opts: {}, runtime: defaultRuntime });
        },
      ),
    );
  });

  it("keeps managed keys referenced by shorthand when startup repairs the config", async () => {
    detectRespawnSupervisor.mockReturnValue("systemd");
    const { createConfigResolutionFacts, setConfigResolutionFacts } =
      await import("../../config/resolution-facts.js");
    // A repairable legacy key sends this boot through startup repair, which rebuilds sourceConfig
    // as a clone. Reading the preserve set off the rebuilt object alone loses the recorded name.
    const sourceConfig = {
      session: { idleMinutes: 45 },
      models: { providers: { minimax: { apiKey: "substituted-not-a-real-key" } } },
    };
    setConfigResolutionFacts(
      sourceConfig,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["models.providers.minimax.apiKey", "SHORTHAND_KEY"]]),
      ),
    );
    configState.snapshot = {
      path: "/tmp/openclaw.json",
      includedPaths: [],
      exists: true,
      raw: JSON.stringify(sourceConfig),
      parsed: sourceConfig,
      config: sourceConfig,
      sourceConfig,
      valid: false,
      issues: [{ path: "session.idleMinutes", message: "retired" }],
      legacyIssues: [{ path: "", message: "retired" }],
    };
    loadGlobalRuntimeDotEnvFiles.mockReturnValue({
      dotenvPresentKeys: [],
      gatewayEnvAppliedKeys: [],
      stateEnvAppliedKeys: [],
    });

    await withMockedPlatform("linux", () =>
      withEnvAsync(
        {
          INVOCATION_ID: "systemd-invocation",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "SHORTHAND_KEY,REMOVED_KEY",
          SHORTHAND_KEY: "environment-file-value",
          REMOVED_KEY: "stale-service-value",
        },
        async () => {
          const { selectGatewayRunEnvironment } = await import("./pre-bootstrap.js");
          await selectGatewayRunEnvironment({ opts: {}, runtime: defaultRuntime });
          expect(process.env.SHORTHAND_KEY).toBe("environment-file-value");
          expect(process.env.REMOVED_KEY).toBeUndefined();
        },
      ),
    );
  });
});
