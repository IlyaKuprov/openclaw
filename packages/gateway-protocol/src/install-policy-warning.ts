export type InstallPolicyWarningFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
};

export type InstallPolicyWarningDetails = {
  reason: string;
  findings?: InstallPolicyWarningFinding[];
  acknowledgementId?: string;
};

export function formatInstallPolicyWarning(warning: InstallPolicyWarningDetails): string {
  return [
    warning.reason,
    ...(warning.findings ?? []).map((finding) => {
      const location = finding.file
        ? ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`
        : "";
      const evidence = finding.evidence ? ` — ${finding.evidence}` : "";
      return `- [${finding.severity}] ${finding.ruleId}: ${finding.message}${location}${evidence}`;
    }),
  ].join("\n");
}
