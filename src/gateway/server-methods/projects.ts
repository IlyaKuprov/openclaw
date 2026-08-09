import { stripUrlUserInfo } from "@openclaw/net-policy/url-userinfo";
import {
  PROJECTS_LIST_DEFAULT_LIMIT,
  type ProjectSummary,
  validateProjectsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees, type ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";

type ProjectWorktreeService = Pick<ManagedWorktreeService, "list" | "resolveRepositoryIdentity">;

type ProjectCandidate = {
  checkoutPath: string;
  fingerprint: string;
  lastUsedAt: number;
  originUrl?: string;
};

type RawProjectCandidate =
  | { kind: "session"; checkoutPath: string; lastUsedAt: number }
  | {
      kind: "worktree";
      checkoutPath: string;
      fingerprint: string;
      lastUsedAt: number;
      repoRoot: string;
    };

const PROJECT_IDENTITY_PROBE_FACTOR = 4;

type ProjectGroup = {
  checkouts: Map<string, { path: string; lastUsedAt: number }>;
  lastUsedAt: number;
  name: string;
  nameUsedAt: number;
  originUrl?: string;
};

function checkoutName(checkoutPath: string): string {
  const trimmed = checkoutPath.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || trimmed;
}

function sanitizePublicOriginUrl(originUrl: string): string {
  const suffixIndex = originUrl.search(/[?#]/u);
  return stripUrlUserInfo(suffixIndex < 0 ? originUrl : originUrl.slice(0, suffixIndex));
}

function projectCandidatesToSummaries(
  candidates: readonly ProjectCandidate[],
  limit: number,
): ProjectSummary[] {
  const groups = new Map<string, ProjectGroup>();
  for (const candidate of candidates) {
    const group: ProjectGroup = groups.get(candidate.fingerprint) ?? {
      checkouts: new Map(),
      lastUsedAt: candidate.lastUsedAt,
      name: checkoutName(candidate.checkoutPath),
      nameUsedAt: candidate.lastUsedAt,
    };
    const checkout = group.checkouts.get(candidate.checkoutPath);
    if (!checkout || candidate.lastUsedAt > checkout.lastUsedAt) {
      group.checkouts.set(candidate.checkoutPath, {
        path: candidate.checkoutPath,
        lastUsedAt: candidate.lastUsedAt,
      });
    }
    group.lastUsedAt = Math.max(group.lastUsedAt, candidate.lastUsedAt);
    if (candidate.lastUsedAt > group.nameUsedAt) {
      group.name = checkoutName(candidate.checkoutPath);
      group.nameUsedAt = candidate.lastUsedAt;
    }
    if (!group.originUrl && candidate.originUrl) {
      group.originUrl = candidate.originUrl;
    }
    groups.set(candidate.fingerprint, group);
  }
  return [...groups.values()]
    .toSorted(
      (left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
    )
    .slice(0, limit)
    .map((group) => {
      const summary: ProjectSummary = {
        name: group.name,
        checkouts: [...group.checkouts.values()]
          .toSorted(
            (left, right) =>
              right.lastUsedAt - left.lastUsedAt || left.path.localeCompare(right.path),
          )
          .map((checkout) => ({ runnerId: "gateway", path: checkout.path })),
        lastUsedAt: group.lastUsedAt,
      };
      if (group.originUrl) {
        const originUrl = sanitizePublicOriginUrl(group.originUrl);
        if (originUrl) {
          summary.originUrl = originUrl;
        }
      }
      return summary;
    });
}

async function listProjects(
  service: ProjectWorktreeService,
  context: Parameters<GatewayRequestHandlers["projects.list"]>[0]["context"],
  limit: number,
): Promise<ProjectSummary[]> {
  const { store } = loadCombinedSessionStoreForGateway(context.getRuntimeConfig(), {
    projection: "list",
  });
  const rawCandidates: RawProjectCandidate[] = [];
  for (const entry of Object.values(store)) {
    const checkoutPath = entry.execCwd?.trim();
    if (checkoutPath && !entry.execNode?.trim()) {
      rawCandidates.push({ kind: "session", checkoutPath, lastUsedAt: entry.updatedAt });
    }
  }
  for (const worktree of await service.list()) {
    if (worktree.removedAt === undefined) {
      rawCandidates.push({
        kind: "worktree",
        checkoutPath: worktree.path,
        fingerprint: worktree.repoFingerprint,
        lastUsedAt: worktree.lastActiveAt,
        repoRoot: worktree.repoRoot,
      });
    }
  }

  const candidates: ProjectCandidate[] = [];
  type RepositoryIdentity = Awaited<
    ReturnType<ProjectWorktreeService["resolveRepositoryIdentity"]>
  >;
  const identities = new Map<string, Promise<RepositoryIdentity>>();
  const identityProbeLimit = limit * PROJECT_IDENTITY_PROBE_FACTOR;
  let identityProbeCount = 0;
  const resolveIdentity = (checkoutPath: string) => {
    const existing = identities.get(checkoutPath);
    if (existing) {
      return existing;
    }
    if (identityProbeCount >= identityProbeLimit) {
      return undefined;
    }
    identityProbeCount += 1;
    const identity = Promise.resolve().then(() => service.resolveRepositoryIdentity(checkoutPath));
    identities.set(checkoutPath, identity);
    return identity;
  };

  // Identity probes perform realpath plus Git subprocesses. Bound newest-first overfetch so
  // projects.list trades completeness for latency explicitly; duplicate paths reuse cached work.
  for (const raw of rawCandidates.toSorted(
    (left, right) =>
      right.lastUsedAt - left.lastUsedAt || left.checkoutPath.localeCompare(right.checkoutPath),
  )) {
    if (raw.kind === "worktree") {
      let originUrl: string | undefined;
      const pendingIdentity = resolveIdentity(raw.repoRoot);
      try {
        const identity = pendingIdentity ? await pendingIdentity : undefined;
        originUrl = identity?.originUrl || undefined;
      } catch {
        // The registry fingerprint remains authoritative if its source checkout is unavailable.
      }
      candidates.push({
        checkoutPath: raw.checkoutPath,
        fingerprint: raw.fingerprint,
        lastUsedAt: raw.lastUsedAt,
        ...(originUrl ? { originUrl } : {}),
      });
      continue;
    }
    const pendingIdentity = resolveIdentity(raw.checkoutPath);
    if (!pendingIdentity) {
      continue;
    }
    try {
      const identity = await pendingIdentity;
      candidates.push({
        checkoutPath: identity.checkoutRoot,
        fingerprint: identity.fingerprint,
        lastUsedAt: raw.lastUsedAt,
        ...(identity.originUrl ? { originUrl: identity.originUrl } : {}),
      });
    } catch {
      // Plain folders remain available through the existing folder picker.
    }
  }

  // M5: merge operator-enabled device checkout advertisements at this seam.
  return projectCandidatesToSummaries(candidates, limit);
}

export function createProjectsHandlers(service: ProjectWorktreeService): GatewayRequestHandlers {
  return {
    "projects.list": async ({ params, respond, context }) => {
      if (!validateProjectsListParams(params)) {
        return respondInvalidParams({
          respond,
          method: "projects.list",
          validator: validateProjectsListParams,
        });
      }
      await respondUnavailableOnThrow(respond, async () => {
        const projects = await listProjects(
          service,
          context,
          params.limit ?? PROJECTS_LIST_DEFAULT_LIMIT,
        );
        respond(true, { projects }, undefined);
      });
    },
  };
}

export const projectsHandlers = createProjectsHandlers(managedWorktrees);
