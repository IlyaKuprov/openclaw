import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryGetTool } from "./tools.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

const runtimeImport = vi.hoisted(() => vi.fn());

vi.mock("./tools.runtime.js", async () => {
  runtimeImport();
  // A cold runtime can be delayed independently of a registered wiki supplement.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 3_200);
  });
  return {
    readAgentMemoryFile: async () => ({
      status: "not_found",
      text: "",
      path: "memory/entities/alpha.md",
    }),
  };
});

const path = "memory/entities/alpha.md";
const timeoutMs = 2_000;
const wikiHit = { corpus: "wiki", path, content: "Wiki entry", fromLine: 1, lineCount: 1 } as const;

function getTool() {
  const tool = createMemoryGetTool({
    config: asOpenClawConfig({
      agents: { list: [{ id: "main", default: true }] },
      memory: { search: { query: { timeoutSeconds: 2 } } },
    }),
  });
  if (!tool) {
    throw new Error("expected memory_get tool");
  }
  return tool;
}

beforeEach(() => {
  clearMemoryPluginState();
  runtimeImport.mockClear();
});

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`memory_get still pending after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("memory_get cold runtime at the tool boundary", () => {
  it("returns a wiki-only hit without loading the unused memory runtime", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => wikiHit,
    });

    const result = await within(
      getTool().execute("wiki-cold-runtime", { path, corpus: "wiki" }),
      500,
    );

    expect(result.details).toMatchObject({ status: "ok", text: "Wiki entry" });
    expect(runtimeImport).not.toHaveBeenCalled();
  });

  it("times out a cold runtime import for memory and all without blocking wiki", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => wikiHit,
    });
    const tool = getTool();
    const memory = tool.execute("get-cold-memory", { path, corpus: "memory" });
    const all = tool.execute("get-cold-all", { path, corpus: "all" });

    const [memoryResult, allResult] = await within(Promise.all([memory, all]), timeoutMs + 500);
    expect(memoryResult.details).toMatchObject({
      status: "error",
      timedOut: true,
      timeoutMs,
      error: "memory_get timed out after 2s",
      corpora: [{ corpus: "memory", outcome: "unavailable" }],
    });
    expect(allResult.details).toMatchObject({
      status: "ok",
      text: "Wiki entry",
      timedOut: true,
      timeoutMs,
      corpora: [
        { corpus: "memory", outcome: "unavailable" },
        { corpus: "wiki", outcome: "ok" },
      ],
    });
    expect(runtimeImport).toHaveBeenCalledOnce();
  });
});
