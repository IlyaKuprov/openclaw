import type { AiModelTransportEvent } from "@openclaw/ai";
import { describe, expect, it } from "vitest";
import { createCodeModeStats } from "../agents/code-mode-stats.js";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import {
  agentExecTraceTesting,
  projectAgentExecTrace,
  type AgentExecDispatchReceipt,
} from "./agent-exec-trace.js";
import { classifyAgentExecResult } from "./agent-exec.js";

const PROVIDER = "openai";
const MODEL = "gpt-test";
const API = "responses";
const TRANSPORT = "sse";

function attemptEvent(callId: string, ordinal = 1): AiModelTransportEvent {
  return {
    eventId: `attempt-${callId}-${String(ordinal)}`,
    type: "attempt",
    provider: PROVIDER,
    model: MODEL,
    api: API,
    callId,
    transport: TRANSPORT,
    ordinal,
    reason: ordinal === 1 ? "initial" : "retry",
    outcome: "completed",
  };
}

function coverageEvent(
  callId: string,
  reason:
    | "transport_terminal_unverified"
    | "transport_endpoint_authority_partial"
    | "transport_submission_authority_partial",
): AiModelTransportEvent {
  return {
    eventId: `coverage-${callId}-${reason}`,
    type: "coverage",
    scope: "transport_semantics",
    state: "unverified",
    reason,
    provider: PROVIDER,
    model: MODEL,
    api: API,
    callId,
    transport: TRANSPORT,
  };
}

function snapshot(callCount = 2): AgentCommandRunAccountingSnapshot {
  const callIds = Array.from({ length: callCount }, (_, index) => `call-${String(index + 1)}`);
  const codeModeStats = createCodeModeStats();
  codeModeStats.bridgeCalls = { search: 1, call: 2 };
  codeModeStats.bridgeLifecycle = {
    registered: 3,
    started: 3,
    settled: 3,
    unresolvedAtExtraction: 0,
  };
  const events = callIds.map((callId) => attemptEvent(callId));
  return {
    candidates: {
      total: 1,
      returned: 1,
      threw: 0,
      runtimes: { embedded: 1, cli: 0, native: 0, cloud: 0, unknown: 0 },
      entries: [
        {
          provider: PROVIDER,
          model: MODEL,
          runtime: "embedded",
          outcome: "returned",
          effectiveModels: {
            entries: [{ provider: PROVIDER, model: MODEL }],
            truncated: 0,
          },
        },
      ],
      truncated: 0,
    },
    agentSubmissions: { total: 1, completed: 1, failed: 0 },
    modelCalls: { total: callCount, completed: callCount, failed: 0 },
    assistantTurns: callCount,
    usage: {
      input: 100,
      cacheRead: 20,
      cacheWrite: 0,
      output: 30,
      reasoningTokens: 10,
      total: 140,
    },
    toolSummary: { calls: 1, tools: ["read"] },
    providerTransport: {
      logicalCalls: {
        total: callCount,
        totalKind: "exact",
        outcomeKind: "exact",
        completed: callCount,
        failed: 0,
        aborted: 0,
        entries: callIds.map((callId, index) => ({
          callId,
          provider: PROVIDER,
          model: MODEL,
          api: API,
          transport: TRANSPORT,
          outcome: "completed",
          cachedInput: { state: "exact", tokens: index === 0 ? 7 : 13 },
        })),
        entriesTruncated: false,
      },
      attempts: {
        total: callCount,
        totalKind: "exact",
        initial: callCount,
        retries: 0,
        authRecoveries: 0,
        payloadRecoveries: 0,
        transportFallbacks: 0,
      },
      connections: {
        total: 0,
        totalKind: "exact",
        initial: 0,
        prewarms: 0,
        reconnects: 0,
      },
      fallbacks: {
        total: 0,
        totalKind: "exact",
        unsupported: 0,
        connectionFailures: 0,
        submissionFailures: 0,
        streamFailures: 0,
        policy: 0,
      },
      providerFallbacks: { total: 0, totalKind: "exact", server: 0 },
      zeroSubmissions: { total: 0, totalKind: "exact", failed: 0, aborted: 0 },
      events: {
        total: events.length,
        totalKind: "exact",
        entries: events,
        entriesTruncated: false,
      },
    },
    commandExecutionDurationMs: 125,
    coverage: {
      candidates: { state: "complete" },
      agentSubmissions: { state: "complete" },
      modelCalls: { state: "complete" },
      assistantTurns: { state: "complete" },
      usage: { state: "complete" },
      usageBuckets: {
        input: { state: "complete" },
        output: { state: "complete" },
        cacheRead: { state: "complete" },
        cacheWrite: { state: "complete" },
        reasoningTokens: { state: "complete" },
        total: { state: "complete" },
      },
      tools: { state: "complete" },
      cost: { state: "complete" },
      agentTime: { state: "complete" },
      commandExecutionDuration: { state: "complete" },
      wallLatency: { state: "complete" },
      providerTransport: { state: "complete" },
    },
    codeMode: {
      engaged: true,
      stats: codeModeStats,
      lifecycle: {
        maxUnresolvedAtExtraction: 0,
        attemptsWithUnresolved: 0,
        finalQuiescence: { state: "quiescent" },
      },
    },
  };
}

