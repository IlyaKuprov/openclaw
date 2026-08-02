import { asNullableRecord as record } from "@openclaw/normalization-core/record-coerce";
import {
  formatInstallPolicyWarning,
  type InstallPolicyWarningFinding,
} from "../../../packages/gateway-protocol/src/install-policy-warning.js";

type ParsedInstallPolicyWarning = {
  message: string;
  acknowledgementId?: string;
};

export function readInstallPolicyWarningDetails(
  error: unknown,
): ParsedInstallPolicyWarning | undefined {
  const warning = record(record(record(error)?.details)?.installPolicyWarning);
  const reason = typeof warning?.reason === "string" ? warning.reason.trim() : "";
  if (!reason) {
    return undefined;
  }
  const findings = Array.isArray(warning?.findings)
    ? warning.findings.map(record).flatMap((value) => {
        const ruleId = typeof value?.ruleId === "string" ? value.ruleId : "";
        const severity = value?.severity;
        const message = typeof value?.message === "string" ? value.message : "";
        if (
          !ruleId ||
          !message ||
          (severity !== "info" && severity !== "warn" && severity !== "critical")
        ) {
          return [];
        }
        const finding: InstallPolicyWarningFinding = {
          ruleId,
          severity,
          message,
          ...(typeof value?.file === "string" ? { file: value.file } : {}),
          ...(typeof value?.line === "number" ? { line: value.line } : {}),
          ...(typeof value?.evidence === "string" ? { evidence: value.evidence } : {}),
        };
        return [finding];
      })
    : [];
  return {
    message: formatInstallPolicyWarning({ reason, ...(findings.length > 0 ? { findings } : {}) }),
    ...(typeof warning?.acknowledgementId === "string"
      ? { acknowledgementId: warning.acknowledgementId }
      : {}),
  };
}
