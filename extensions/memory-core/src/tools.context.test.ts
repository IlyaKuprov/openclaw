// Memory search execution-context tests exercise agent, config, source, and ranking inputs.
import { beforeEach, describe, expect, it } from "vitest";
import {
  getMemorySearchManagerMockConfigs,
  getMemorySearchManagerMockParams,
  resetMemoryToolMockState,
  setMemorySearchImpl,
} from "./memory-tool-manager.test-mocks.js";
import { applyProjectRanking } from "./memory/project-ranking.js";
import { createMemorySearchTool } from "./tools.js";
import { asOpenClawConfig, createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

describe("memory_search execution context", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("uses explicit plugin context agent over synthetic active-memory session keys", async () => {
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: {
          list: [
            { id: "main", default: true, memory: { search: { enabled: false } } },
            { id: "recall", memory: { search: { enabled: true } } },
          ],
        },
      }),
      agentId: "recall",
      agentSessionKey: "explicit:user-session:active-memory:abc123",
    });

    await tool.execute("recall", { query: "favorite food" });

    expect(getMemorySearchManagerMockParams().at(-1)?.agentId).toBe("recall");
  });

  it("re-resolves config when executing a previously created tool", async () => {
    const startupConfig = asOpenClawConfig({
      agents: {
        defaults: {},
        list: [{ id: "main", default: true }],
      },
      memory: {
        search: {
          provider: "ollama",
          model: "nomic-embed-text",
        },
      },
    });
    const patchedConfig = asOpenClawConfig({
      agents: {
        defaults: {},
        list: [{ id: "main", default: true }],
      },
      memory: {
        search: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    });
    let liveConfig = startupConfig;
    const tool = createMemorySearchTool({
      config: startupConfig,
      getConfig: () => liveConfig,
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    liveConfig = patchedConfig;
    await tool.execute("patched-config", { query: "provider switch" });

    expect(getMemorySearchManagerMockConfigs()).toEqual([patchedConfig]);
  });

  it("keeps ordinary memory_search on explicitly configured sources when recall indexing is enabled", async () => {
    let seenSources: readonly string[] | undefined;
    let seenMaxResults: number | undefined;
    setMemorySearchImpl(async (opts) => {
      seenSources = opts?.sources;
      seenMaxResults = opts?.maxResults;
      return [];
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: {
          defaults: {},
          list: [{ id: "main", default: true }],
        },
        memory: {
          citations: "off",
          search: { rememberAcrossConversations: true },
        },
        tools: { sessions: { visibility: "all" } },
      },
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("ordinary-search", { query: "favorite food", maxResults: 3 });

    expect(seenSources).toEqual(["memory"]);
    expect(seenMaxResults).toBe(3);
  });

  it("applies active-project ranking through the production memory_search tool", async () => {
    let activeProjectKeys: string[] | undefined;
    setMemorySearchImpl(async (opts) => {
      activeProjectKeys = opts?.activeProjectKeys;
      return applyProjectRanking(
        [
          {
            path: "MEMORY.md",
            startLine: 2,
            endLine: 2,
            score: 0.9,
            snippet: "second active fact",
            source: "memory" as const,
            projectKey: "github.com/acme/Beta",
          },
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet: "active fact",
            source: "memory" as const,
            projectKey: "github.com/acme/Alpha",
          },
          {
            path: "MEMORY.md",
            startLine: 3,
            endLine: 3,
            score: 0.85,
            snippet: "foreign fact",
            source: "memory" as const,
            projectKey: "github.com/acme/Gamma",
          },
        ],
        opts?.activeProjectKeys,
      );
    });
    const tool = createMemorySearchToolOrThrow({
      config: { memory: { citations: "off" } },
      activeProjectKeys: ["github.com/acme/Beta", "github.com/acme/Alpha"],
    });

    const result = await tool.execute("project-ranked-search", { query: "fact" });
    const details = result.details as { results: Array<{ snippet: string; score: number }> };

    expect(details.results.map((entry) => entry.snippet)).toEqual([
      "second active fact",
      "active fact",
      "foreign fact",
    ]);
    expect(activeProjectKeys).toEqual(["github.com/acme/Beta", "github.com/acme/Alpha"]);
    expect(details.results[0]?.score).toBeCloseTo(1.035);
    expect(details.results[1]?.score).toBeCloseTo(0.92);
    expect(details.results[2]?.score).toBeCloseTo(0.765);
  });
});
