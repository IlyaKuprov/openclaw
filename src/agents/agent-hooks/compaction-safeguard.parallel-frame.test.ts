import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import type { summarizeInStages } from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { setCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const model: Model = {
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  provider: "anthropic",
  api: "anthropic",
  baseUrl: "https://api.anthropic.com",
  contextWindow: 200_000,
  maxTokens: 4_096,
  reasoning: false,
  input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
};

afterEach(() => {
  testing.setSummarizeInStagesForTest();
  resetPluginRuntimeStateForTest();
});

it.each(["provider", "built-in LLM"] as const)(
  "repairs a preserved parallel tool frame before sending it to the %s summarizer",
  async (summarizer) => {
    const providerSummarize = vi.fn(
      async (_params: Parameters<CompactionProvider["summarize"]>[0]) => "repaired summary",
    );
    const llmSummarize = vi.fn(
      async (_params: Parameters<typeof summarizeInStages>[0]) => "repaired summary",
    );
    testing.setSummarizeInStagesForTest(llmSummarize);
    if (summarizer === "provider") {
      requireActivePluginRegistry().compactionProviders.push({
        provider: {
          id: "parallel-frame-provider",
          label: "Parallel Frame Provider",
          summarize: providerSummarize,
        },
      });
    }

    const sessionManager = {} as ExtensionContext["sessionManager"];
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 1,
      ...(summarizer === "provider" ? { provider: "parallel-frame-provider" } : {}),
    });
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    compactionSafeguardExtension({
      on: (event: string, callback: typeof handler) => {
        if (event === "session_before_compact") {
          handler = callback;
        }
      },
    } as unknown as ExtensionAPI);
    if (!handler) {
      throw new Error("Compaction safeguard handler was not registered");
    }
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older ask", timestamp: 1 },
          castAgentMessage({ role: "assistant", content: "older answer", timestamp: 2 }),
          { role: "user", content: "recent ask", timestamp: 3 },
          castAgentMessage({
            role: "assistant",
            content: [
              { type: "toolCall", id: "parallel_done", name: "read", arguments: {} },
              { type: "toolCall", id: "parallel_missing", name: "read", arguments: {} },
            ],
            timestamp: 4,
          }),
          castAgentMessage({
            role: "toolResult",
            toolCallId: "parallel_done",
            toolName: "read",
            content: [{ type: "text", text: "real receipt" }],
            timestamp: 5,
          }),
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const result = await handler(event, {
      sessionManager,
      model: undefined,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      },
    } as unknown as ExtensionContext);

    expect(result).toHaveProperty("compaction.summary");
    const messages =
      summarizer === "provider"
        ? (providerSummarize.mock.calls[0]?.[0].messages as AgentMessage[] | undefined)
        : llmSummarize.mock.calls[0]?.[0].messages;
    expect(messages?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    expect(messages?.[3]).toEqual(
      expect.objectContaining({
        content: [
          { type: "toolCall", id: "parallel_done", name: "read", arguments: {} },
          { type: "toolCall", id: "parallel_missing", name: "read", arguments: {} },
        ],
      }),
    );
    expect(messages?.slice(-2)).toEqual([
      expect.objectContaining({
        toolCallId: "parallel_done",
        content: [{ type: "text", text: "real receipt" }],
      }),
      expect.objectContaining({
        toolCallId: "parallel_missing",
        isError: true,
        details: expect.objectContaining({ openclawSyntheticMissingToolResult: true }),
      }),
    ]);
    if (summarizer === "provider") {
      expect(llmSummarize).not.toHaveBeenCalled();
    }
  },
);
