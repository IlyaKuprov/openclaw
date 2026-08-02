import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstallPolicyWarning } from "../security/install-policy.js";
import { preflightClawPackage } from "./packages.js";
import type { ClawPackage } from "./types.js";

export type ClawPackagePolicyWarning = {
  packageId: string;
  warning: InstallPolicyWarning;
};

export type ClawInstallPolicyAcknowledgement = {
  acknowledgementId?: string;
  packageAcknowledgementIds: ReadonlyMap<string, string>;
  warnings: InstallPolicyWarning[];
};

const MAX_PLAN_REPLAY_STAGES = 32;

export function isInstallPolicyWarning(value: unknown): value is InstallPolicyWarning {
  return (
    typeof value === "object" &&
    value !== null &&
    "reason" in value &&
    typeof value.reason === "string"
  );
}

export function resolveClawInstallPolicyAcknowledgement(
  entries: readonly ClawPackagePolicyWarning[],
): ClawInstallPolicyAcknowledgement {
  const warnings = entries.map((entry) => entry.warning);
  const packageAcknowledgementIds = new Map<string, string>();
  for (const entry of entries) {
    if (entry.warning.acknowledgementId) {
      packageAcknowledgementIds.set(entry.packageId, entry.warning.acknowledgementId);
    }
  }
  const complete = packageAcknowledgementIds.size === entries.length;
  const acknowledgementId = complete
    ? entries.length === 1
      ? entries[0]?.warning.acknowledgementId
      : entries.length > 1
        ? `sha256:${createHash("sha256")
            .update(
              stableStringify(
                entries.map((entry) => ({
                  packageId: entry.packageId,
                  acknowledgementId: entry.warning.acknowledgementId,
                })),
              ),
            )
            .digest("hex")}`
        : undefined
    : undefined;
  return { acknowledgementId, packageAcknowledgementIds, warnings };
}

/**
 * Replays read-only package preflights until it reaches the exact warning plan
 * the caller acknowledged, then consumes that stage once. Later warning IDs
 * include the earlier stage IDs, so replay reconstructs rather than trusts
 * acknowledgement history supplied by the caller.
 */
export async function replayClawInstallPolicyAcknowledgement<TPlan>(params: {
  initialPlan: TPlan;
  presentedAcknowledgementId?: string;
  presentedPlanIntegrity?: string;
  planIntegrity: (plan: TPlan) => string;
  replayIdentity: (plan: TPlan) => string;
  warnings: (plan: TPlan) => readonly ClawPackagePolicyWarning[];
  rebuild: (acknowledgementIds: ReadonlyMap<string, string>) => Promise<TPlan>;
}): Promise<{
  plan: TPlan;
  acknowledgement: ClawInstallPolicyAcknowledgement;
  matched: boolean;
}> {
  const initialAcknowledgement = resolveClawInstallPolicyAcknowledgement(
    params.warnings(params.initialPlan),
  );
  if (!params.presentedAcknowledgementId || !params.presentedPlanIntegrity) {
    return {
      plan: params.initialPlan,
      acknowledgement: initialAcknowledgement,
      matched: false,
    };
  }

  let plan = params.initialPlan;
  const seen = new Set<string>();
  const accumulatedAcknowledgementIds = new Map<string, string>();
  for (let stage = 0; stage < MAX_PLAN_REPLAY_STAGES; stage += 1) {
    const acknowledgement = resolveClawInstallPolicyAcknowledgement(params.warnings(plan));
    if (!acknowledgement.acknowledgementId) {
      break;
    }
    const integrity = params.planIntegrity(plan);
    const replayKey = `${integrity}\0${acknowledgement.acknowledgementId}`;
    if (seen.has(replayKey)) {
      break;
    }
    seen.add(replayKey);

    const matched =
      integrity === params.presentedPlanIntegrity &&
      acknowledgement.acknowledgementId === params.presentedAcknowledgementId;
    for (const [packageId, acknowledgementId] of acknowledgement.packageAcknowledgementIds) {
      accumulatedAcknowledgementIds.set(packageId, acknowledgementId);
    }
    const nextPlan = await params.rebuild(new Map(accumulatedAcknowledgementIds));
    if (matched) {
      if (params.replayIdentity(nextPlan) === params.replayIdentity(plan)) {
        return {
          plan: nextPlan,
          acknowledgement: {
            ...acknowledgement,
            packageAcknowledgementIds: new Map(accumulatedAcknowledgementIds),
          },
          matched: true,
        };
      }
      return {
        plan: nextPlan,
        acknowledgement: resolveClawInstallPolicyAcknowledgement(params.warnings(nextPlan)),
        matched: false,
      };
    }
    plan = nextPlan;
  }

  return {
    plan: params.initialPlan,
    acknowledgement: initialAcknowledgement,
    matched: false,
  };
}

export function createClawPackagePolicyPreflight(params: {
  config: OpenClawConfig;
  acknowledgementIds?: ReadonlyMap<string, string>;
  preflight?: typeof preflightClawPackage;
}) {
  const preflight = params.preflight ?? preflightClawPackage;
  return async (pkg: ClawPackage, workspace: string, mode: "install" | "update") => {
    const acknowledgementId = params.acknowledgementIds?.get(`${pkg.kind}:${pkg.ref}`);
    return await preflight(pkg, workspace, {
      config: params.config,
      mode,
      ...(acknowledgementId
        ? {
            dangerouslyForceUnsafeInstall: true,
            installPolicyAcknowledgementId: acknowledgementId,
          }
        : {}),
    });
  };
}
