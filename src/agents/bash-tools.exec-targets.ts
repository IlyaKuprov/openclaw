import type { ExecTarget } from "../infra/exec-approvals.js";

/**
 * Project targets authorized by the configured exec policy for this prepared
 * sandbox context. This does not assert live endpoint reachability.
 */
export function resolveAllowedExecTargets(params: {
  configuredTarget?: ExecTarget;
  sandboxAvailable: boolean;
}): readonly ExecTarget[] {
  const configuredTarget = params.configuredTarget ?? "auto";
  if (configuredTarget === "auto") {
    return params.sandboxAvailable ? ["auto", "sandbox"] : ["auto", "gateway", "node"];
  }
  return configuredTarget === "sandbox" && !params.sandboxAvailable ? [] : [configuredTarget];
}
