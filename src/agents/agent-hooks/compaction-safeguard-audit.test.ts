import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
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
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  prependPreviousSummaryForRedistill,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality: auditSummaryQualityOwner,
} = testing;

function auditSummaryQuality(
  params: Omit<
    Parameters<typeof compactionQualityModule.auditSummaryQuality>[0],
    "structuralSummary"
  >,
) {
  return auditSummaryQualityOwner({ ...params, structuralSummary: params.summary });
}

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

describe("compaction-safeguard quality audit and structured summaries", () => {
  it.each(["strict", "off"] as const)(
    "audits original result evidence across a lossy history-prune summary (%s)",
    async (identifierPolicy) => {
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages
        .mockResolvedValueOnce("## Results and evidence\nNone captured.")
        .mockResolvedValueOnce(
          [
            "## Decisions\nStatus reviewed.",
            "## Results and evidence\nNone captured.",
            "## Open TODOs\nReport status.",
            "## Constraints/Rules\nPreserve evidence.",
            "## Pending user asks\nReport status.",
            "## Exact identifiers\nNone captured.",
          ].join("\n\n"),
        );
      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture({ contextWindow: 2_000 }),
        maxHistoryShare: 0.5,
        recentTurnsPreserve: 0,
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 0,
        identifierPolicy,
      });
      const event = {
        preparation: {
          messagesToSummarize: [
            {
              role: "user",
              content: `Measured linewidth 17.3 Hz. ${"x".repeat(4_000)}`,
              timestamp: 1,
            },
            { role: "user", content: "y".repeat(4_000), timestamp: 2 },
            { role: "user", content: "Report status.", timestamp: 3 },
          ] as AgentMessage[],
          previousSummary: "## Results and evidence\nMeasured signal 19.2 Hz.",
          turnPrefixMessages: [] as AgentMessage[],
          firstKeptEntryId: "entry-1",
          tokensBefore: 10_000,
          fileOps: { read: [], edited: [], written: [] },
          settings: { reserveTokens: 4_000 },
          summaryTokenBudget: 650,
          isSplitTurn: false,
        },
      };

      const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "***" });
      const summary = expectCompactionResult(result).summary;
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(mockSummarizeInStages.mock.calls[0]?.[0].messages)).toContain(
        "17.3 Hz",
      );
      const resultsSection = summary
        .split("## Results and evidence\n")[1]
        ?.split("## Open TODOs")[0];
      expect(resultsSection).toContain("17.3 Hz");
      expect(resultsSection).toContain("19.2 Hz");
      expect(summary.length).toBeLessThanOrEqual(650 * 4);
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

  it("extracts opaque identifiers and audits summary quality", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Track id a1b2c3d4e5f6 plus A1B2C3D4E5F6 and URL https://example.com/a and /tmp/x.log plus port host.local:18789",
    );
    expect(identifiers).toStrictEqual([
      "A1B2C3D4E5F6", // pragma: allowlist secret
      "https://example.com/a",
      "/tmp/x.log",
      "host.local:18789",
    ]);

    const summary = [
      "## Decisions",
      "Keep current flow.",
      "## Results and evidence\nNone captured.\n## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve identifiers.",
      "## Pending user asks",
      `Latest user request context: ${JSON.stringify("Explain post-compaction behavior for memory indexing")}`,
      "## Exact identifiers",
      identifiers.join(", "),
    ].join("\n");

    const quality = auditSummaryQuality({
      summary,
      identifiers,
      latestAsk: "Explain post-compaction behavior for memory indexing",
    });
    expect(quality.ok).toBe(true);
  });

  it("does not invent a retained ask when the preparation contains no latest user ask", () => {
    const summary = [
      "## Decisions",
      "Keep the existing recovery plan.",
      "## Results and evidence\nNone captured.\n## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve the transcript.",
      "## Pending user asks",
      "None.",
      "## Exact identifiers",
      "None captured.",
    ].join("\n");

    expect(
      auditSummaryQuality({
        summary,
        sourceSummaries: [summary],
        identifiers: [],
        latestAsk: null,
        retainedTurnSummary: summary,
      }),
    ).toEqual({ ok: true, reasons: [] });
  });

  it("scopes retained ask checks to the split-prefix summary", () => {
    const latestAsk = "combine the provider boxes into one artifact";
    const structuredSummary = (pendingAsk: string) =>
      [
        "## Decisions",
        `${latestAsk} after validation.`,
        "## Results and evidence\nNone captured.\n## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve the request state.",
        "## Pending user asks",
        pendingAsk,
        "## Exact identifiers",
        "None.",
      ].join("\n");
    const prefixSummary = (pendingAsk?: string) =>
      [
        "## Original Request",
        latestAsk,
        "## Early Progress",
        "Validated the provider boxes.",
        "## Context for Suffix",
        "The retained suffix owns continuation state.",
        ...(pendingAsk ? ["## Pending user asks", pendingAsk] : []),
      ].join("\n");
    const historySummary = structuredSummary("combine the provider boxes after migration");
    const structuralSummary = structuredSummary(
      `Latest user request context: ${JSON.stringify(latestAsk)}`,
    );
    const auditRetained = (retainedTurnSummary: string) =>
      auditSummaryQuality({
        summary: `${structuralSummary}\n\n${retainedTurnSummary}`,
        sourceSummaries: [historySummary, retainedTurnSummary],
        identifiers: [],
        latestAsk,
        retainedTurnSummary,
      });

    expect(auditRetained(prefixSummary())).toEqual({
      ok: true,
      reasons: [],
    });
    expect(auditRetained(historySummary).reasons).toContain("retained_turn_ask_marked_pending");
    expect(auditRetained(prefixSummary(latestAsk)).reasons).toContain(
      "retained_turn_ask_marked_pending",
    );
  });

  it("dedupes pure-hex identifiers across case variants", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Track id a1b2c3d4e5f6 plus A1B2C3D4E5F6 and again a1b2c3d4e5f6",
    );
    expect(
      identifiers.reduce(
        (count: number, id: string) => count + (id === "A1B2C3D4E5F6" ? 1 : 0), // pragma: allowlist secret
        0,
      ),
    ).toBe(1);
  });

  it("keeps valid host/port identifiers after a long non-identifier token", () => {
    const identifiers = extractOpaqueIdentifiers(
      `${"x".repeat(120_000)} host.local:18789 ` +
        "api.example.com/v1:443 127.0.0.1:8080 sub-domain.example.test:65535",
    );

    expect(identifiers).toStrictEqual([
      "host.local:18789",
      "api.example.com/v1:443",
      "127.0.0.1:8080",
      "sub-domain.example.test:65535",
    ]);
  });

  it("dedupes identifiers before applying the result cap", () => {
    const noisyPrefix = Array.from({ length: 10 }, () => "a0b0c0d0").join(" ");
    const uniqueTail = Array.from(
      { length: 40 },
      (_, idx) => `b${idx.toString(16).padStart(7, "0")}`,
    );
    const identifiers = extractOpaqueIdentifiers(`${noisyPrefix} ${uniqueTail.join(" ")}`);

    expect(identifiers).toHaveLength(40);
    expect(new Set(identifiers).size).toBe(40);
    expect(identifiers).toContain("A0B0C0D0");
    expect(identifiers).toContain(uniqueTail[10]?.toUpperCase());
  });

  it.each([
    {
      name: "decimal and scientific values",
      input:
        "metric=0.123456789 scientific=1.23456789e10 exponent=1e-987654321 order_id=246813579 hash=deadbeef1234 ambiguous=12345678e10",
      expected: ["246813579", "DEADBEEF1234", "12345678E10"], // pragma: allowlist secret
    },
    {
      name: "signed scientific values with long hex-shaped mantissas",
      input: "negative=12345678e-987654321 positive=12345678e+987654321 ambiguous=12345678e10",
      expected: ["12345678E10"],
    },
    {
      name: "dotted values with long unit suffixes",
      input: "latency=0.123456789seconds size=1.23456789e-987654321megabytes metric=12345678.e10",
      expected: [],
    },
    {
      name: "ambiguous integer tokens and decimal-looking opaque identifiers",
      input: "order_id=246813579xy duration=123456789ms revision=1.23456789abcdef",
      expected: ["246813579xy", "123456789ms", "23456789ABCDEF"],
    },
  ])("classifies $name", ({ input, expected }) => {
    expect(extractOpaqueIdentifiers(input)).toStrictEqual(expected);
  });

  it("filters ordinary short numbers and trims wrapped punctuation", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Year 2026 count 42 port 18789 ticket 123456 URL https://example.com/a, path /tmp/x.log, and tiny /a with prose on/off plus typecheck/lint/format.",
    );

    expect(identifiers).not.toContain("2026");
    expect(identifiers).not.toContain("42");
    expect(identifiers).not.toContain("18789");
    expect(identifiers).not.toContain("/a");
    expect(identifiers).not.toContain("/off");
    expect(identifiers).not.toContain("/lint/format");
    expect(identifiers).toContain("123456");
    expect(identifiers).toContain("https://example.com/a");
    expect(identifiers).toContain("/tmp/x.log");
  });

  it("fails quality audit when required sections are missing", () => {
    const quality = auditSummaryQuality({
      summary: "Short summary without structure",
      identifiers: ["abc12345"],
      latestAsk: "Need a status update",
    });
    expect(quality.ok).toBe(false);
    expect(quality.reasons).toStrictEqual([
      "missing_section:## Decisions",
      "missing_section:## Results and evidence",
      "missing_section:## Open TODOs",
      "missing_section:## Constraints/Rules",
      "missing_section:## Pending user asks",
      "missing_section:## Exact identifiers",
      "missing_identifiers:abc12345",
      "latest_user_ask_not_reflected",
    ]);
  });

  it("requires exact section headings instead of substring matches", () => {
    const quality = auditSummaryQuality({
      summary: [
        "See ## Decisions above.",
        "## Results and evidence\nNone captured.\n## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Keep policy.",
        "## Pending user asks",
        "Need status.",
        "## Exact identifiers",
        "abc12345",
      ].join("\n"),
      identifiers: ["abc12345"],
      latestAsk: "Need status.",
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("missing_section:## Decisions");
  });

  it("does not enforce identifier retention when policy is off", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Use redacted summary.",
        "## Results and evidence\nNone captured.\n## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "No sensitive identifiers.",
        "## Pending user asks",
        `Latest user request context: ${JSON.stringify("Provide status.")}`,
        "## Exact identifiers",
        "Redacted.",
      ].join("\n"),
      identifiers: ["sensitive-token-123456"],
      latestAsk: "Provide status.",
      identifierPolicy: "off",
    });

    expect(quality.ok).toBe(true);
  });

  it.each(["off", "custom"] as const)(
    "restores a misplaced source test result through the compaction handler with policy %s",
    async (identifierPolicy) => {
      const sourceResult = "42 tests passed";
      const summary = buildStructuredFallbackSummary(sourceResult);
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockResolvedValue(summaryResult(summary));
      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 0,
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 0,
        identifierPolicy,
      });
      const event = createCompactionEvent({ messageText: sourceResult, tokensBefore: 1_500 });
      (
        event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
      ).settings = { reserveTokens: 4_000 };
      (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

      const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "***" });

      expect(expectCompactionResult(result).summary).toMatch(
        /## Results and evidence[\s\S]*42 tests passed[\s\S]*## Open TODOs/u,
      );
      expect(mockAuditSummaryQuality).toHaveBeenCalledWith(
        expect.objectContaining({ identifierPolicy, identifiers: [sourceResult] }),
      );
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

  it.each(["off", "custom"] as const)(
    "restores a measured value with units to Results through the compaction handler under %s policy",
    async (identifierPolicy) => {
      const sourceResult = "17.3 Hz";
      const sourceMessage = `Report the measured value: ${sourceResult}.`;
      mockSummarizeInStages.mockReset();
      mockSummarizeInStages.mockResolvedValue(
        summaryResult(buildStructuredFallbackSummary(sourceMessage)),
      );
      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 0,
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 0,
        identifierPolicy,
      });
      const event = createCompactionEvent({ messageText: sourceMessage, tokensBefore: 1_500 });
      (
        event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
      ).settings = { reserveTokens: 4_000 };
      (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

      const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "***" });

      expect(expectCompactionResult(result).summary).toMatch(
        /## Results and evidence[\s\S]*17\.3 Hz[\s\S]*## Open TODOs/u,
      );
      expect(mockAuditSummaryQuality).toHaveBeenCalledWith(
        expect.objectContaining({ identifierPolicy, identifiers: [sourceResult] }),
      );
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

  it("reuses the measured Results reservation through the compaction handler", async () => {
    const sourceMessage = "Report 17.3 Hz, 512 MB, 23 °C, and 85%.";
    const measurements = ["17.3 Hz", "512 MB", "23 °C", "85%"];
    const summary = [
      `## Decisions\n${"d".repeat(1200)}`,
      `## Results and evidence\n${measurements.join("\n")}\n${"r".repeat(1200)}`,
      `## Open TODOs\n${"t".repeat(1200)}`,
      `## Constraints/Rules\n${"c".repeat(1200)}`,
      `## Pending user asks\n${sourceMessage}`,
      "## Exact identifiers\nNone.",
    ].join("\n\n");
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult(summary));
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 0,
      identifierPolicy: "off",
    });
    const event = createCompactionEvent({ messageText: sourceMessage, tokensBefore: 1_500 });
    (
      event.preparation as { summaryTokenBudget?: number; settings?: { reserveTokens: number } }
    ).summaryTokenBudget = 250;
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "***" });
    const finalized = expectCompactionResult(result).summary;
    expect(finalized.length).toBeLessThanOrEqual(1_000);
    expect(finalized).toContain(`## Results and evidence\n${measurements.join("\n")}`);
    expect(finalized).toContain("[Compaction summary truncated to fit budget]");
    const retainedOptional = ["d", "t", "c"].reduce(
      (total, char) => total + (finalized.match(new RegExp(`${char}{2,}`, "u"))?.[0].length ?? 0),
      0,
    );
    expect(retainedOptional).toBeGreaterThanOrEqual(510);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    expect(mockAuditSummaryQuality).toHaveBeenCalledWith(
      expect.objectContaining({ identifiers: measurements }),
    );
  });

  it("does not force strict identifier retention for custom policy", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Mask secrets by default.",
        "## Results and evidence\nNone captured.\n## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Follow custom policy.",
        "## Pending user asks",
        `Latest user request context: ${JSON.stringify("Share summary.")}`,
        "## Exact identifiers",
        "Masked by policy.",
      ].join("\n"),
      identifiers: ["api-key-abcdef123456"],
      latestAsk: "Share summary.",
      identifierPolicy: "custom",
    });

    expect(quality.ok).toBe(true);
  });

  it("matches pure-hex identifiers case-insensitively in retention checks", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Results and evidence\nNone captured.\n## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve hex IDs.",
        "## Pending user asks",
        `Latest user request context: ${JSON.stringify("Provide status.")}`,
        "## Exact identifiers",
        "a1b2c3d4e5f6", // pragma: allowlist secret
      ].join("\n"),
      identifiers: ["A1B2C3D4E5F6"], // pragma: allowlist secret
      latestAsk: "Provide status.",
      identifierPolicy: "strict",
    });

    expect(quality.ok).toBe(true);
  });

  it("flags missing non-latin latest asks when summary omits them", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Results and evidence\nNone captured.\n## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve safety checks.",
        "## Pending user asks",
        "No pending asks.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
      identifiers: [],
      latestAsk: "请提供状态更新",
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("latest_user_ask_not_reflected");
  });

  it("rejects a shortened non-latin pending ask without the exact request fact", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Results and evidence\nNone captured.\n## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve safety checks.",
        "## Pending user asks",
        "状态更新 pending.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
      identifiers: [],
      latestAsk: "请提供状态更新",
      latestUnresolvedUserRequest: "请提供状态更新",
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("latest_user_ask_not_foregrounded");
  });

  it("rejects an older pending fallback marker before the latest request", () => {
    const latestAsk = "report whether the deployment is ready";
    const summary = [
      `## Latest user request context\n${JSON.stringify(latestAsk)}`,
      "## Decisions",
      "The deployment readiness report was delivered.",
      "## Results and evidence\nNone captured.\n## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      "Latest user request context:\narchive the previous release notes",
      "## Exact identifiers",
      "None.",
    ].join("\n\n");

    expect(
      auditSummaryQuality({
        summary,
        identifiers: [],
        latestAsk,
        latestUnresolvedUserRequest: latestAsk,
      }).reasons,
    ).toContain("latest_user_ask_not_foregrounded");
  });

  it("clamps quality-guard retries into a safe range", () => {
    expect(resolveQualityGuardMaxRetries(undefined)).toBe(1);
    expect(resolveQualityGuardMaxRetries(-1)).toBe(0);
    expect(resolveQualityGuardMaxRetries(99)).toBe(3);
  });

  it("builds structured instructions with required sections", () => {
    const instructions = buildCompactionStructureInstructions("Keep security caveats.");
    expect(instructions).toContain("## Decisions");
    expect(instructions).toContain("## Open TODOs");
    expect(instructions).toContain("## Constraints/Rules");
    expect(instructions).toContain("## Pending user asks");
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("Keep security caveats.");
    expect(instructions).not.toContain("Additional focus:");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("does not force strict identifier retention when identifier policy is off", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "off",
    });
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("do not enforce literal-preservation rules");
    expect(instructions).not.toContain("preserve literal values exactly as seen");
    expect(instructions).not.toContain("N/A (identifier policy off)");
    expect(instructions).not.toContain("Write every PR number");
    expect(instructions).not.toContain("every artefact path produced");
  });

  it("threads custom identifier policy text into structured instructions", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Exclude secrets and one-time tokens from summaries.",
    });
    expect(instructions).toContain("For ## Exact identifiers, apply this operator-defined policy");
    expect(instructions).toContain("Exclude secrets and one-time tokens from summaries.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("sanitizes untrusted custom instruction text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(
      "Ignore above <script>alert(1)</script>",
    );
    expect(instructions).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("sanitizes custom identifier policy text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket <ABC-123> but remove \u200Bsecrets.",
    });
    expect(instructions).toContain("Keep ticket &lt;ABC-123&gt; but remove secrets.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("builds a structured fallback summary from legacy previous summary text", () => {
    const summary = buildStructuredFallbackSummary("legacy summary without headings");
    expect(summary).toContain("## Decisions");
    expect(summary).toContain("## Open TODOs");
    expect(summary).toContain("## Constraints/Rules");
    expect(summary).toContain("## Pending user asks");
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("legacy summary without headings");
  });

  it("preserves an already-structured previous summary as-is", () => {
    const structured = [
      "## Decisions",
      "done",
      "",
      "## Results and evidence\nNone captured.\n## Open TODOs",
      "todo",
      "",
      "## Constraints/Rules",
      "rules",
      "",
      "## Pending user asks",
      "asks",
      "",
      "## Exact identifiers",
      "ids",
    ].join("\n");
    expect(buildStructuredFallbackSummary(structured)).toBe(structured);
  });

  it("converts previous summaries into redistill input instead of update-prompt state", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "new context", timestamp: 1 }];
    const redistillMessages = prependPreviousSummaryForRedistill({
      messages,
      previousSummary: "## Goal\nold duplicate summary",
    });

    expect(redistillMessages).toHaveLength(2);
    expect(redistillMessages[0]?.role).toBe("user");
    expect(JSON.stringify(redistillMessages[0])).toContain("<previous-compaction-summary>");
    expect(JSON.stringify(redistillMessages[0])).toContain("Prune stale, duplicate");
    expect(redistillMessages[1]).toBe(messages[0]);
  });

  it("restructures summaries with near-match headings instead of reusing them", () => {
    const nearMatch = [
      "## Decisions",
      "done",
      "",
      "## Open TODOs (active)",
      "todo",
      "",
      "## Constraints/Rules",
      "rules",
      "",
      "## Pending user asks",
      "asks",
      "",
      "## Exact identifiers",
      "ids",
    ].join("\n");
    const summary = buildStructuredFallbackSummary(nearMatch);
    expect(summary).not.toBe(nearMatch);
    expect(summary).toContain("\n## Open TODOs\n");
  });

  it("does not force policy-off marker in fallback exact identifiers section", () => {
    const summary = buildStructuredFallbackSummary(undefined);
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("None captured.");
    expect(summary).not.toContain("N/A (identifier policy off).");
  });
});
