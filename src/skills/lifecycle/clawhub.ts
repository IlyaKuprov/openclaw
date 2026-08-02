// ClawHub lifecycle facade: public API plus install/update coordination.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ClawHubRiskAcknowledgementRequest,
  ClawHubTrustErrorCode,
} from "../../infra/clawhub-install-trust.js";
import {
  downloadClawHubSkillArchive,
  isDefaultClawHubBaseUrl,
  normalizeClawHubSha256Integrity,
  resolveClawHubBaseUrl,
} from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import {
  resolveInstallPolicyAcknowledgementSequence,
  unresolvedInstallPolicyAcknowledgement,
} from "../../plugins/install-policy-acknowledgement.js";
import {
  isInstallPolicyEnabledForTarget,
  type InstallPolicyWarning,
} from "../../security/install-policy.js";
import { withClawPackageLifecycleLease } from "../../state/claw-package-lifecycle-lease.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
  normalizeTrackedSkillSlug,
  resolveWorkspaceSkillInstallDir,
  validateRequestedSkillSlug,
} from "./archive-install.js";
import {
  ensureClawHubSkillTrustAcknowledged,
  isDefaultOfficialClawHubSkillSource,
  normalizeExpectedArtifactIntegrity,
  performClawHubSkillInstall,
  resolveInstallVersion,
  type ClawHubInstallParams,
  type InstallClawHubSkillResult,
  type Logger,
} from "./clawhub-install-core.js";
import { resolveClawHubSkillStatusLinkSync } from "./clawhub-status.js";
import {
  parseRequestedClawHubSkillRef,
  readClawHubSkillOrigin,
  readClawHubSkillsLockfile,
  type ClawHubSkillRef,
  type ClawHubSkillsLockfile,
} from "./clawhub-store.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

export { readVerifiedClawHubSkillSourceUrl } from "./clawhub-install-core.js";
export {
  readLocalSkillCardContentSync,
  resolveClawHubSkillStatusLinkSync,
  resolveClawHubSkillVerificationTarget,
  resolveLocalSkillCardStatusSync,
  searchSkillsFromClawHub,
  type ClawHubSkillStatusLink,
  type LocalSkillCardStatus,
} from "./clawhub-status.js";
export {
  readClawHubSkillsLockfileStatusSync,
  readTrackedClawHubSkillSlugs,
  untrackClawHubSkill,
  type ClawHubSkillsLockfileStatusRead,
} from "./clawhub-store.js";

type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      repaired?: boolean;
      targetDir: string;
      warning?: string;
    }
  | Extract<InstallClawHubSkillResult, { ok: false; code?: ClawHubTrustErrorCode }>;

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      ownerHandle?: string;
      requestedReference?: string;
      trustState?: ClawHubInstallParams["trustState"];
      baseUrl?: string;
      previousVersion: string | null;
      currentVersionHealthy: boolean;
    }
  | { ok: false; slug: string; error: string };

type ClawHubSkillInstallPreflightResult =
  | {
      ok: true;
      action: "install" | "reuse";
      integrity: string;
      warning?: string;
      installPolicyWarning?: InstallPolicyWarning;
    }
  | { ok: false; code: string; error: string };

async function preflightDownloadedSkillPolicy(params: {
  archivePath: string;
  authority: "official" | "openclaw" | "third-party";
  baseUrl?: string;
  config: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  installPolicyAcknowledgementId?: string;
  logger?: Logger;
  mode: "install" | "update";
  requested: ClawHubSkillRef;
  requestedLabel: string;
  version: string;
  workspaceDir: string;
}): Promise<
  { ok: true; warning?: InstallPolicyWarning } | { ok: false; code: string; error: string }
