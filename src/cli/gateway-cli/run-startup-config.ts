import type {
  ConfigFileSnapshot,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { createGatewayCliStartupTrace } from "./startup-trace.js";

const GATEWAY_SHELL_ENV_CONVERGENCE_MAX_READS = 4;

async function readGatewayStartupConfig(params: {
  lowerPrecedenceEnv: Readonly<Record<string, string>>;
  startupTrace: ReturnType<typeof createGatewayCliStartupTrace>;
}): Promise<{
  cfg: OpenClawConfig;
  snapshot: ConfigFileSnapshot | null;
  startupConfigSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
}> {
  const { readConfigFileSnapshotWithPluginMetadata } = await import("../../config/config.js");
  const snapshotRead: ReadConfigFileSnapshotWithPluginMetadataResult | null =
    await params.startupTrace.measure("cli.config-snapshot", () =>
      readConfigFileSnapshotWithPluginMetadata({
        isolateEnv: true,
        observe: false,
        ...(Object.keys(params.lowerPrecedenceEnv).length > 0
          ? { lowerPrecedenceEnv: params.lowerPrecedenceEnv }
          : {}),
      }).catch(() => null),
    );
  const snapshot: ConfigFileSnapshot | null = snapshotRead?.snapshot ?? null;
  const cfg = snapshot?.config ?? {};
  return {
    cfg,
    snapshot,
    ...(snapshotRead ? { startupConfigSnapshotRead: snapshotRead } : {}),
  };
}

type GatewayRunShellEnvFallbackPlan =
  | { enabled: false }
  | {
      enabled: true;
      expectedKeys: string[];
      timeoutMs: number;
    };

async function resolveGatewayRunShellEnvFallbackPlan(
  cfg: OpenClawConfig,
): Promise<GatewayRunShellEnvFallbackPlan> {
  const { createConfigRuntimeEnv } = await import("../../config/env-vars.js");
  const {
    resolveShellEnvFallbackTimeoutMs,
    shouldDeferShellEnvFallback,
    shouldEnableShellEnvFallback,
  } = await import("../../infra/shell-env.js");
  const planEnv = createConfigRuntimeEnv(cfg, process.env);
  const enabled =
    (shouldEnableShellEnvFallback(planEnv) || cfg.env?.shellEnv?.enabled === true) &&
    !shouldDeferShellEnvFallback(planEnv);
  if (!enabled) {
    return { enabled: false };
  }
  const { resolveShellEnvExpectedKeys } = await import("../../config/shell-env-expected-keys.js");
  return {
    enabled: true,
    expectedKeys: resolveShellEnvExpectedKeys(planEnv, cfg),
    timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(planEnv),
  };
}

async function loadGatewayRunShellEnvFallback(
  plan: Extract<GatewayRunShellEnvFallbackPlan, { enabled: true }>,
  gatewayLog: ReturnType<typeof createSubsystemLogger>,
): Promise<Record<string, string>> {
  const { loadShellEnvFallback } = await import("../../infra/shell-env.js");
  const valuesBeforeLoad = new Map(plan.expectedKeys.map((key) => [key, process.env[key]]));
  loadShellEnvFallback({
    enabled: true,
    env: process.env,
    expectedKeys: plan.expectedKeys,
    logger: gatewayLog,
    timeoutMs: plan.timeoutMs,
  });
  return Object.fromEntries(
    plan.expectedKeys.flatMap((key) => {
      const value = process.env[key];
      return value !== undefined && value !== valuesBeforeLoad.get(key) ? [[key, value]] : [];
    }),
  );
}

async function clearGatewayRunShellEnvFallback(
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === value) {
      delete process.env[key];
    }
  }
  const { clearShellEnvAppliedKeys } = await import("../../infra/shell-env.js");
  clearShellEnvAppliedKeys(keys);
}

function gatewayRunShellEnvFallbackPlanSignature(plan: GatewayRunShellEnvFallbackPlan): string {
  return JSON.stringify(plan);
}

export async function readGatewayStartupConfigWithShellEnv(params: {
  startupTrace: ReturnType<typeof createGatewayCliStartupTrace>;
  gatewayLog: ReturnType<typeof createSubsystemLogger>;
}): Promise<
  Awaited<ReturnType<typeof readGatewayStartupConfig>> & {
    lowerPrecedenceEnv: Readonly<Record<string, string>>;
  }
> {
  let lowerPrecedenceEnv: Record<string, string> = {};
  let loadedPlanSignature: string | undefined;
  try {
    for (let readCount = 0; readCount < GATEWAY_SHELL_ENV_CONVERGENCE_MAX_READS; readCount += 1) {
      const startupConfig = await readGatewayStartupConfig({
        lowerPrecedenceEnv,
        startupTrace: params.startupTrace,
      });
      const plan = await resolveGatewayRunShellEnvFallbackPlan(
        startupConfig.snapshot?.valid === true ? startupConfig.cfg : {},
      );
      const planSignature = gatewayRunShellEnvFallbackPlanSignature(plan);
      if (!plan.enabled) {
        if (Object.keys(lowerPrecedenceEnv).length === 0) {
          return { ...startupConfig, lowerPrecedenceEnv };
        }
        await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
        lowerPrecedenceEnv = {};
        loadedPlanSignature = undefined;
        continue;
      }
      if (loadedPlanSignature === planSignature) {
        return { ...startupConfig, lowerPrecedenceEnv };
      }
      await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
      lowerPrecedenceEnv = await loadGatewayRunShellEnvFallback(plan, params.gatewayLog);
      loadedPlanSignature = planSignature;
    }
  } catch (err) {
    await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
    throw err;
  }
  await clearGatewayRunShellEnvFallback(lowerPrecedenceEnv);
  throw new Error(
    "Gateway shell environment fallback settings changed repeatedly during startup. Retry startup.",
  );
}
