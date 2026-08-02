// Defines plugin install security scan result types.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstallPolicyWarning } from "../security/install-policy.js";

export type InstallPolicyAcknowledgementSequence = {
  presentedId: string;
  pendingAcknowledgementIds?: string[];
  previousAcknowledgementIds: string[];
  matched: boolean;
  matchedWarning?: InstallPolicyWarning;
  deferred?: {
    warning: InstallPolicyWarning;
    reason: string;
  };
};

/** Overrides that intentionally loosen install safety policy for trusted/operator paths. */
export type InstallSafetyOverrides = {
  config?: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  installPolicyAcknowledgementId?: string;
  installPolicyAcknowledgementSequence?: InstallPolicyAcknowledgementSequence;
  trustedSourceLinkedOfficialInstall?: boolean;
};
