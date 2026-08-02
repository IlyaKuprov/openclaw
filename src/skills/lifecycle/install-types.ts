/** Normalized output returned by skill install flows and command wrappers. */
import type { InstallPolicyWarning } from "../../security/install-policy.js";

export type SkillInstallSkipReason = "brew" | "go" | "uv";

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
  installPolicyWarning?: InstallPolicyWarning;
  skipReason?: SkillInstallSkipReason;
  warnings?: string[];
};