> {
  const registry = resolveClawHubBaseUrl(params.baseUrl);
  const acknowledgementSequence = resolveInstallPolicyAcknowledgementSequence(params);
  const scan = await withExtractedArchiveRoot({
    archivePath: params.archivePath,
    tempDirPrefix: "openclaw-skill-clawhub-preflight-",
    timeoutMs: 120_000,
    logger: params.logger,
    rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
    onExtracted: async (rootDir) =>
      await installExtractedSkillRoot({
        workspaceDir: params.workspaceDir,
        slug: params.requested.slug,
        extractedRoot: rootDir,
        mode: params.mode,
        logger: params.logger,
        scanOnly: true,
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
        policy: {
          config: params.config,
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          installPolicyAcknowledgementId: params.installPolicyAcknowledgementId,
          installPolicyAcknowledgementSequence: acknowledgementSequence,
          installId: "clawhub",
          origin: {
            type: "clawhub",
            registry,
            slug: params.requested.slug,
            ...(params.requested.ownerHandle ? { ownerHandle: params.requested.ownerHandle } : {}),
            version: params.version,
          },
          source: {
            kind: "clawhub",
            authority: params.authority,
            mutable: false,
            network: true,
          },
          requestedSpecifier: `clawhub:${params.requestedLabel}@${params.version}`,
        },
      }),
  });
  const unresolvedAcknowledgement = unresolvedInstallPolicyAcknowledgement(acknowledgementSequence);
  if (unresolvedAcknowledgement) {
    return { ok: true, warning: unresolvedAcknowledgement.warning };
  }
  if (scan.ok) {
    return {
      ok: true,
      ...(acknowledgementSequence?.matchedWarning
        ? { warning: acknowledgementSequence.matchedWarning }
        : {}),
    };
  }
  const warning = "installPolicyWarning" in scan ? scan.installPolicyWarning : undefined;
  if (warning) {
    return { ok: true, warning };
  }
  const failed = "failureKind" in scan && scan.failureKind === "unavailable";
  return {
    ok: false,
    code: failed ? "security_scan_failed" : "security_scan_blocked",
    error: scan.error,
  };
}

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  lock: ClawHubSkillsLockfile;
}): Promise<string> {
  const requested = params.requestedSlug.trim();
  const requestedRef =
    requested.startsWith("@") || requested.startsWith("skills-sh:")
      ? parseRequestedClawHubSkillRef(requested)
      : { slug: normalizeTrackedSkillSlug(requested) };
  const trackedSlug = requestedRef.slug;
  const trackedOrigin = await readClawHubSkillOrigin(
    resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug),
  );
  const trackedLockEntry = params.lock.skills[trackedSlug];
  if (!trackedOrigin && !trackedLockEntry) {
    return validateRequestedSkillSlug(requestedRef.slug);
  }
  const trackedOwnerHandle = trackedOrigin?.ownerHandle ?? trackedLockEntry?.ownerHandle;
  if (requestedRef.ownerHandle && trackedOwnerHandle !== requestedRef.ownerHandle) {
    const trackedRef = trackedOwnerHandle ? `@${trackedOwnerHandle}/${trackedSlug}` : trackedSlug;
    throw new Error(
      `Skill "${trackedSlug}" is tracked as ${trackedRef}, not @${requestedRef.ownerHandle}/${trackedSlug}.`,
    );
  }
  const trackedRequestedReference =
    trackedOrigin?.requestedReference ?? trackedLockEntry?.requestedReference;
  if (
    requestedRef.requestedReference &&
    trackedRequestedReference !== requestedRef.requestedReference
  ) {
    throw new Error(
      `Skill "${trackedSlug}" is not tracked from ${requestedRef.requestedReference}.`,
    );
  }
  return trackedSlug;
}

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const ref = parseRequestedClawHubSkillRef(params.slug);
    if (ref.requestedReference && params.version) {
      throw new Error("--version is not supported for skills-sh references.");
    }
    return await performClawHubSkillInstall({
      ...params,
      slug: ref.slug,
      ...(ref.ownerHandle ? { ownerHandle: ref.ownerHandle } : {}),
      ...(ref.requestedReference ? { requestedReference: ref.requestedReference } : {}),
      ...(ref.trustState ? { trustState: ref.trustState } : {}),
    });
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

async function installTrackedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: normalizeTrackedSkillSlug(params.slug),
    });
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

async function preflightSkillOwnerState(params: {
  workspaceDir: string;
  requested: ClawHubSkillRef;
  requestedLabel: string;
  version: string;
  integrity: string;
}): Promise<ClawHubSkillInstallPreflightResult> {
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.requested.slug);
  if (!(await pathExists(targetDir))) {
    return { ok: true, action: "install", integrity: params.integrity };
  }
  const status = resolveClawHubSkillStatusLinkSync({
    workspaceDir: params.workspaceDir,
    skillDir: targetDir,
    skillKey: params.requested.slug,
  });
  if (
    status?.status === "linked" &&
    status.installedVersion === params.version &&
    status.ownerHandle === params.requested.ownerHandle &&
    status.artifact?.integrity === params.integrity
  ) {
    return { ok: true, action: "reuse", integrity: params.integrity };
  }
  return {
    ok: false,
    code: "skill_version_conflict",
    error: `Skill ${params.requestedLabel}@${params.version} conflicts with the existing workspace skill at ${targetDir}.`,
  };
}

