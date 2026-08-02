import { formatInstallPolicyWarning } from "../../packages/gateway-protocol/src/install-policy-warning.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { InstallPolicyWarning } from "../security/install-policy.js";
import type { WizardPrompter } from "./prompts.js";

export async function confirmInstallPolicyWarning(
  prompter: WizardPrompter,
  label: string,
  warning: InstallPolicyWarning,
): Promise<boolean> {
  const details = formatInstallPolicyWarning(warning)
    .split("\n")
    .map(sanitizeTerminalText)
    .join("\n");
  return await prompter.confirm({
    message: `${details}\n\nInstall "${sanitizeTerminalText(label)}" after reviewing this warning?`,
    initialValue: false,
  });
}
