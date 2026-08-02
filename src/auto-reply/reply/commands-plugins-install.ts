import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { resolvePluginInstallSourcePlan } from "../../cli/plugin-install-plan.js";
import { createPluginInstallLogger } from "../../cli/plugins-command-helpers.js";
import { quoteCliArg } from "../../cli/quote-cli-arg.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../../plugins/clawhub.js";
import type { ConfigSnapshotForInstallPersist } from "../../plugins/install-persistence.js";
import {
  formatNonClawHubInstallWarning,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  type NonClawHubInstallSourceClass,
} from "../../plugins/install-provenance.js";
import { installManagedPluginSource } from "../../plugins/management-service.js";
import {
  projectInstallPolicyWarningForExternal,
  type InstallPolicyWarning,
} from "../../security/install-policy.js";

function formatInstallPolicyWarningForChat(warning: InstallPolicyWarning): string {
  const externalWarning = projectInstallPolicyWarningForExternal(warning);
  return [
    `Install policy warning: ${externalWarning.reason}`,
    ...(externalWarning.findings ?? []).map((finding) => {
      const location = finding.file
        ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
        : "";
      return `- [${finding.severity}] ${finding.ruleId}: ${finding.message}${location}${finding.evidence ? ` — ${finding.evidence}` : ""}`;
    }),
  ]
    .map((line) => sanitizeTerminalText(redactSensitiveText(line)))
    .join("\n");
}

function resolveNonClawHubChatInstallAcknowledgement(params: {
  force: boolean;
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): { ok: true; warning: string } | { ok: false; error: string } {
  const warning = formatNonClawHubInstallWarning(params);
  if (params.force) {
    return { ok: true, warning };
  }
  return {
    ok: false,
    error: `${warning}\nReview the source, then rerun this chat command with ${NON_CLAWHUB_INSTALL_FORCE_FLAG} to continue.`,
  };
}

export async function installPluginFromPluginsCommand(params: {
  raw: string;
  force: boolean;
  snapshot: ConfigSnapshotForInstallPersist;
}): Promise<
  { ok: true; pluginId: string; warnings?: readonly string[] } | { ok: false; error: string }
> {
  const installMode = params.force ? "update" : "install";
  const plan = resolvePluginInstallSourcePlan({ raw: params.raw, mode: installMode });
  if (!plan.ok) {
    return { ok: false, error: plan.error.replace(/^Plugin path not found:/, "Path not found:") };
  }
  const acknowledgement = plan.acknowledgement
    ? resolveNonClawHubChatInstallAcknowledgement({
        force: params.force,
        ...plan.acknowledgement,
      })
    : null;
  if (acknowledgement && !acknowledgement.ok) {
    return acknowledgement;
  }
  const warnings: string[] = [];
  const logger = createPluginInstallLogger();
  const clawhub = plan.request.source === "clawhub";
  const result = await installManagedPluginSource({
    request: plan.request,
    snapshot: params.snapshot,
    logger: clawhub
      ? {
          info: logger.info,
          warn: (message) => {
            warnings.push(stripAnsi(message));
            logger.warn(message);
          },
          terminalLinks: false,
        }
      : logger,
  });
  if (!result.ok) {
    if (result.installPolicyWarning) {
      const requestedSpec = quoteCliArg(
        sanitizeTerminalText(redactSensitiveText(params.raw.trim())),
      );
      const sourceAcknowledgement = plan.acknowledgement
        ? ` ${NON_CLAWHUB_INSTALL_FORCE_FLAG}`
        : "";
      return {
        ok: false,
        error:
          `${formatInstallPolicyWarningForChat(result.installPolicyWarning)}\n\n` +
          "The /plugins chat command cannot acknowledge install-policy warnings. " +
          `After reviewing the findings, run \`openclaw plugins install ${requestedSpec}${sourceAcknowledgement} --dangerously-force-unsafe-install${result.installPolicyWarning.acknowledgementId ? ` ${result.installPolicyWarning.acknowledgementId}` : ""}\` from a trusted shell.`,
      };
    }
    const warning = "warning" in result ? result.warning : warnings.join("\n");
    const warningPrefix = warning ? `${warning} ` : "";
    if (
      clawhub &&
      result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED
    ) {
      return {
        ok: false,
        error: `${warningPrefix}${result.error} The /plugins chat command cannot acknowledge ClawHub risk; run the local openclaw plugins install command with --acknowledge-clawhub-risk from a trusted shell after reviewing the warning.`,
      };
    }
    return { ok: false, error: `${warningPrefix}${result.error}` };
  }
  warnings.push(...(result.warnings ?? []));
  if (acknowledgement?.ok) {
    warnings.push(acknowledgement.warning);
  }
  return {
    ok: true,
    pluginId: result.pluginId,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
