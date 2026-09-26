import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import * as compactionQualityModule from "./compaction-safeguard-quality.js";
import {
  consumeCompactionSafeguardCancellation,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const { compactionLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "compaction-safeguard",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { compactionLogger: logger };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return { ...actual, createSubsystemLogger: () => compactionLogger };
});

vi.mock("./compaction-safeguard-quality.js", async () => {
  const actual = await vi.importActual<typeof compactionQualityModule>(
    "./compaction-safeguard-quality.js",
  );
  return { ...actual, auditSummaryQuality: vi.fn(actual.auditSummaryQuality) };
});

vi.mock("../compaction.js", async () => {
  const actual = await vi.importActual<typeof compactionModule>("../compaction.js");
  return {
    ...actual,
    summarizeInStages: vi.fn(actual.summarizeInStages),
  };
});

const mockSummarizeInStages = vi.mocked(compactionModule.summarizeInStages);
const actualCompactionQualityModule = await vi.importActual<typeof compactionQualityModule>(
  "./compaction-safeguard-quality.js",
);
const mockAuditSummaryQuality = vi.mocked(compactionQualityModule.auditSummaryQuality);

const {
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  appendSummarySection,
  resolveRecentTurnsPreserve,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_SPLIT_TURN_CONTEXT_CHARS,
} = testing;

beforeEach(() => {
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
  mockAuditSummaryQuality.mockImplementation(actualCompactionQualityModule.auditSummaryQuality);
  mockAuditSummaryQuality.mockClear();
  compactionLogger.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
  resetPluginRuntimeStateForTest();
});

function summaryResult(text: string) {
  return text;
}

// The production test hook returns the whole section; assert its text directly.
function preservedTurnsText(messages: AgentMessage[]): string {
  return (buildPreservedTurnsSection(messages) as { text: string }).text;
}

function installCompactionProviderForTest(provider: CompactionProvider): void {
  requireActivePluginRegistry().compactionProviders.push({ provider });
}

function stubSessionManager(): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
const createCompactionHandler = () => {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  return compactionHandler;
};

const createCompactionEvent = (params: { messageText: string; tokensBefore: number }) => ({
  preparation: {
    messagesToSummarize: [
      { role: "user", content: params.messageText, timestamp: Date.now() },
    ] as AgentMessage[],
    turnPrefixMessages: [] as AgentMessage[],
    firstKeptEntryId: "entry-1",
    tokensBefore: params.tokensBefore,
    fileOps: {
      read: [],
      edited: [],
      written: [],
    },
  },
  customInstructions: "",
  signal: new AbortController().signal,
});

const createCompactionContext = (params: {
  sessionManager: ExtensionContext["sessionManager"];
  getApiKeyAndHeadersMock?: ReturnType<typeof vi.fn>;
  getApiKeyMock?: ReturnType<typeof vi.fn>;
}) =>
  ({
    model: undefined,
    sessionManager: params.sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders:
        params.getApiKeyAndHeadersMock ??
        vi.fn(async (model) => {
          const legacyGetApiKey = params.getApiKeyMock as
            | undefined
            | ((model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>);
          const apiKey = await legacyGetApiKey?.(model);
          return apiKey !== undefined ? { ok: true, apiKey } : { ok: false, error: "missing auth" };
        }),
    },
  }) as unknown as Partial<ExtensionContext>;

function withLatestUnresolvedUserRequest(event: unknown): unknown {
  if (!event || typeof event !== "object") {
    return event;
  }
  const eventRecord = event as {
    preparation?: { messagesToSummarize?: unknown; turnPrefixMessages?: unknown };
  };
  const preparation = eventRecord.preparation;
  if (!preparation || "latestUnresolvedUserRequest" in preparation) {
    return event;
  }
  const messages = [
    ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
    ...(Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
  ];
  const latestUser = messages
    .toReversed()
    .find((message) => (message as { role?: unknown }).role === "user") as
    | { content?: unknown }
    | undefined;
  const latestUnresolvedUserRequest =
    typeof latestUser?.content === "string" ? latestUser.content.trim() : "";
  return {
    ...eventRecord,
    preparation: {
      ...preparation,
      ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
    },
  };
}

async function runCompactionScenario(params: {
  sessionManager: ExtensionContext["sessionManager"];
  event: unknown;
  apiKey: string | null;
  latestUnresolvedUserRequest?: boolean;
}) {
  const compactionHandler = createCompactionHandler();
  const getApiKeyAndHeadersMock = vi
    .fn()
    .mockResolvedValue(
      params.apiKey !== null
        ? { ok: true, apiKey: params.apiKey }
        : { ok: false, error: "missing auth" },
    );
  const mockContext = createCompactionContext({
    sessionManager: params.sessionManager,
    getApiKeyAndHeadersMock,
  });
  const event = params.latestUnresolvedUserRequest
    ? withLatestUnresolvedUserRequest(params.event)
    : params.event;
  const result = (await compactionHandler(event, mockContext)) as {
    cancel?: boolean;
    compaction?: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    };
  };
  return { result, getApiKeyAndHeadersMock };
}

