import { describe, expect, it } from "vitest";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportEvent,
  observeProviderTransportLogicalCallSettled,
  runWithProviderTransportAccountingObserver,
} from "./provider-transport-accounting.js";
import {
  ANTHROPIC_ROUTE,
  emitAttempt,
  emitConnection,
  emitProviderFallbackCoverage,
  emitServerFallback,
  emitTransportFallback,
  emitZeroSubmission,
  ROUTE,
  startCall,
} from "./provider-transport-accounting.test-support.js";

describe("provider transport accounting settlement transitions", () => {
  it("keeps provider fallback exact when its terminal attempt is not observed", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-without-attempt", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-server-without-attempt",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["not_instrumented", "transport_logical_call_incomplete"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [{ transport: "sse", servingModel: "claude-opus-5" }],
        },
        attempts: { total: 0, totalKind: "lower_bound" },
        providerFallbacks: { total: 1, server: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers attempts, dispatches, and events for server submission without a terminal attempt", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-missing-terminal", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-server-missing-terminal",
        fromModel: ANTHROPIC_ROUTE.model,
        toModel: "claude-opus-5",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        dispatches: { total: 0, totalKind: "lower_bound" },
        connections: { total: 0, totalKind: "exact" },
        fallbacks: { total: 0, totalKind: "exact" },
        providerFallbacks: { total: 1, totalKind: "exact" },
        zeroSubmissions: { total: 0, totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers only attempts and events for unresolved settlement with attempt evidence", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-attempt");
      observeProviderTransportLogicalCallSettled("call-pending-attempt", "completed");
      emitAttempt({ callId: "call-pending-attempt", ordinal: 1, outcome: "failed" });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        attempts: { total: 1, totalKind: "lower_bound" },
        connections: { totalKind: "exact" },
        fallbacks: { totalKind: "exact" },
        providerFallbacks: { totalKind: "exact" },
        zeroSubmissions: { totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("lowers only attempts and events for unresolved settlement with server submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-server", ANTHROPIC_ROUTE);
      observeProviderTransportLogicalCallSettled("call-pending-server", "completed");
      emitServerFallback({
        callId: "call-pending-server",
        fromModel: ANTHROPIC_ROUTE.model,
        toModel: "claude-opus-5",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        connections: { totalKind: "exact" },
        fallbacks: { totalKind: "exact" },
        providerFallbacks: { total: 1, totalKind: "exact" },
        zeroSubmissions: { totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("restores attempts and events exact after matching settlement reconciliation", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-matched");
      observeProviderTransportLogicalCallSettled("call-pending-matched", "completed");
      emitAttempt({ callId: "call-pending-matched", ordinal: 1, outcome: "completed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "exact" },
      },
    });
  });

  it("does not bind transport from a rejected server fallback fact", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-rejected-server", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-rejected-server",
        transport: "sse",
        fromModel: "wrong-serving-model",
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-rejected-server",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        transport: "websocket",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-rejected-server", "completed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { entries: [{ transport: "websocket", outcome: "completed" }] },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("accepts server fallback on a pending transport target and blocks zero-submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-target", ANTHROPIC_ROUTE);
      emitConnection({
        callId: "call-server-target",
        ordinal: 1,
        transport: "websocket",
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      observeProviderTransportEvent({
        type: "fallback",
        eventId: "anthropic-transport-fallback",
        callId: "call-server-target",
        provider: ANTHROPIC_ROUTE.provider,
        model: ANTHROPIC_ROUTE.model,
        api: ANTHROPIC_ROUTE.api,
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
      });
      emitServerFallback({
        callId: "call-server-target",
        transport: "sse",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
      observeProviderTransportEvent({
        type: "submission",
        eventId: "zero-after-server",
        callId: "call-server-target",
        provider: ANTHROPIC_ROUTE.provider,
        model: ANTHROPIC_ROUTE.model,
        api: ANTHROPIC_ROUTE.api,
        transport: "sse",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      });
      emitAttempt({
        callId: "call-server-target",
        ordinal: 1,
        reason: "transport_fallback",
        route: ANTHROPIC_ROUTE,
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-server-target", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial", reasons: expect.arrayContaining(["transport_event_conflict"]) },
      snapshot: {
        logicalCalls: { completed: 1, entries: [{ servingModel: "claude-opus-5" }] },
        providerFallbacks: { total: 1 },
        zeroSubmissions: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("reconciles settlement before matching attempt telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-first");
      observeProviderTransportLogicalCallSettled("call-settle-first", "completed");
      emitAttempt({ callId: "call-settle-first", ordinal: 1, outcome: "completed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps early completed settlement pending across a failed attempt and retry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-retry");
      observeProviderTransportLogicalCallSettled("call-settle-retry", "completed");
      emitAttempt({ callId: "call-settle-retry", ordinal: 1, outcome: "failed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "lower_bound" },
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId: "call-settle-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 2, retries: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps an early failed settlement open until later terminal retry telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-settle-retry");
      observeProviderTransportLogicalCallSettled("call-failed-settle-retry", "failed");
      emitAttempt({ callId: "call-failed-settle-retry", ordinal: 1, outcome: "failed" });
      emitAttempt({
        callId: "call-failed-settle-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 2, retries: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps failed attempt evidence open when settlement arrives before delayed retry telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-evidence-settle-retry");
      emitAttempt({
        callId: "call-failed-evidence-settle-retry",
        ordinal: 1,
        outcome: "failed",
      });
      observeProviderTransportLogicalCallSettled("call-failed-evidence-settle-retry", "failed");
      emitAttempt({
        callId: "call-failed-evidence-settle-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 2, retries: 1, totalKind: "exact" },
      },
    });
  });

  it("keeps failed zero-submission evidence open when settlement precedes retry telemetry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-zero-settle-retry");
      emitZeroSubmission({ callId: "call-failed-zero-settle-retry", outcome: "failed" });
      observeProviderTransportLogicalCallSettled("call-failed-zero-settle-retry", "failed");
      emitAttempt({
        callId: "call-failed-zero-settle-retry",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "lower_bound" },
        attempts: { total: 1, retries: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it.each([
    {
      name: "failed attempt",
      emitEvidence: (callId: string) => emitAttempt({ callId, ordinal: 1, outcome: "failed" }),
      expected: {
        attempts: { total: 1, totalKind: "exact" },
        zeroSubmissions: { total: 0, totalKind: "exact" },
      },
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
    },
    {
      name: "failed zero-submission",
      emitEvidence: (callId: string) => emitZeroSubmission({ callId, outcome: "failed" }),
      expected: {
        attempts: { total: 0, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
      coverage: { state: "complete" },
    },
  ])(
    "finalizes terminal $name only at observation completion",
    ({ emitEvidence, expected, coverage }) => {
      const callId = "call-failed-observation-complete";
      const collector = createProviderTransportAccountingCollector();
      runWithProviderTransportAccountingObserver(collector.observer, () => {
        startCall(callId);
        emitEvidence(callId);
        observeProviderTransportLogicalCallSettled(callId, "failed");
      });

      expect(collector.project()).toMatchObject({
        coverage: { state: "partial" },
        snapshot: {
          attempts: { totalKind: "lower_bound" },
          events: { totalKind: "lower_bound" },
        },
      });

      collector.finalize(callId);
      collector.finalize(callId);

      expect(collector.project()).toMatchObject({
        coverage,
        snapshot: {
          logicalCalls: { failed: 1, outcomeKind: "exact" },
          events: { total: 1, totalKind: "exact" },
          ...expected,
        },
      });

      runWithProviderTransportAccountingObserver(collector.observer, () => {
        emitAttempt({
          callId,
          ordinal: 2,
          reason: "retry",
          outcome: "completed",
        });
      });

      expect(collector.project()).toMatchObject({
        coverage: {
          state: "partial",
          reasons: expect.arrayContaining(["transport_event_conflict"]),
        },
        snapshot: {
          attempts: { total: expected.attempts.total, totalKind: "lower_bound" },
        },
      });
    },
  );

  it("keeps a finalized call partial when a fallback target never reports terminal evidence", () => {
    const callId = "call-finalized-pending-fallback";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitAttempt({
        callId,
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId,
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "stream_failure",
      });
      observeProviderTransportLogicalCallSettled(callId, "failed");
    });

    collector.finalize(callId);
    collector.finalize(callId);

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "lower_bound" },
        fallbacks: { total: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "lower_bound" },
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId,
        ordinal: 2,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        attempts: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("keeps early completed settlement open across failed zero-submission and retry", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-zero-retry");
      observeProviderTransportLogicalCallSettled("call-settle-zero-retry", "completed");
      emitZeroSubmission({ callId: "call-settle-zero-retry", outcome: "failed" });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { completed: 1, outcomeKind: "exact" },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { totalKind: "lower_bound" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });

    runWithProviderTransportAccountingObserver(collector.observer, () => {
      emitAttempt({
        callId: "call-settle-zero-retry",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 1, retries: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it.each([
    {
      name: "attempt",
      lowerBoundKey: "attempts",
      emit: (callId: string) =>
        emitAttempt({
          callId,
          ordinal: 1,
          reason: "retry",
          outcome: "completed",
        }),
    },
    {
      name: "connection",
      lowerBoundKey: "connections",
      emit: (callId: string) =>
        emitConnection({
          callId,
          ordinal: 1,
          reason: "reconnect",
          outcome: "completed",
        }),
    },
    {
      name: "transport fallback",
      lowerBoundKey: "fallbacks",
      emit: (callId: string) =>
        emitTransportFallback({
          callId,
          fromTransport: ROUTE.transport,
          toTransport: "websocket",
          reason: "policy",
        }),
    },
    {
      name: "provider fallback",
      lowerBoundKey: "providerFallbacks",
      emit: (callId: string) =>
        emitServerFallback({
          callId,
          fromModel: ANTHROPIC_ROUTE.model,
          toModel: "claude-fable-5.1",
        }),
    },
    {
      name: "additional zero-submission",
      lowerBoundKey: "zeroSubmissions",
      emit: (callId: string) => emitZeroSubmission({ callId, outcome: "failed" }),
    },
    {
      name: "coverage",
      lowerBoundKey: "providerFallbacks",
      emit: (callId: string) => emitProviderFallbackCoverage({ callId }),
    },
  ] as const)("rejects $name after an aborted zero-submission", ({ emit, lowerBoundKey }) => {
    const callId = "call-aborted-zero-terminal";
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall(callId);
      emitZeroSubmission({ callId, outcome: "aborted" });
      emit(callId);
      observeProviderTransportLogicalCallSettled(callId, "aborted");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        logicalCalls: { aborted: 1 },
        [lowerBoundKey]: { totalKind: "lower_bound" },
        zeroSubmissions: { total: 1, aborted: 1, failed: 0 },
      },
    });
  });

  it("keeps a failed zero-submission retryable", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-failed-zero-retryable");
      emitZeroSubmission({ callId: "call-failed-zero-retryable", outcome: "failed" });
      emitAttempt({
        callId: "call-failed-zero-retryable",
        ordinal: 1,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-failed-zero-retryable", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 1, retries: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it("separates outcome uncertainty from known logical-call cardinality", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-outcome-conflict");
      emitAttempt({ callId: "call-outcome-conflict", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-outcome-conflict", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          total: 1,
          totalKind: "exact",
          outcomeKind: "lower_bound",
          failed: 1,
        },
        events: { totalKind: "exact" },
      },
    });
  });

  it("makes identical settlement idempotent and contradictory settlement outcome-only", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-settle-idempotent");
      emitAttempt({ callId: "call-settle-idempotent", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "completed");
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "completed");
      observeProviderTransportLogicalCallSettled("call-settle-idempotent", "failed");
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          totalKind: "exact",
          outcomeKind: "lower_bound",
          completed: 1,
        },
        events: { totalKind: "exact" },
      },
    });
  });

  it("reconciles a pending failed settlement when observation seals", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-sealed-failed");
      emitAttempt({ callId: "call-sealed-failed", ordinal: 1, outcome: "failed" });
      observeProviderTransportLogicalCallSettled("call-sealed-failed", "failed");
    });

    expect(collector.project().snapshot?.attempts.totalKind).toBe("lower_bound");
    collector.seal();
    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "exact" },
        attempts: { total: 1, totalKind: "exact" },
        events: { totalKind: "exact" },
      },
    });
  });

  it("promotes a pending aborted settlement at seal without inventing transport facts", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-sealed-aborted");
      observeProviderTransportLogicalCallSettled("call-sealed-aborted", "aborted");
    });

    collector.seal();
    expect(collector.project()).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["not_instrumented"]),
      },
      snapshot: {
        logicalCalls: { aborted: 1, outcomeKind: "exact" },
        attempts: { total: 0, totalKind: "lower_bound" },
        dispatches: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("keeps a call without settlement incomplete after sealing", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-sealed-unsettled");
    });

    collector.seal();
    expect(collector.project()).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_logical_call_incomplete"]),
      },
      snapshot: {
        logicalCalls: { total: 1, outcomeKind: "lower_bound" },
      },
    });
  });

  it("rejects new post-seal events without changing call or outcome certainty", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-post-seal");
      emitAttempt({ callId: "call-post-seal", ordinal: 1, outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-post-seal", "completed");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "connection-after-seal",
        callId: "call-post-seal",
        ...ROUTE,
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { totalKind: "exact", outcomeKind: "exact", completed: 1 },
        connections: { total: 0, totalKind: "lower_bound" },
      },
    });
  });
});
