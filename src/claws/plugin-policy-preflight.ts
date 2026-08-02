import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import { encodePluginInstallDirName } from "../plugins/install-paths.js";
import type { InstallPolicyAcknowledgementSequence } from "../plugins/install-security-scan.types.js";
import type { ClawPackage } from "./types.js";

export async function preflightClawPluginPolicyStages(params: {
  probePlugin: typeof installPluginFromClawHub;
  pkg: ClawPackage;
  config: OpenClawConfig;
  mode: "install" | "update";
  pluginId: string;
  integrity: string;
  dangerouslyForceUnsafeInstall?: boolean;
  installPolicyAcknowledgementId?: string;
}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "openclaw-claw-policy-"));
  const extensionsDir = join(tempRoot, "extensions");
  const acknowledgementSequence: InstallPolicyAcknowledgementSequence | undefined =
    params.dangerouslyForceUnsafeInstall && params.installPolicyAcknowledgementId
      ? {
          presentedId: params.installPolicyAcknowledgementId,
          previousAcknowledgementIds: [],
          matched: false,
        }
      : undefined;
  try {
    await mkdir(extensionsDir, { recursive: true });
    if (params.mode === "update") {
      await mkdir(join(extensionsDir, encodePluginInstallDirName(params.pluginId)), {
        recursive: true,
      });
    }
    const result = await params.probePlugin({
      spec: `clawhub:${params.pkg.ref}@${params.pkg.version}`,
      config: params.config,
      mode: params.mode,
      extensionsDir,
      expectedPluginId: params.pluginId,
      expectedIntegrity: params.integrity,
      acknowledgeClawHubRisk: true,
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      installPolicyAcknowledgementId: params.installPolicyAcknowledgementId,
      installPolicyAcknowledgementSequence: acknowledgementSequence,
      emitSuccessSecurityEvent: false,
    });
    return {
      result,
      acknowledgedInstallPolicyWarning: acknowledgementSequence?.matchedWarning,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