function receipt(
  source: AgentCommandRunAccountingSnapshot,
  dispatches?: readonly number[],
): AgentExecDispatchReceipt {
  const calls = source.providerTransport?.logicalCalls.entries ?? [];
  const perCall = dispatches ?? calls.map(() => 1);
  return {
    schemaVersion: 1,
    authority: "host_dispatch_guard",
    complete: true,
    truncated: false,
    route: { provider: PROVIDER, model: MODEL, api: API },
    logicalCalls: calls.length,
    physicalFetchDispatch: perCall.reduce((total, value) => total + value, 0),
    calls: calls.map((call, index) => ({
      ordinal: index + 1,
      callIdSha256: agentExecTraceTesting.hashCallId(call.callId),
      physicalFetchDispatch: perCall[index] ?? 0,
    })),
  };
}

function project(
  source: AgentCommandRunAccountingSnapshot,
  dispatchReceipt: AgentExecDispatchReceipt | undefined = receipt(source),
) {
  return projectAgentExecTrace({
    snapshot: source,
    agentDurationMs: 110,
    codeModeEngaged: true,
    dispatchReceipt,
    provider: PROVIDER,
    model: MODEL,
  });
}

function expectInconclusiveReason(
  source: AgentCommandRunAccountingSnapshot,
  reason: string,
  dispatchReceipt = receipt(source),
): void {
  const trace = project(source, dispatchReceipt);
  expect(trace?.audit).toEqual({
    state: "inconclusive",
    reasons: expect.arrayContaining([reason]),
  });
}

