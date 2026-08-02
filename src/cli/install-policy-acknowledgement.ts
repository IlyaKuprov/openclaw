import type { Command, ParseOptionsResult } from "commander";

const INSTALL_POLICY_ACK_FLAG = "--dangerously-force-unsafe-install";
const INSTALL_POLICY_ACK_ID_PATTERN = /^sha256:[0-9a-f]{64}(?:,sha256:[0-9a-f]{64}){0,31}$/u;
const INSTALL_POLICY_ARGV_PATCHED = Symbol("installPolicyArgvPatched");

export type InstallPolicyAcknowledgementOption = boolean | string | undefined;

function preserveBareAcknowledgementFlag(argv: readonly string[]): string[] {
  const optionTerminatorIndex = argv.indexOf("--");
  return argv.map((arg, index) => {
    if (optionTerminatorIndex >= 0 && index > optionTerminatorIndex) {
      return arg;
    }
    if (arg !== INSTALL_POLICY_ACK_FLAG) {
      return arg;
    }
    const next = argv[index + 1];
    return next && INSTALL_POLICY_ACK_ID_PATTERN.test(next)
      ? arg
      : `${INSTALL_POLICY_ACK_FLAG}=true`;
  });
}

export function preserveBareInstallPolicyAcknowledgementFlag(program: Command): void {
  const patchedProgram = program as Command & { [INSTALL_POLICY_ARGV_PATCHED]?: boolean };
  if (patchedProgram[INSTALL_POLICY_ARGV_PATCHED]) {
    return;
  }
  const parseOptions = program.parseOptions.bind(program);
  program.parseOptions = (argv: string[]): ParseOptionsResult =>
    parseOptions(preserveBareAcknowledgementFlag(argv));
  patchedProgram[INSTALL_POLICY_ARGV_PATCHED] = true;
}

export function resolveInstallPolicyAcknowledgementOption(
  value: InstallPolicyAcknowledgementOption,
): {
  dangerouslyForceUnsafeInstall?: true;
  installPolicyAcknowledgementId?: string;
} {
  if (!value) {
    return {};
  }
  const acknowledgementId = typeof value === "string" && value !== "true" ? value : undefined;
  return {
    dangerouslyForceUnsafeInstall: true,
    ...(acknowledgementId ? { installPolicyAcknowledgementId: acknowledgementId } : {}),
  };
}

export function appendInstallPolicyAcknowledgementFlag(
  message: string,
  installPolicyWarning: unknown,
): string {
  if (!installPolicyWarning) {
    return message;
  }
  const acknowledgementId =
    typeof installPolicyWarning === "object" &&
    installPolicyWarning !== null &&
    "acknowledgementId" in installPolicyWarning &&
    typeof installPolicyWarning.acknowledgementId === "string"
      ? installPolicyWarning.acknowledgementId
      : undefined;
  const flag = acknowledgementId
    ? `${INSTALL_POLICY_ACK_FLAG} ${acknowledgementId}`
    : INSTALL_POLICY_ACK_FLAG;
  if (message.includes(flag)) {
    return message;
  }
  if (acknowledgementId && message.includes(INSTALL_POLICY_ACK_FLAG)) {
    return message.replace(INSTALL_POLICY_ACK_FLAG, flag);
  }
  if (message.includes(INSTALL_POLICY_ACK_FLAG)) {
    return message;
  }
  return `${message} Re-run with ${flag} after reviewing the findings.`;
}
