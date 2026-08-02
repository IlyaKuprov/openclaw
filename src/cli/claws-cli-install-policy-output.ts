import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  resolveClawInstallPolicyAcknowledgement,
  type ClawPackagePolicyWarning,
} from "../claws/install-policy-acknowledgement.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { quoteCliArg } from "./quote-cli-arg.js";

type ClawInstallPolicyRetry = {
  command: "add" | "update";
  target: string;
  planIntegrity: string;
  acknowledgementId: string;
  from?: string;
  agentId?: string;
  workspace?: string;
};

export function formatClawInstallPolicyRetryCommand(params: ClawInstallPolicyRetry): string {
  const args = ["openclaw", "claws", params.command, params.target];
  if (params.from) {
    args.push("--from", params.from);
  }
  if (params.agentId) {
    args.push("--agent-id", params.agentId);
  }
  if (params.workspace) {
    args.push("--workspace", params.workspace);
  }
  args.push(
    "--yes",
    "--plan-integrity",
    params.planIntegrity,
    "--dangerously-force-unsafe-install",
    params.acknowledgementId,
  );
  return formatCliCommand(args.map(quoteCliArg).join(" "));
}

export function logClawInstallPolicyRetry(
  planIntegrity: string,
  retryCommand: string,
  runtime: RuntimeEnv,
): void {
  runtime.log(`Plan integrity: ${planIntegrity}`);
  runtime.log(`Retry: ${retryCommand}`);
}

function logWarning(value: unknown, runtime: RuntimeEnv, includeAcknowledgement: boolean): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !("reason" in value) ||
    typeof value.reason !== "string"
  ) {
    return;
  }
  runtime.log(sanitizeTerminalText(`Install policy warning: ${redactSensitiveText(value.reason)}`));
  const findings = "findings" in value && Array.isArray(value.findings) ? value.findings : [];
  for (const finding of findings) {
    if (typeof finding !== "object" || finding === null) {
      continue;
    }
    const ruleId = "ruleId" in finding && typeof finding.ruleId === "string" ? finding.ruleId : "?";
    const severity =
      "severity" in finding && typeof finding.severity === "string" ? finding.severity : "warn";
    const message =
      "message" in finding && typeof finding.message === "string" ? finding.message : "Finding";
    runtime.log(
      sanitizeTerminalText(redactSensitiveText(`  - [${severity}] ${ruleId}: ${message}`)),
    );
  }
  if (
    includeAcknowledgement &&
    "acknowledgementId" in value &&
    typeof value.acknowledgementId === "string"
  ) {
    runtime.log(`Install policy acknowledgement: ${value.acknowledgementId}`);
  }
}

export function logClawInstallPolicyWarning(value: unknown, runtime: RuntimeEnv): void {
  logWarning(value, runtime, true);
}

export function logClawInstallPolicyWarnings(
  warnings: readonly ClawPackagePolicyWarning[],
  runtime: RuntimeEnv,
): void {
  for (const entry of warnings) {
    logWarning(entry.warning, runtime, false);
  }
  const acknowledgementId = resolveClawInstallPolicyAcknowledgement(warnings).acknowledgementId;
  if (acknowledgementId) {
    runtime.log(`Install policy acknowledgement: ${acknowledgementId}`);
  }
}
