import type { ClawUpdatePlan } from "../claws/update-plan.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";
import { logClawInstallPolicyWarnings } from "./claws-cli-install-policy-output.js";

export function logClawUpdatePlanSummary(plan: ClawUpdatePlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agentId}`);
  runtime.log(`Update actions: ${plan.summary.totalActions}`);
  runtime.log(
    `Add: ${plan.summary.added}; change: ${plan.summary.changed}; remove: ${plan.summary.removed}; release: ${plan.summary.released}; unchanged: ${plan.summary.unchanged}; manual: ${plan.summary.manual}`,
  );
  runtime.log(
    `Capability changes: ${plan.summary.capabilityChanges}; escalations requiring explicit review: ${plan.summary.capabilityEscalations}`,
  );
  runtime.log(`Plan integrity: ${plan.planIntegrity}`);
  logClawInstallPolicyWarnings(
    plan.actions.flatMap((action) =>
      action.kind === "package" &&
      action.action !== "unchanged" &&
      action.action !== "remove" &&
      action.action !== "release" &&
      action.installPolicyWarning
        ? [{ packageId: action.id, warning: action.installPolicyWarning }]
        : [],
    ),
    runtime,
  );
  if (plan.summary.capabilityEscalations > 0) {
    runtime.log(
      "Capability consent: the exact plan-integrity token binds every ! change disclosed below.",
    );
  }
  for (const change of plan.capabilityChanges) {
    const current = change.current?.summary ?? "unset";
    const desired = change.desired?.summary ?? "unset";
    runtime.log(
      `  ${change.requiresDistinctConsent ? "!" : "-"} ${change.path}: ${current} -> ${desired} (${change.action})`,
    );
    runtime.log(redactSensitiveText(`      effect: ${JSON.stringify(change.effect)}`));
  }
  if (plan.blockers.length > 0) {
    runtime.error(
      plan.blockers
        .map(
          (diagnostic) =>
            `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }
}