function expectCompactionResult(result: {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  };
}) {
  expect(result.cancel).not.toBe(true);
  if (!result.compaction) {
    throw new Error("Expected compaction result");
  }
  return result.compaction;
}

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call[argIndex];
}

const requireRecord = createRequireRecord("object", "expected-record");

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("expected array");
  }
  return value;
}

describe("compaction-safeguard recent-turn preservation", () => {
  it("preserves the most recent user/assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "older ask", timestamp: 1 },
      castAgentMessage(timestampedTextAssistant("older answer", 2)),
      { role: "user", content: "recent ask", timestamp: 3 },
      castAgentMessage(timestampedTextAssistant("recent answer", 4)),
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 1,
    });

    expect(split.preservedMessages).toHaveLength(2);
    expect(split.summarizableMessages).toHaveLength(2);
    expect(preservedTurnsText(split.preservedMessages)).toContain(
      "## Recent turns preserved verbatim",
    );
  });

  it("drops orphaned tool results from preserved assistant turns", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "older ask", timestamp: 1 },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "read", arguments: {} }],
        timestamp: 2,
      }),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_old",
        toolName: "read",
        content: [{ type: "text", text: "old result" }],
        timestamp: 3,
      }),
      { role: "user", content: "recent ask", timestamp: 4 },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
        timestamp: 5,
      }),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_recent",
        toolName: "read",
        content: [{ type: "text", text: "recent result" }],
        timestamp: 6,
      }),
      castAgentMessage(timestampedTextAssistant("recent final answer", 7)),
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 1,
    });

    expect(split.preservedMessages.map((msg: AgentMessage) => msg.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(
      split.preservedMessages.some(
        (msg: AgentMessage) =>
          msg.role === "user" && (msg as { content?: unknown }).content === "recent ask",
      ),
    ).toBe(true);

    const summarizableToolResultIds = split.summarizableMessages
      .filter((msg: AgentMessage) => msg.role === "toolResult")
      .map((msg: AgentMessage) => (msg as { toolCallId?: unknown }).toolCallId);
    expect(summarizableToolResultIds).toContain("call_old");
    expect(summarizableToolResultIds).not.toContain("call_recent");
  });

  it("excludes paired recent results from the verbatim section", () => {
    const split = splitPreservedRecentTurns({
      messages: [
        { role: "user", content: "older ask", timestamp: 1 },
        castAgentMessage(timestampedTextAssistant("older answer", 2)),
        { role: "user", content: "recent ask", timestamp: 3 },
        castAgentMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
          timestamp: 4,
        }),
        castAgentMessage({
          role: "toolResult",
          toolCallId: "call_recent",
          toolName: "read",
          content: [{ type: "text", text: "recent raw output" }],
          timestamp: 5,
        }),
        castAgentMessage(timestampedTextAssistant("recent final answer", 6)),
      ],
      recentTurnsPreserve: 1,
    });

    const section = preservedTurnsText(split.preservedMessages);
    // HF-47: verbatim recent turns carry what was said, not tool receipts.
    expect(section).not.toContain("- Tool result (read): recent raw output");
    expect(section).toContain("- User: recent ask");
    expect(section).toContain("- Assistant: recent final answer");
  });

  it("summarizes recent result-only facts without copying tool receipts verbatim (HF-47)", async () => {
    mockSummarizeInStages.mockReset().mockResolvedValue(summaryResult("measured 17.3 Hz"));
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 1,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older ask", timestamp: 1 },
          castAgentMessage(timestampedTextAssistant("older answer", 2)),
          { role: "user", content: "measure the line width", timestamp: 3 },
          castAgentMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "recent_read", name: "read", arguments: {} }],
            timestamp: 4,
          }),
          castAgentMessage({
            role: "toolResult",
            toolCallId: "recent_read",
            toolName: "read",
            content: [{ type: "text", text: "measured 17.3 Hz" }],
            timestamp: 5,
          }),
          castAgentMessage(timestampedTextAssistant("I'll report the result next.", 6)),
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

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summarizationInput = requireRecord(mockCallArg(mockSummarizeInStages));
    expect(JSON.stringify(summarizationInput.messages)).toContain("measured 17.3 Hz");
    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain("measured 17.3 Hz");
    expect(summary).not.toContain("- Tool result (read):");
  });

  it.each(["built-in", "provider"])(
    "keeps successful orphan receipt facts in the %s summary input without unpaired replay",
    async (route) => {
      mockSummarizeInStages.mockReset().mockResolvedValue("result recorded");
      const providerSummarize = vi.fn().mockResolvedValue("result recorded");
      if (route === "provider") {
        installCompactionProviderForTest({
          id: "receipt-provider",
          label: "Receipt Provider",
          summarize: providerSummarize,
        });
      }
      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        provider: route === "provider" ? "receipt-provider" : undefined,
        recentTurnsPreserve: 1,
      });
      const orphan = castAgentMessage({
        role: "toolResult",
        toolCallId: "call-before-boundary",
        toolName: "read",
        content: [{ type: "text", text: "Measured linewidth 17.3 Hz at /tmp/line.txt" }],
        isError: false,
        timestamp: 2,
      });
      const event = {
        preparation: {
          messagesToSummarize: [
            { role: "user", content: "Measure linewidth", timestamp: 1 },
            orphan,
            { role: "user", content: "Proceed with the result", timestamp: 3 },
          ] as AgentMessage[],
          turnPrefixMessages: [] as AgentMessage[],
          firstKeptEntryId: "entry-1",
          tokensBefore: 500,
          fileOps: { read: [], edited: [], written: [] },
          settings: { reserveTokens: 4_000 },
          isSplitTurn: false,
        },
        customInstructions: "",
        signal: new AbortController().signal,
      };

      const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

      expectCompactionResult(result);
      const summarizer = route === "provider" ? providerSummarize : mockSummarizeInStages;
      const messages = requireArray(
        requireRecord(mockCallArg(summarizer)).messages,
      ) as AgentMessage[];
      expect(messages).not.toContain(orphan);
      expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
      expect(JSON.stringify(messages)).toContain("Measured linewidth 17.3 Hz at /tmp/line.txt");
    },
  );

  it.each([20, 850])(
    "marks receipt-count overflow and keeps the newest of nine orphan receipts (%i chars each)",
    async (receiptLength) => {
      mockSummarizeInStages.mockReset().mockResolvedValue("receipts recorded");
      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 1,
      });
      const receipts = Array.from({ length: 9 }, (_, index) =>
        castAgentMessage({
          role: "toolResult",
          toolCallId: `before-window-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `receipt-${index}: ${"x".repeat(receiptLength)}` }],
          isError: false,
          timestamp: index + 2,
        }),
      );
      const event = {
        preparation: {
          messagesToSummarize: [
            { role: "user", content: "Inspect receipts", timestamp: 1 },
            ...receipts,
            { role: "user", content: "Continue", timestamp: 12 },
          ] as AgentMessage[],
          turnPrefixMessages: [] as AgentMessage[],
          firstKeptEntryId: "entry-1",
          tokensBefore: 500,
          fileOps: { read: [], edited: [], written: [] },
          settings: { reserveTokens: 4_000 },
          isSplitTurn: false,
        },
        customInstructions: "",
        signal: new AbortController().signal,
      };

      const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "***" });

      expectCompactionResult(result);
      const messages = requireArray(
        requireRecord(mockCallArg(mockSummarizeInStages)).messages,
      ) as AgentMessage[];
      const receiptNote = messages.find(
        (message) =>
          message.role === "user" &&
          "content" in message &&
          typeof message.content === "string" &&
          message.content.includes("Unpaired tool results"),
      );
      if (!receiptNote || !("content" in receiptNote) || typeof receiptNote.content !== "string") {
        throw new Error("expected unpaired result note");
      }
      expect(receiptNote.content).toContain("receipt-8:");
      expect(receiptNote.content).toContain("[earlier tool results omitted]");
      expect(receiptNote.content.length).toBeLessThan(4_200);
      expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
    },
  );

  it("feeds audited evidence after an oversized orphan prefix to a strict first-pass summary", async () => {
    const latestAsk = "Report the orphan measurement.";
    const measurement = "17.3 Hz";
    const sourcePath = "/tmp/late-linewidth.log";
    // The measurement sits in the head lost to marker reservation; the path
    // lies beyond the original 900-character preview altogether.
    const toolOutput = `${"unremarkable output ".repeat(42)}Measured ${measurement} ${"routine trace ".repeat(25)}in ${sourcePath}`;
    expect(toolOutput.length).toBeGreaterThan(900);
    expect(toolOutput.indexOf(measurement)).toBeLessThan(900);
    expect(toolOutput.indexOf(sourcePath)).toBeGreaterThan(900);
    mockSummarizeInStages.mockReset().mockImplementation(async ({ messages }) => {
      const input = JSON.stringify(messages);
      if (!input.includes(measurement) || !input.includes(sourcePath)) {
        return "The measurement and source were not in the supplied conversation.";
      }
      return [
        "## Decisions\nNone.",
        `## Results and evidence\nMeasured ${measurement} in ${sourcePath}.`,
        "## Open TODOs\nNone.",
        "## Constraints/Rules\nNone.",
        `## Pending user asks\nLatest user request context: ${JSON.stringify(latestAsk)}`,
        `## Exact identifiers\n${measurement}\n${sourcePath}`,
      ].join("\n\n");
    });
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 0,
      identifierPolicy: "strict",
    });
    const orphan = castAgentMessage({
      role: "toolResult",
      toolCallId: "before-window",
      toolName: "read",
      content: [{ type: "text", text: toolOutput }],
      isError: false,
      timestamp: 2,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "Inspect the output.", timestamp: 1 },
          orphan,
          { role: "user", content: latestAsk, timestamp: 3 },
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "***",
      latestUnresolvedUserRequest: true,
    });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(measurement);
    expect(summary).toContain(sourcePath);
    const messages = requireArray(
      requireRecord(mockCallArg(mockSummarizeInStages)).messages,
    ) as AgentMessage[];
    const input = JSON.stringify(messages);
    expect(input).toContain(measurement);
    expect(input).toContain(sourcePath);
    expect(input).toContain("omitted");
    expect(input).not.toContain(toolOutput);
    expect(messages).not.toContain(orphan);
    expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
    const receiptNote = messages.find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("Unpaired tool results"),
    );
    if (receiptNote?.role !== "user" || typeof receiptNote.content !== "string") {
      throw new Error("expected bounded unpaired result note");
    }
    expect(receiptNote.content.length).toBeLessThan(1_100);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps an orphan receipt beside a partial tool frame while synthesizing its missing result", async () => {
    mockSummarizeInStages.mockReset().mockResolvedValue("partial frame summary");
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "Inspect output", timestamp: 1 },
          castAgentMessage({
            role: "assistant",
            content: [
              { type: "toolCall", id: "frame-a", name: "read", arguments: {} },
              { type: "toolCall", id: "frame-b", name: "read", arguments: {} },
            ],
            timestamp: 2,
          }),
          castAgentMessage({
            role: "toolResult",
            toolCallId: "frame-a",
            toolName: "read",
            content: [{ type: "text", text: "paired measurement" }],
            isError: false,
            timestamp: 3,
          }),
          castAgentMessage({
            role: "toolResult",
            toolCallId: "before-window",
            toolName: "read",
            content: [{ type: "text", text: `orphaned measurement: 42 kHz ${"x".repeat(20_000)}` }],
            isError: false,
            timestamp: 4,
          }),
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 300,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    expectCompactionResult(result);
    const messages = requireArray(
      requireRecord(mockCallArg(mockSummarizeInStages)).messages,
    ) as AgentMessage[];
    expect(JSON.stringify(messages)).toContain("orphaned measurement: 42 kHz");
    const note = messages.find(
      (message) =>
        message.role === "user" &&
        "content" in message &&
        typeof message.content === "string" &&
        message.content.includes("Unpaired tool results"),
    );
    if (!note || !("content" in note) || typeof note.content !== "string") {
      throw new Error("expected unpaired result note");
    }
    expect(note.content.length).toBeLessThan(4_200);
    expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
    expect(
      messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId),
    ).toEqual(["frame-a", "frame-b"]);
  });

  it("keeps only the spoken turns of an oversized tool interaction (HF-47)", () => {
    const toolCalls = Array.from({ length: 40 }, (_, index) => ({
      type: "toolCall",
      id: `call_${index}`,
      name: "read",
      arguments: {},
    }));
    const split = splitPreservedRecentTurns({
      messages: [
        { role: "user", content: "recent ask", timestamp: 1 },
        castAgentMessage({ role: "assistant", content: toolCalls, timestamp: 2 }),
        ...toolCalls.map((toolCall, index) =>
          castAgentMessage({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: "read",
            content: [
              {
                type: "text",
                text: `paired-result-${String(index).padStart(2, "0")}-${"x".repeat(700)}`,
              },
            ],
            timestamp: index + 3,
          }),
        ),
        castAgentMessage(timestampedTextAssistant("terminal answer survives", 43)),
      ],
      recentTurnsPreserve: 1,
    });

    const section = preservedTurnsText(split.preservedMessages) as string;

    expect(section.length).toBeLessThanOrEqual(MAX_SPLIT_TURN_CONTEXT_CHARS);
    expect(section).not.toContain("[Earlier preserved messages truncated]");
    expect(section).not.toContain("paired-result-00-");
    expect(section).not.toContain("paired-result-29-");
    expect(section).not.toContain("paired-result-39-");
    expect(section).not.toContain("- Tool result (read):");
    expect(section).toContain("- Assistant: terminal answer survives");
    expect(section.split("\n").some((line) => line.startsWith("x"))).toBe(false);
  });

  it("omits preserved messages that carry no text (HF-47)", () => {
    const section = preservedTurnsText([
      castAgentMessage({
        role: "user",
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        timestamp: 1,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
        timestamp: 2,
      }),
    ]);

    expect(section).not.toContain("[non-text content");
    expect(section).toBe("");
  });

  it.each([
    { label: "image", block: { type: "image", data: "aW1n", mimeType: "image/png" } },
    { label: "file", block: { type: "file", name: "scan.pdf" } },
  ])(
    "sends a preserved $label-only user turn to the built-in summarizer",
    async ({ label, block }) => {
      mockSummarizeInStages
        .mockReset()
        .mockResolvedValue(summaryResult(`Recent user sent a ${label} attachment.`));
      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 1,
      });
      const attachmentTurn = castAgentMessage({
        role: "user",
        content: [block],
        timestamp: 3,
      });
      const event = createCompactionEvent({ messageText: "older task", tokensBefore: 1_500 });
      (event.preparation as { settings?: { reserveTokens: number } }).settings = {
        reserveTokens: 4_000,
      };
      event.preparation.messagesToSummarize = [
        { role: "user", content: "older task", timestamp: 1 },
        castAgentMessage(timestampedTextAssistant("older answer", 2)),
        attachmentTurn,
      ];

      const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

      expect(mockSummarizeInStages).toHaveBeenCalledOnce();
      expect(
        requireArray(requireRecord(mockCallArg(mockSummarizeInStages)).messages),
      ).toContainEqual(attachmentTurn);
      expectCompactionResult(result);
      expect(result.compaction?.summary).toContain(`Recent user sent a ${label} attachment.`);
      expect(result.compaction?.summary).not.toContain("[non-text content");
      expect(result.compaction?.summary).not.toContain("- Tool result (");
    },
  );

  it("keeps only the text of mixed-content preserved messages (HF-47)", () => {
    const section = preservedTurnsText([
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "caption text" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 1,
      }),
    ]);

    expect(section).toContain("- User: caption text");
    expect(section).not.toContain("[non-text content: image]");
  });

  it("keeps bounded preserved-turn text UTF-16 safe", () => {
    const section = preservedTurnsText([
      {
        role: "user",
        content: `${"x".repeat(1_499)}🚀tail`,
        timestamp: 1,
      },
    ]);

    expect(section).toContain(`- User: ${"x".repeat(1_499)}...`);
  });

  it("does not add non-text placeholders for text-only content blocks", () => {
    const section = preservedTurnsText([
      castAgentMessage(timestampedTextAssistant("plain text reply", 1)),
    ]);

    expect(section).toContain("- Assistant: plain text reply");
    expect(section).not.toContain("[non-text content]");
  });

  it("retains the oldest ask in either summary or suffix across section budgets", async () => {
    mockSummarizeInStages.mockReset();
    const oldestAsk = "earliest preserved user request: keep the baseline result";
    mockSummarizeInStages.mockImplementation(async ({ messages }) =>
      summaryResult(
        JSON.stringify(messages).includes(oldestAsk)
          ? `## Decisions\n${oldestAsk} remains active.`
          : "## Decisions\nNo earlier request captured.",
      ),
    );
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, { model: createAnthropicModelFixture() });
    const messagesToSummarize = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index === 0 ? oldestAsk : `recent-${index}`} ${"x".repeat(1_420)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const event = createCompactionEvent({ messageText: "placeholder", tokensBefore: 20_000 });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };
    event.preparation.messagesToSummarize = messagesToSummarize;

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "***" });

    const summary = expectCompactionResult(result).summary;
    const preserved = preservedTurnsText(messagesToSummarize);
    const summarizeCall = mockSummarizeInStages.mock.calls[0]?.[0];
    const summarized = summarizeCall ? JSON.stringify(summarizeCall.messages) : "";
    expect(preserved.includes(oldestAsk) || summarized.includes(oldestAsk)).toBe(true);
    expect(summary).toContain(oldestAsk);
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
  });

  it("summarizes a preserved ask whose final text is clipped by the per-message cap", async () => {
    mockSummarizeInStages.mockReset();
    const trailingAsk = "trailing user requirement: keep exact error code";
    mockSummarizeInStages.mockImplementation(async ({ messages }) =>
      summaryResult(
        JSON.stringify(messages).includes(trailingAsk)
          ? `## Decisions\n${trailingAsk}`
          : "## Decisions\nNo trailing requirement captured.",
      ),
    );
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, { model: createAnthropicModelFixture() });
    const longAsk = `${"x".repeat(1_600)} ${trailingAsk}`;
    const event = createCompactionEvent({ messageText: longAsk, tokensBefore: 20_000 });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "***" });

    expect(preservedTurnsText(event.preparation.messagesToSummarize)).not.toContain(trailingAsk);
    expect(expectCompactionResult(result).summary).toContain(trailingAsk);
    expect(mockSummarizeInStages).toHaveBeenCalledOnce();
  });

  it("caps preserved tail when user turns are below preserve target", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "single user prompt", timestamp: 1 },
      castAgentMessage(timestampedTextAssistant("assistant-1", 2)),
      castAgentMessage(timestampedTextAssistant("assistant-2", 3)),
      castAgentMessage(timestampedTextAssistant("assistant-3", 4)),
      castAgentMessage(timestampedTextAssistant("assistant-4", 5)),
      castAgentMessage(timestampedTextAssistant("assistant-5", 6)),
      castAgentMessage(timestampedTextAssistant("assistant-6", 7)),
      castAgentMessage(timestampedTextAssistant("assistant-7", 8)),
      castAgentMessage(timestampedTextAssistant("assistant-8", 9)),
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 3,
    });

    // preserve target is 3 turns -> fallback should cap at 6 role messages
    expect(split.preservedMessages).toHaveLength(6);
    expect(
      split.preservedMessages.some(
        (msg: AgentMessage) =>
          msg.role === "user" && (msg as { content?: unknown }).content === "single user prompt",
      ),
    ).toBe(true);
    expect(preservedTurnsText(split.preservedMessages)).toContain("assistant-8");
    expect(preservedTurnsText(split.preservedMessages)).not.toContain("assistant-2");
  });

  it("trim-starts preserved section when history summary is empty", () => {
    const summary = appendSummarySection(
      "",
      "\n\n## Recent turns preserved verbatim\n- User: hello",
    );
    expect(summary.startsWith("## Recent turns preserved verbatim")).toBe(true);
  });

  it("does not append empty summary sections", () => {
    expect(appendSummarySection("History", "")).toBe("History");
    expect(appendSummarySection("", "")).toBe("");
  });

  it("clamps preserve count into a safe range", () => {
    expect(resolveRecentTurnsPreserve(undefined)).toBe(3);
    expect(resolveRecentTurnsPreserve(-1)).toBe(0);
    expect(resolveRecentTurnsPreserve(99)).toBe(12);
  });
});