export async function preflightSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version: string;
  expectedIntegrity?: string;
  baseUrl?: string;
  config?: OpenClawConfig;
  acknowledgeClawHubRisk?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  installPolicyAcknowledgementId?: string;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: Logger;
  mode?: "install" | "update";
}): Promise<ClawHubSkillInstallPreflightResult> {
  try {
    const policyConfig = params.config;
    const requested = parseRequestedClawHubSkillRef(params.slug);
    const resolved = await resolveInstallVersion({
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: params.version,
      baseUrl: params.baseUrl,
    });
    if (resolved.version !== params.version) {
      return {
        ok: false,
        code: "skill_version_resolution_mismatch",
        error: `Skill ${params.slug}@${params.version} resolved to ${resolved.version}.`,
      };
    }
    const authority = isDefaultOfficialClawHubSkillSource({
      baseUrl: params.baseUrl,
      detail: resolved.detail,
    })
      ? "official"
      : isDefaultClawHubBaseUrl(params.baseUrl)
        ? "openclaw"
        : "third-party";
    const trust = await ensureClawHubSkillTrustAcknowledged({
      workspaceDir: params.workspaceDir,
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: resolved.version,
      baseUrl: params.baseUrl,
      acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
      onClawHubRisk: params.onClawHubRisk,
      logger: params.logger,
      skipClawHubTrustCheck: isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        detail: resolved.detail,
      }),
    });
    if (!trust.ok) {
      return {
        ok: false,
        code: trust.code ?? "skill_trust_required",
        error: trust.error,
      };
    }

    if (params.expectedIntegrity) {
      const integrity = normalizeExpectedArtifactIntegrity(params.expectedIntegrity);
      const owner = await preflightSkillOwnerState({
        workspaceDir: params.workspaceDir,
        requested,
        requestedLabel: params.slug,
        version: resolved.version,
        integrity,
      });
      if (
        !owner.ok ||
        owner.action === "reuse" ||
        !policyConfig ||
        !isInstallPolicyEnabledForTarget(policyConfig, "skill")
      ) {
        return owner.ok && trust.warning ? { ...owner, warning: trust.warning } : owner;
      }
      const archive = await downloadClawHubSkillArchive({
        slug: requested.slug,
        ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
        version: resolved.version,
        baseUrl: params.baseUrl,
      });
      try {
        if (normalizeClawHubSha256Integrity(archive.integrity) !== integrity) {
          return {
            ok: false,
            code: "skill_integrity_mismatch",
            error: `Skill ${params.slug}@${params.version} resolved a different artifact integrity during policy preflight.`,
          };
        }
        const policy = await preflightDownloadedSkillPolicy({
          archivePath: archive.archivePath,
          authority,
          baseUrl: params.baseUrl,
          config: policyConfig,
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          installPolicyAcknowledgementId: params.installPolicyAcknowledgementId,
          logger: params.logger,
          mode: params.mode ?? "install",
          requested,
          requestedLabel: params.slug,
          version: resolved.version,
          workspaceDir: params.workspaceDir,
        });
        if (!policy.ok) {
          return policy;
        }
        return {
          ...owner,
          ...(trust.warning ? { warning: trust.warning } : {}),
          ...(policy.warning ? { installPolicyWarning: policy.warning } : {}),
        };
      } finally {
        await archive.cleanup().catch(() => undefined);
      }
    }

    const archive = await downloadClawHubSkillArchive({
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: resolved.version,
      baseUrl: params.baseUrl,
    });
    try {
      const integrity = normalizeClawHubSha256Integrity(archive.integrity);
      if (!integrity) {
        return {
          ok: false,
          code: "skill_integrity_unavailable",
          error: `Skill ${params.slug}@${params.version} did not resolve a valid artifact integrity.`,
        };
      }
      const owner = await preflightSkillOwnerState({
        workspaceDir: params.workspaceDir,
        requested,
        requestedLabel: params.slug,
        version: resolved.version,
        integrity,
      });
      if (
        !owner.ok ||
        owner.action === "reuse" ||
        !policyConfig ||
        !isInstallPolicyEnabledForTarget(policyConfig, "skill")
      ) {
        return owner.ok && trust.warning ? { ...owner, warning: trust.warning } : owner;
      }
      const policy = await preflightDownloadedSkillPolicy({
        archivePath: archive.archivePath,
        authority,
        baseUrl: params.baseUrl,
        config: policyConfig,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        installPolicyAcknowledgementId: params.installPolicyAcknowledgementId,
        logger: params.logger,
        mode: params.mode ?? "install",
        requested,
        requestedLabel: params.slug,
        version: resolved.version,
        workspaceDir: params.workspaceDir,
      });
      if (!policy.ok) {
        return policy;
      }
      return {
        ...owner,
        ...(trust.warning ? { warning: trust.warning } : {}),
        ...(policy.warning ? { installPolicyWarning: policy.warning } : {}),
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, code: "skill_preflight_failed", error: formatErrorMessage(err) };
  }
}

