import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import type { ClawHubRiskAcknowledgementRequest } from "./clawhub.js";
import type { DeferredInstallPolicyMismatch } from "./install-policy-acknowledgement.js";
import type { InstallPolicyAcknowledgementSequence } from "./install-security-scan.types.js";
import type {
  PluginUpdateIntegrityDriftParams,
  PluginUpdateLogger,
  PluginUpdateOutcome,
} from "./update-source.js";

export type PluginUpdateSummary = {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
  installPolicyAcknowledgementMatched?: boolean;
  deferredInstallPolicyMismatch?: DeferredInstallPolicyMismatch<PluginUpdateOutcome>;
};

export type UpdateNpmInstalledPluginsParams = {
  config: OpenClawConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  skipDisabledPlugins?: boolean;
  syncOfficialPluginInstalls?: boolean;
  disableOnFailure?: boolean;
  timeoutMs?: number;
  dryRun?: boolean;
  updateChannel?: UpdateChannel;
  officialPluginUpdateChannel?: UpdateChannel;
  coreVersion?: string;
  dangerouslyForceUnsafeInstall?: boolean;
  installPolicyAcknowledgementId?: string;
  installPolicyAcknowledgementSequence?: InstallPolicyAcknowledgementSequence;
  deferInstallPolicyAcknowledgementMismatch?: boolean;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
};