describe("agent exec frontier trace projection", () => {
  it("projects an exact conserved happy path", () => {
    const source = snapshot();
    const trace = project(source);

    expect(trace).toMatchObject({
      route: { provider: PROVIDER, model: MODEL, api: API, runtime: "embedded" },
      metrics: {
        effectiveTurns: { state: "exact", value: 2 },
        logicalModelCalls: { state: "exact", value: 2 },
        providerAttempts: {
          total: { state: "exact", value: 2 },
          retries: { state: "exact", value: 0 },
        },
        physicalFetchDispatch: { state: "exact", value: 2 },
        outerToolCalls: { state: "exact", value: 1 },
        codeModeBridgeCalls: { state: "exact", value: 3 },
        totalToolOperations: { state: "exact", value: 4 },
        underlyingTotalCalls: { state: "exact", value: 6 },
        tokens: {
          input: { state: "exact", value: 100 },
          cachedInput: { state: "exact", value: 20 },
          firstLogicalCallCachedInput: { state: "exact", value: 7 },
          output: { state: "exact", value: 30 },
          reasoning: { state: "exact", value: 10 },
          total: { state: "exact", value: 140 },
        },
        agentDurationMs: { state: "exact", value: 110 },
        commandExecutionDurationMs: { state: "exact", value: 125 },
      },
      audit: { state: "valid" },
    });
  });

  it("conserves mixed physical dispatch counts across multiple calls", () => {
    const source = snapshot(3);
    const trace = project(source, receipt(source, [1, 2, 3]));

    expect(trace?.metrics).toMatchObject({
      logicalModelCalls: { state: "exact", value: 3 },
      providerAttempts: { total: { state: "exact", value: 3 } },
      physicalFetchDispatch: { state: "exact", value: 6 },
      totalToolOperations: { state: "exact", value: 4 },
      underlyingTotalCalls: { state: "exact", value: 10 },
    });
    expect(trace?.audit).toEqual({ state: "valid" });
  });

  it("keeps calls and attempts exact while retry token attribution is inconclusive", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    transport.attempts.total = 3;
    transport.attempts.retries = 1;
    transport.events.entries.push(attemptEvent("call-1", 2));
    transport.events.total = transport.events.entries.length;
    const trace = project(source, receipt(source, [2, 1]));

    expect(trace?.metrics.logicalModelCalls).toEqual({ state: "exact", value: 2 });
    expect(trace?.metrics.providerAttempts.total).toEqual({ state: "exact", value: 3 });
    expect(trace?.metrics.tokens.total).toEqual({
      state: "lower_bound",
      value: 140,
      reasons: expect.arrayContaining([
        "provider_attempt_usage_unattributed",
        "provider_attempt_usage_unproven",
      ]),
    });
    expectInconclusiveReason(
      source,
      "provider_attempt_usage_unattributed",
      receipt(source, [2, 1]),
    );
  });

  for (const reason of [
    "transport_terminal_unverified",
    "transport_endpoint_authority_partial",
    "transport_submission_authority_partial",
  ] as const) {
    it(`rejects ${reason} as trace authority`, () => {
      const source = snapshot();
      const transport = source.providerTransport!;
      transport.events.entries.push(coverageEvent("call-1", reason));
      transport.events.total = transport.events.entries.length;
      source.coverage.providerTransport = { state: "partial", reasons: [reason] };
      if (reason === "transport_submission_authority_partial") {
        transport.attempts.totalKind = "lower_bound";
        source.coverage.providerTransport.reasons.push("transport_totals_lower_bound");
      }

      const trace = project(source);
      expect(trace?.route).toBeUndefined();
      expectInconclusiveReason(source, reason);
    });
  }

  it("rejects provider lower-bound coverage", () => {
    const source = snapshot();
    source.providerTransport!.logicalCalls.totalKind = "lower_bound";
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_totals_lower_bound"],
    };

    expectInconclusiveReason(source, "provider_logical_calls_lower_bound");
  });

  it("rejects unavailable terminal fallback metadata", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    transport.providerFallbacks.totalKind = "lower_bound";
    transport.events.entries.push({
      eventId: "coverage-call-1-terminal-metadata",
      type: "coverage",
      scope: "provider_fallbacks",
      state: "lower_bound",
      reason: "terminal_metadata_unavailable",
      provider: PROVIDER,
      model: MODEL,
      api: API,
      callId: "call-1",
      transport: TRANSPORT,
    });
    transport.events.total = transport.events.entries.length;
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_totals_lower_bound"],
    };

    expectInconclusiveReason(source, "terminal_metadata_unavailable");
  });

  it("rejects truncated transport evidence", () => {
    const source = snapshot();
    source.providerTransport!.events.entriesTruncated = true;
    source.coverage.providerTransport = {
      state: "partial",
      reasons: ["transport_details_truncated"],
    };

    expectInconclusiveReason(source, "provider_events_truncated");
  });

  it("rejects missing provider ledger conservation", () => {
    const source = snapshot();
    source.providerTransport!.events.total += 1;

    expectInconclusiveReason(source, "provider_event_entries_incomplete");
    expectInconclusiveReason(source, "provider_event_conservation_mismatch");
  });

  it("rejects model and provider terminal outcome disagreement", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    transport.logicalCalls.completed = 1;
    transport.logicalCalls.aborted = 1;
    transport.logicalCalls.entries[1]!.outcome = "aborted";

    expectInconclusiveReason(source, "model_provider_completed_count_mismatch");
    expectInconclusiveReason(source, "model_provider_failed_count_mismatch");
  });

  for (const reason of ["transport_observer_failed", "settled_finalization_failed"] as const) {
    it(`rejects ${reason} coverage`, () => {
      const source = snapshot();
      source.coverage.providerTransport = { state: "partial", reasons: [reason] };

      expectInconclusiveReason(source, reason);
    });
  }

  it("rejects a missing physical dispatch receipt", () => {
    const source = snapshot();
    const trace = projectAgentExecTrace({
      snapshot: source,
      agentDurationMs: 110,
      codeModeEngaged: true,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(trace?.audit).toEqual({
      state: "inconclusive",
      reasons: expect.arrayContaining(["dispatch_receipt_unavailable"]),
    });
  });

  it("requires outer result route identity", () => {
    const source = snapshot();
    const trace = projectAgentExecTrace({
      snapshot: source,
      agentDurationMs: 110,
      codeModeEngaged: true,
      dispatchReceipt: receipt(source),
    });

    expect(trace?.route).toBeUndefined();
    expect(trace?.audit).toEqual({
      state: "inconclusive",
      reasons: expect.arrayContaining(["reported_route_identity_missing"]),
    });
  });

  it("rejects duplicate or reordered receipt call identities", () => {
    const source = snapshot();
    const duplicate = receipt(source);
    duplicate.calls[1]!.callIdSha256 = duplicate.calls[0]!.callIdSha256;
    expectInconclusiveReason(source, "dispatch_receipt_call_identity_duplicate", duplicate);

    const reordered = receipt(source);
    [reordered.calls[0]!.callIdSha256, reordered.calls[1]!.callIdSha256] = [
      reordered.calls[1]!.callIdSha256,
      reordered.calls[0]!.callIdSha256,
    ];
    expectInconclusiveReason(source, "dispatch_provider_ledger_mismatch", reordered);
  });

  it("rejects unresolved Code Mode bridge work", () => {
    const source = snapshot();
    source.codeMode!.lifecycle.attemptsWithUnresolved = 1;
    source.codeMode!.lifecycle.maxUnresolvedAtExtraction = 1;

    expectInconclusiveReason(source, "code_mode_unresolved_bridge_calls");
  });

  it("rejects Code Mode bridge lifecycle disagreement", () => {
    const source = snapshot();
    source.codeMode!.stats!.bridgeLifecycle.registered = 2;

    expectInconclusiveReason(source, "code_mode_bridge_lifecycle_conservation_mismatch");
  });

  it("rejects overlapping Code Mode failure and cancellation ledgers", () => {
    const source = snapshot();
    source.codeMode!.stats!.bridgeLifecycle.failed = 3;
    source.codeMode!.stats!.bridgeLifecycle.cancelRequested = 3;

    expectInconclusiveReason(source, "code_mode_bridge_lifecycle_conservation_mismatch");
  });

  it("requires explicit direct configuration before projecting zero bridge calls", () => {
    const source = snapshot();
    delete source.codeMode;
    const dispatchReceipt = receipt(source);
    const base = {
      snapshot: source,
      agentDurationMs: 110,
      codeModeEngaged: false,
      dispatchReceipt,
      provider: PROVIDER,
      model: MODEL,
    } as const;

    expect(projectAgentExecTrace(base)?.metrics.codeModeBridgeCalls).toEqual({
      state: "unavailable",
      reasons: ["code_mode_stats_not_observed"],
    });
    const directTrace = projectAgentExecTrace({ ...base, codeModeConfigured: false });
    expect(directTrace?.metrics.codeModeBridgeCalls).toEqual({ state: "exact", value: 0 });
    expect(directTrace?.audit).toEqual({ state: "valid" });
  });

  it("adds an explicitly projected trace to the stable envelope without changing normal runs", () => {
    const source = snapshot();
    const trace = project(source)!;
    const result = {
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 110,
        agentMeta: {
          sessionId: "session-result",
          provider: PROVIDER,
          model: MODEL,
        },
      },
    };

    expect(classifyAgentExecResult(result)).not.toHaveProperty("trace");
    const envelope = classifyAgentExecResult(result, false, undefined, trace);
    expect(envelope.trace).toEqual(trace);
    expect(envelope.trace).not.toBe(trace);
    trace.metrics.logicalModelCalls.value = 99;
    expect(envelope.trace?.metrics.logicalModelCalls).toEqual({ state: "exact", value: 2 });
  });
});