async function resolveTrackedUpdateTarget(params: {
  workspaceDir: string;
  slug: string;
  lock: ClawHubSkillsLockfile;
  baseUrl?: string;
}): Promise<TrackedUpdateTarget> {
  const origin = await readClawHubSkillOrigin(
    resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug),
  );
  const lockEntry = params.lock.skills[params.slug];
  if (!origin && !lockEntry) {
    return {
      ok: false,
      slug: params.slug,
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
    };
  }
  const ownerHandle = origin?.ownerHandle ?? lockEntry?.ownerHandle;
  const requestedReference = origin?.requestedReference ?? lockEntry?.requestedReference;
  const trustState = origin?.trustState ?? lockEntry?.trustState;
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
  const status = resolveClawHubSkillStatusLinkSync({
    workspaceDir: params.workspaceDir,
    skillDir: targetDir,
    skillKey: params.slug,
  });
  const currentVersionHealthy =
    status?.valid === true &&
    Boolean(status.fileTreeSha256) &&
    (await digestClawHubSkillTree(targetDir).catch(() => undefined)) === status.fileTreeSha256;
  return {
    ok: true,
    slug: params.slug,
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(requestedReference ? { requestedReference } : {}),
    ...(trustState ? { trustState } : {}),
    baseUrl: origin?.registry ?? params.baseUrl,
    previousVersion: origin?.installedVersion ?? lockEntry?.version ?? null,
    currentVersionHealthy,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  expectedIntegrity?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  installPolicyAcknowledgementId?: string;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
  /** True when a Claw lifecycle caller already owns package coordination. */
  clawManaged?: boolean;
}): Promise<InstallClawHubSkillResult> {
  if (params.clawManaged) {
    return await installRequestedSkillFromClawHub(params);
  }
  return await withClawPackageLifecycleLease(
    { kind: "skill", source: "clawhub", ref: params.slug, workspace: params.workspaceDir },
    () => installRequestedSkillFromClawHub(params),
  );
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  forceInstall?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  installPolicyAcknowledgementId?: string;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
}): Promise<UpdateClawHubSkillResult[]> {
  const lock = await readClawHubSkillsLockfile(params.workspaceDir);
  const slugs = params.slug
    ? [
        await resolveRequestedUpdateSlug({
          workspaceDir: params.workspaceDir,
          requestedSlug: params.slug,
          lock,
        }),
      ]
    : Object.keys(lock.skills).map((slug) => normalizeTrackedSkillSlug(slug));
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const tracked = await resolveTrackedUpdateTarget({
      workspaceDir: params.workspaceDir,
      slug,
      lock,
      baseUrl: params.baseUrl,
    });
    if (!tracked.ok) {
      results.push({ ok: false, error: tracked.error });
      continue;
    }
    const install = await withClawPackageLifecycleLease(
      { kind: "skill", source: "clawhub", ref: tracked.slug, workspace: params.workspaceDir },
      () =>
        installTrackedSkillFromClawHub({
          workspaceDir: params.workspaceDir,
          slug: tracked.slug,
          ...(tracked.ownerHandle ? { ownerHandle: tracked.ownerHandle } : {}),
          ...(tracked.requestedReference ? { requestedReference: tracked.requestedReference } : {}),
          ...(tracked.trustState ? { trustState: tracked.trustState } : {}),
          baseUrl: tracked.baseUrl,
          force: true,
          ...(tracked.previousVersion && tracked.currentVersionHealthy
            ? { skipIfVersion: tracked.previousVersion }
            : {}),
          forceInstall: params.forceInstall,
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          installPolicyAcknowledgementId: params.installPolicyAcknowledgementId,
          acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
          onClawHubRisk: params.onClawHubRisk,
          logger: params.logger,
          config: params.config,
        }),
      { required: true },
    );
    if (install.ok) {
      const repaired =
        tracked.previousVersion === install.version && !tracked.currentVersionHealthy;
      results.push({
        ok: true,
        slug: tracked.slug,
        previousVersion: tracked.previousVersion,
        version: install.version,
        changed: tracked.previousVersion !== install.version || repaired,
        ...(repaired ? { repaired: true } : {}),
        targetDir: install.targetDir,
        ...(install.warning ? { warning: install.warning } : {}),
      });
    } else {
      results.push(install);
    }
  }
  return results;
}
