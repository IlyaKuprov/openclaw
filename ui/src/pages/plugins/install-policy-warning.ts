import { z } from "zod";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  type InstallPolicyWarningErrorDetails,
} from "../../../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import { GatewayRequestError } from "../../api/gateway.ts";

const InstallPolicyFindingSchema = z.object({
  ruleId: z.string().trim().min(1),
  severity: z.enum(["info", "warn", "critical"]),
  message: z.string().trim().min(1),
  file: z.string().trim().min(1).optional(),
  line: z.number().int().positive().optional(),
  evidence: z.string().trim().min(1).optional(),
});

const InstallPolicyWarningDetailsSchema = z.object({
  installPolicyCode: z.literal(INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED),
  targetName: z.string().trim().min(1),
  targetType: z.enum(["skill", "plugin"]),
  requestMode: z.enum(["install", "update"]),
  reason: z.string().trim().min(1),
  findings: z.array(InstallPolicyFindingSchema).optional(),
});

export type PluginInstallPolicyWarningDetails = InstallPolicyWarningErrorDetails;

export function readPluginInstallPolicyWarning(
  error: unknown,
): InstallPolicyWarningErrorDetails | undefined {
  if (!(error instanceof GatewayRequestError)) {
    return undefined;
  }
  const parsed = InstallPolicyWarningDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : undefined;
}
