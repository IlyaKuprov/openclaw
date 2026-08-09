// @vitest-environment node
import { describe, expect, it } from "vitest";
import { recentPlaces } from "./recent-places.ts";

describe("recentPlaces", () => {
  it("groups basenames, caps, skips the workspace and unknown nodes, and prefers exec cwd", () => {
    expect(
      recentPlaces(
        [
          { execCwd: "/workspace" },
          { execCwd: "/node/repo", execNode: "macbook" },
          { execCwd: "/node/repo", execNode: "macbook" },
          { execCwd: "/gateway/repo" },
          { execCwd: "/gone/repo", execNode: "retired" },
          {
            execCwd: "/preferred/selected",
            worktree: { repoRoot: "/ignored/worktree" },
          },
          { worktree: { repoRoot: "/worktree/one" } },
          { execCwd: "  /cwd/two  " },
          { worktree: { repoRoot: "/capped/out" } },
        ],
        {
          workspace: "/workspace",
          execNodes: [{ nodeId: "macbook" }],
        },
      ),
    ).toEqual([
      { folder: "/node/repo", execNode: "macbook" },
      { folder: "/preferred/selected", execNode: "" },
      { folder: "/worktree/one", execNode: "" },
      { folder: "/cwd/two", execNode: "" },
    ]);
  });
});
