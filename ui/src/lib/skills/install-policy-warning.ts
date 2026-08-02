import { formatErrorMessage } from "@openclaw/normalization-core";
import {
  ClawHubTrustErrorCodes,
  readClawHubTrustErrorDetails,
} from "../../../../packages/gateway-protocol/src/clawhub-trust-error-details.js";
import { redactToolDetail } from "../browser-redact.ts";
import { readInstallPolicyWarningDetails } from "../install-policy-warning.ts";

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
  acknowledgeInstallPolicyWarning?: {
    name: string;
    installId: string;
    acknowledgementId: string;
  };
};

export type ClawHubInstallMessage = {
  kind: "success" | "error";
  text: string;
  acknowledgeSlug?: string;
  acknowledgeVersion?: string;
  acknowledgeLabel?: string;
  acknowledgeClawHubRisk?: boolean;
  installPolicyAcknowledgementId?: string;
};

export function installPolicyAcknowledgementParams(acknowledgementId?: string) {
  return acknowledgementId ? { acknowledgeInstallPolicyWarning: acknowledgementId } : {};
}

export function readSkillInstallPolicyWarning(
  error: unknown,
  params: { name: string; installId: string },
): SkillMessage | undefined {
  const warning = readInstallPolicyWarningDetails(error);
  if (!warning) {
    return undefined;
  }
  return {
    kind: "error",
    message: warning.message,
    ...(warning.acknowledgementId
      ? {
          acknowledgeInstallPolicyWarning: {
            ...params,
            acknowledgementId: warning.acknowledgementId,
          },
        }
      : {}),
  };
}

export const formatClawHubInstallMessage = (message: string, warning?: string): string =>
  warning ? `${message}\n\n${warning}` : message;

export function readClawHubInstallFailure(
  error: unknown,
  params: { slug: string; version?: string; acknowledgeClawHubRisk: boolean },
): ClawHubInstallMessage {
  const details =
    error && typeof error === "object" && "details" in error
      ? readClawHubTrustErrorDetails((error as { details?: unknown }).details)
      : undefined;
  const warning = readInstallPolicyWarningDetails(error);
  const needsRiskAcknowledgement =
    details?.clawhubTrustCode === ClawHubTrustErrorCodes.RISK_ACKNOWLEDGEMENT_REQUIRED;
  const warningVersion = params.version ?? details?.version;
  return {
    kind: "error",
    text:
      warning?.message ??
      formatClawHubInstallMessage(
        needsRiskAcknowledgement
          ? "Review the ClawHub warning before installing this skill."
          : formatErrorMessage(error, { redact: redactToolDetail }),
        details?.warning,
      ),
    ...(needsRiskAcknowledgement || warning ? { acknowledgeSlug: params.slug } : {}),
    ...((needsRiskAcknowledgement && details?.version) || (warning && warningVersion)
      ? { acknowledgeVersion: needsRiskAcknowledgement ? details?.version : warningVersion }
      : {}),
    ...(needsRiskAcknowledgement ? { acknowledgeLabel: "Acknowledge risk and install" } : {}),
    ...(warning?.acknowledgementId
      ? {
          acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
          installPolicyAcknowledgementId: warning.acknowledgementId,
        }
      : {}),
  };
}
