import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createProjectsHandlers } from "./projects.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const seededSessions = vi.hoisted(() => ({
  store: {} as Record<
    string,
    { sessionId: string; updatedAt: number; execCwd?: string; execNode?: string }
  >,
}));

vi.mock("../session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: () => ({ store: seededSessions.store }),
}));

describe("projects.list", () => {
  it("groups gateway session checkouts by repository fingerprint", async () => {
    seededSessions.store = {
      "agent:main:alpha-old": {
        sessionId: "alpha-old",
        updatedAt: 100,
        execCwd: "/repos/alpha-main",
      },
      "agent:main:alpha-new": {
        sessionId: "alpha-new",
        updatedAt: 300,
        execCwd: "/repos/alpha-worktree",
      },
      "agent:main:device": {
        sessionId: "device",
        updatedAt: 400,
        execCwd: "/device/alpha",
        execNode: "paired-mac",
      },
    };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
    };
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
      checkoutRoot: checkoutPath,
      repoRoot: checkoutPath,
      originUrl: "https://github.com/openclaw/alpha.git",
      fingerprint: "alpha-fingerprint",
    }));
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity,
    } as never);
    const responses: Parameters<RespondFn>[] = [];
    await handlers["projects.list"]?.({
      params: {},
      respond: (...response: Parameters<RespondFn>) => responses.push(response),
      context: { getRuntimeConfig: () => config } as GatewayRequestContext,
    } as never);

    expect(responses).toEqual([
      [
        true,
        {
          projects: [
            {
              name: "alpha-worktree",
              originUrl: "https://github.com/openclaw/alpha.git",
              checkouts: [
                { runnerId: "gateway", path: "/repos/alpha-worktree" },
                { runnerId: "gateway", path: "/repos/alpha-main" },
              ],
              lastUsedAt: 300,
            },
          ],
        },
        undefined,
      ],
    ]);
    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(2);
    expect(resolveRepositoryIdentity).not.toHaveBeenCalledWith("/device/alpha");
  });

  it("keeps distinct managed worktree checkout paths under one project", async () => {
    seededSessions.store = {
      "agent:main:alpha-session": {
        sessionId: "alpha-session",
        updatedAt: 250,
        execCwd: "/repos/alpha-session",
      },
    };
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
    };
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
      checkoutRoot: checkoutPath,
      repoRoot: "/repos/alpha-main",
      originUrl: "https://github.com/openclaw/alpha.git",
      fingerprint: "alpha-fingerprint",
    }));
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => [
        {
          id: "worktree-a",
          name: "feature-a",
          repoFingerprint: "alpha-fingerprint",
          repoRoot: "/repos/alpha-main",
          path: "/state/worktrees/alpha/feature-a",
          branch: "openclaw/feature-a",
          baseRef: "main",
          ownerKind: "session",
          createdAt: 100,
          lastActiveAt: 300,
        },
        {
          id: "worktree-b",
          name: "feature-b",
          repoFingerprint: "alpha-fingerprint",
          repoRoot: "/repos/alpha-main",
          path: "/state/worktrees/alpha/feature-b",
          branch: "openclaw/feature-b",
          baseRef: "main",
          ownerKind: "session",
          createdAt: 100,
          lastActiveAt: 200,
        },
      ]),
      resolveRepositoryIdentity,
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({
      params: {},
      respond,
      context: { getRuntimeConfig: () => config } as GatewayRequestContext,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        projects: [
          {
            name: "feature-a",
            originUrl: "https://github.com/openclaw/alpha.git",
            checkouts: [
              { runnerId: "gateway", path: "/state/worktrees/alpha/feature-a" },
              { runnerId: "gateway", path: "/repos/alpha-session" },
              { runnerId: "gateway", path: "/state/worktrees/alpha/feature-b" },
            ],
            lastUsedAt: 300,
          },
        ],
      },
      undefined,
    );
    expect(resolveRepositoryIdentity.mock.calls).toEqual([
      ["/repos/alpha-main"],
      ["/repos/alpha-session"],
    ]);
  });

  it("removes credentials, queries, and fragments from public origin URLs", async () => {
    seededSessions.store = {
      "agent:main:credentials": {
        sessionId: "credentials",
        updatedAt: 300,
        execCwd: "/repos/credentials",
      },
      "agent:main:query": {
        sessionId: "query",
        updatedAt: 200,
        execCwd: "/repos/query",
      },
      "agent:main:scp": {
        sessionId: "scp",
        updatedAt: 100,
        execCwd: "/repos/scp",
      },
    };
    const origins: Record<string, string> = {
      "/repos/credentials": ["https://user", ":", "token", "@host/repo.git"].join(""),
      "/repos/query": "https://host/query.git?visible=value#branch",
      "/repos/scp": "git@host:org/scp.git",
    };
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity: vi.fn(async (checkoutPath: string) => ({
        checkoutRoot: checkoutPath,
        repoRoot: checkoutPath,
        originUrl: origins[checkoutPath],
        fingerprint: checkoutPath,
      })),
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({
      params: {},
      respond,
      context: {
        getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
      } as GatewayRequestContext,
    } as never);

    const projects = respond.mock.calls[0]?.[1]?.projects as Array<{
      name: string;
      originUrl: string;
    }>;
    expect(projects.map(({ name, originUrl }) => ({ name, originUrl }))).toEqual([
      { name: "credentials", originUrl: "https://host/repo.git" },
      { name: "query", originUrl: "https://host/query.git" },
      { name: "scp", originUrl: "git@host:org/scp.git" },
    ]);
  });

  it("caps identity probes to the newest four candidates for limit one", async () => {
    seededSessions.store = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => {
        const ordinal = index + 1;
        return [
          `agent:main:stale-${ordinal}`,
          {
            sessionId: `stale-${ordinal}`,
            updatedAt: ordinal,
            execCwd: `/repos/stale-${ordinal}`,
          },
        ];
      }),
    );
    const resolveRepositoryIdentity = vi.fn(async () => {
      throw new Error("checkout is unavailable");
    });
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity,
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({
      params: { limit: 1 },
      respond,
      context: {
        getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
      } as GatewayRequestContext,
    } as never);

    expect(respond).toHaveBeenCalledWith(true, { projects: [] }, undefined);
    expect(resolveRepositoryIdentity.mock.calls).toEqual([
      ["/repos/stale-7"],
      ["/repos/stale-6"],
      ["/repos/stale-5"],
      ["/repos/stale-4"],
    ]);
  });

  it("rejects an out-of-range limit", async () => {
    const handlers = createProjectsHandlers({
      list: vi.fn(async () => []),
      resolveRepositoryIdentity: vi.fn(),
    } as never);
    const respond = vi.fn();

    await handlers["projects.list"]?.({ params: { limit: 201 }, respond } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid projects.list params") }),
    );
  });
});
