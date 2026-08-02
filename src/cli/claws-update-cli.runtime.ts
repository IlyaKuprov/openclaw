import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import {
  createClawPackagePolicyPreflight,
  isInstallPolicyWarning,
  replayClawInstallPolicyAcknowledgement,
} from "../claws/install-policy-acknowledgement.js";
import { readClawStatus } from "../claws/lifecycle-state.js";
import { stableStringifyClawPlanReplayIdentity } from "../claws/plan-integrity.js";
import { readClawManifestFile } from "../claws/reader.js";
import { CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import {
  applyClawUpdatePlan,
  CLAW_UPDATE_RESULT_SCHEMA_VERSION,
  ClawUpdateMutationError,
} from "../claws/update-apply.js";
import { buildClawUpdatePlan, CLAW_UPDATE_PLAN_SCHEMA_VERSION } from "../claws/update-plan.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { openExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db.js";
import {
  formatClawInstallPolicyRetryCommand,
  logClawInstallPolicyRetry,
  logClawInstallPolicyWarning,
} from "./claws-cli-install-policy-output.js";
import { logClawUpdatePlanSummary } from "./claws-cli-update-output.js";
import type { ClawsUpdateOptions } from "./claws-cli.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { resolveInstallPolicyAcknowledgementOption } from "./install-policy-acknowledgement.js";

type DiagnosticLike = { level: string; code: string; path: string; message: string };

function formatDiagnostics(diagnostics: DiagnosticLike[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("\n");
}

function logExperimentalWarning(runtime: RuntimeEnv): void {
  runtime.log("Experimental: Claws contracts may change while RFC 0016 is under review.");
}

export async function runClawsUpdateCommand(
  target: string,
  opts: ClawsUpdateOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (!opts.dryRun && (!opts.yes || !opts.planIntegrity)) {
    const message =
      "Claw update requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to apply supported actions.";
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        ok: false,
        error: { code: "consent_required", message },
      });
    } else {
      runtime.error(message);
    }
    runtime.exit(1);
    return;
  }

  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: true,
        mutationAllowed: false,
        valid: false,
        diagnostics: [
          {
            level: "error",
            code: "mcp_config_unavailable",
            phase: "plan",
            path: "$.mcpServers",
            message: listedMcpServers.error,
          },
        ],
      });
    } else {
      runtime.error(listedMcpServers.error);
    }
    runtime.exit(1);
    return;
  }
  const config = listedMcpServers.config;

  let source = opts.from;
  if (!source) {
    const database = await openExistingOpenClawStateDatabaseReadOnly();
    let status: Awaited<ReturnType<typeof readClawStatus>> | { records: never[] } = {
      records: [],
    };
    if (database) {
      try {
        const hasClawInstalls =
          database.db /* sqlite-allow-raw: read-only Claw install table-existence probe. */
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
            .get();
        if (hasClawInstalls) {
          status = await readClawStatus(target, {
            database,
            readOnly: true,
            sourceMcpServers: listedMcpServers.mcpServers,
          });
        }
      } finally {
        database.walMaintenance.close();
      }
    }
    if (status.records.length !== 1) {
      const message =
        status.records.length === 0
          ? `No installed Claw agent matches ${JSON.stringify(target)}.`
          : `Claw name ${JSON.stringify(target)} matches multiple agents; use an agent id.`;
      if (opts.json) {
        writeRuntimeJson(runtime, {
          schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
          stability: CLAW_OUTPUT_STABILITY,
          dryRun: true,
          mutationAllowed: false,
          valid: false,
          diagnostics: [
            {
              level: "error",
              code: status.records.length === 0 ? "claw_not_found" : "claw_ambiguous",
              phase: "plan",
              path: "$",
              message,
            },
          ],
        });
      } else {
        runtime.error(message);
      }
      runtime.exit(1);
      return;
    }
    const recorded = status.records[0]!.install.claw;
    source = recorded.kind === "package" ? recorded.packageRoot : recorded.manifestPath;
  }

  const loaded = await readClawManifestFile(source);
  if (!loaded.ok) {
    const diagnostics = opts.from
      ? loaded.diagnostics
      : [
          ...loaded.diagnostics,
          {
            level: "error" as const,
            code: "recorded_source_unavailable",
            phase: "plan" as const,
            path: "$",
            message: "The recorded Claw source is unavailable; pass --from to override it.",
          },
        ];
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: true,
        mutationAllowed: false,
        valid: false,
        diagnostics,
      });
    } else {
      runtime.error(formatDiagnostics(diagnostics));
    }
    runtime.exit(1);
    return;
  }

  const installPolicyAcknowledgement = resolveInstallPolicyAcknowledgementOption(
    opts.dangerouslyForceUnsafeInstall,
  );
  const createPackagePreflight = (acknowledgementIds?: ReadonlyMap<string, string>) =>
    createClawPackagePolicyPreflight({ config, acknowledgementIds });
  const buildPlan = async (packagePreflight: ReturnType<typeof createPackagePreflight>) =>
    await buildClawUpdatePlan({
      agentId: target,
      targetManifest: loaded.manifest,
      targetClawMarkdownBody: loaded.clawMarkdownBody,
      targetOpenClawProfile: loaded.openClawProfile,
      targetSource: loaded.source,
      config,
      sourceMcpServers: listedMcpServers.mcpServers,
      packagePreflight,
      diagnostics: loaded.diagnostics,
    });
  let packagePreflight = createPackagePreflight();
  let plan = await buildPlan(packagePreflight);
  const replay = await replayClawInstallPolicyAcknowledgement({
    initialPlan: plan,
    presentedAcknowledgementId: installPolicyAcknowledgement.installPolicyAcknowledgementId,
    presentedPlanIntegrity: opts.planIntegrity,
    planIntegrity: (candidate) => candidate.planIntegrity,
    replayIdentity: stableStringifyClawPlanReplayIdentity,
    warnings: (candidate) =>
      candidate.actions.flatMap((action) => {
        const warning = action.kind === "package" ? action.installPolicyWarning : undefined;
        return action.action !== "unchanged" &&
          action.action !== "remove" &&
          action.action !== "release" &&
          isInstallPolicyWarning(warning)
          ? [{ packageId: action.id, warning }]
          : [];
      }),
    rebuild: async (acknowledgementIds) =>
      await buildPlan(createPackagePreflight(acknowledgementIds)),
  });
  plan = replay.plan;
  packagePreflight = createPackagePreflight(replay.acknowledgement.packageAcknowledgementIds);
  if (opts.dryRun || plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logExperimentalWarning(runtime);
      runtime.log(
        `Claw update plan: ${plan.currentClaw?.name ?? target} ${plan.currentClaw?.version ?? "unknown"} -> ${plan.targetClaw?.version ?? "unknown"}`,
      );
      runtime.log(`Plan integrity: ${plan.planIntegrity}`);
      logClawUpdatePlanSummary(plan, runtime);
    }
    if (plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
      runtime.exit(1);
    }
    return;
  }

  try {
    const result = await applyClawUpdatePlan(
      plan,
      {
        targetManifest: loaded.manifest,
        targetClawMarkdownBody: loaded.clawMarkdownBody,
        targetOpenClawProfile: loaded.openClawProfile,
        targetSource: loaded.source,
      },
      {
        config,
        ...installPolicyAcknowledgement,
        installPolicyAcknowledgementIds: replay.acknowledgement.packageAcknowledgementIds,
        sourceMcpServers: listedMcpServers.mcpServers,
        consentPlanIntegrity: replay.matched ? plan.planIntegrity : opts.planIntegrity,
        packagePreflight,
        cronGateway: {
          add: async (input) => await callGatewayFromCli("cron.add", {}, input),
          get: async (id) => await callGatewayFromCli("cron.get", {}, { id }),
          remove: async (id) => await callGatewayFromCli("cron.remove", {}, { id }),
        },
      },
    );
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logExperimentalWarning(runtime);
    runtime.log(`Updated agent: ${result.agentId}`);
    runtime.log(`Claw version: ${result.previousClaw.version} -> ${result.targetClaw.version}`);
  } catch (error) {
    const code = error instanceof ClawUpdateMutationError ? error.code : "update_failed";
    const message = error instanceof Error ? error.message : String(error);
    const installPolicyWarning =
      error instanceof ClawUpdateMutationError ? error.installPolicyWarning : undefined;
    const retryPlanIntegrity =
      error instanceof ClawUpdateMutationError ? error.installPolicyRetryPlanIntegrity : undefined;
    const retryCommand =
      retryPlanIntegrity && installPolicyWarning?.acknowledgementId
        ? formatClawInstallPolicyRetryCommand({
            command: "update",
            target,
            planIntegrity: retryPlanIntegrity,
            acknowledgementId: installPolicyWarning.acknowledgementId,
            ...(opts.from ? { from: opts.from } : {}),
          })
        : undefined;
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_UPDATE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: code === "update_partial" ? "partial" : "failed",
        error: {
          code,
          message,
          ...(installPolicyWarning ? { installPolicyWarning } : {}),
          ...(retryPlanIntegrity ? { planIntegrity: retryPlanIntegrity } : {}),
          ...(retryCommand ? { retryCommand } : {}),
        },
      });
    } else {
      logClawInstallPolicyWarning(installPolicyWarning, runtime);
      if (retryPlanIntegrity && retryCommand) {
        logClawInstallPolicyRetry(retryPlanIntegrity, retryCommand, runtime);
      }
      runtime.error(message);
    }
    runtime.exit(1);
  }
}
