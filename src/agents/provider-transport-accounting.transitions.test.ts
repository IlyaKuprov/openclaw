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
  emitTransportSemanticCoverage,
  emitTransportFallback,
  emitZeroSubmission,
  ROUTE,
  startCall,
} from "./provider-transport-accounting.test-support.js";

describe("provider transport accounting transitions", () => {
  it("requires first initial, then same-route retry reasons", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-retry");
      emitAttempt({ callId: "call-retry", ordinal: 1, outcome: "failed" });
      emitAttempt({ callId: "call-retry", ordinal: 2, reason: "retry", outcome: "completed" });
      observeProviderTransportLogicalCallSettled("call-retry", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        attempts: { total: 2, initial: 1, retries: 1, transportFallbacks: 0 },
        logicalCalls: { completed: 1 },
      },
    });
  });

  it("rejects transport_fallback without a pending transport target", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-unmatched-fallback");
      emitAttempt({
        callId: "call-unmatched-fallback",
        ordinal: 1,
        reason: "transport_fallback",
        outcome: "completed",
      });
    });

    expect(collector.project()).toMatchObject({
      snapshot: { attempts: { total: 0, totalKind: "lower_bound" } },
    });
  });

  it("consumes a pre-send transport fallback on ordinal one", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pre-send");
      emitConnection({
        callId: "call-pre-send",
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-pre-send",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
      });
      emitAttempt({
        callId: "call-pre-send",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pre-send", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [{ transport: "sse", servingModel: ROUTE.model, outcome: "completed" }],
        },
        attempts: { total: 1, transportFallbacks: 1 },
        fallbacks: { total: 1, connectionFailures: 1 },
      },
    });
  });

  it("counts a submission failure fallback separately from connection failures", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-submit-failure");
      emitConnection({
        callId: "call-submit-failure",
        ordinal: 1,
        transport: "websocket",
        outcome: "completed",
      });
      emitZeroSubmission({
        callId: "call-submit-failure",
        outcome: "failed",
        transport: "websocket",
      });
      emitTransportFallback({
        callId: "call-submit-failure",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "submission_failure",
      });
      emitAttempt({
        callId: "call-submit-failure",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-submit-failure", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        attempts: { total: 1, transportFallbacks: 1 },
        fallbacks: {
          total: 1,
          connectionFailures: 0,
          submissionFailures: 1,
          streamFailures: 0,
        },
      },
    });
  });

  it("accepts cached-route submission failure without inventing a connection", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-cached-submit-failure");
      emitZeroSubmission({
        callId: "call-cached-submit-failure",
        outcome: "failed",
        transport: "websocket",
      });
      emitTransportFallback({
        callId: "call-cached-submit-failure",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "submission_failure",
      });
      emitAttempt({
        callId: "call-cached-submit-failure",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-cached-submit-failure", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        connections: { total: 0, totalKind: "exact" },
        attempts: { total: 1, transportFallbacks: 1, totalKind: "exact" },
        fallbacks: { total: 1, submissionFailures: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
      },
    });
  });

  it("rejects stale or wrong phase causes without mutating the route", () => {
    const staleCollector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(staleCollector.observer, () => {
      startCall("call-stale-connection");
      emitConnection({
        callId: "call-stale-connection",
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitConnection({
        callId: "call-stale-connection",
        ordinal: 2,
        transport: "websocket",
        outcome: "completed",
      });
      emitTransportFallback({
        callId: "call-stale-connection",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
      });
    });

    expect(staleCollector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_invalid_fact", "transport_totals_lower_bound"]),
      },
      snapshot: {
        connections: { total: 2, totalKind: "lower_bound" },
        fallbacks: { total: 0, totalKind: "lower_bound" },
      },
    });

    const wrongReasonCollector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(wrongReasonCollector.observer, () => {
      startCall("call-wrong-submission-cause");
      emitAttempt({
        callId: "call-wrong-submission-cause",
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-wrong-submission-cause",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "submission_failure",
        eventId: "wrong-submission-cause",
      });
      emitTransportFallback({
        callId: "call-wrong-submission-cause",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "stream_failure",
        eventId: "valid-stream-cause",
      });
      emitAttempt({
        callId: "call-wrong-submission-cause",
        ordinal: 2,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-wrong-submission-cause", "completed");
    });

    expect(wrongReasonCollector.project()).toMatchObject({
      coverage: { state: "partial", reasons: expect.arrayContaining(["transport_invalid_fact"]) },
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 2, transportFallbacks: 1 },
        fallbacks: { total: 1, submissionFailures: 0, streamFailures: 1 },
        zeroSubmissions: { total: 0, totalKind: "lower_bound" },
      },
    });

    const noMutationCollector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(noMutationCollector.observer, () => {
      startCall("call-rejected-fallback-route");
      emitTransportFallback({
        callId: "call-rejected-fallback-route",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
        eventId: "rejected-missing-cause",
      });
      emitTransportFallback({
        callId: "call-rejected-fallback-route",
        fromTransport: "http2",
        toTransport: "sse",
        reason: "policy",
        eventId: "valid-policy-fallback",
      });
      emitAttempt({
        callId: "call-rejected-fallback-route",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-rejected-fallback-route", "completed");
    });

    expect(noMutationCollector.project()).toMatchObject({
      snapshot: {
        logicalCalls: { completed: 1 },
        attempts: { total: 1, transportFallbacks: 1 },
        fallbacks: { total: 1, policy: 1 },
      },
    });
  });

  it("rejects failure fallbacks without their causal source event", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-missing-fallback-cause");
      emitTransportFallback({
        callId: "call-missing-fallback-cause",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "connection_failure",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_invalid_fact"]),
      },
      snapshot: {
        connections: { total: 0, totalKind: "lower_bound" },
        fallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });

    const streamCollector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(streamCollector.observer, () => {
      startCall("call-missing-stream-cause");
      emitConnection({
        callId: "call-missing-stream-cause",
        ordinal: 1,
        transport: "websocket",
        outcome: "completed",
      });
      emitTransportFallback({
        callId: "call-missing-stream-cause",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "stream_failure",
      });
    });

    expect(streamCollector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_invalid_fact"]),
      },
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        fallbacks: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("consumes a post-send transport fallback on the next ordinal", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-post-send");
      emitAttempt({
        callId: "call-post-send",
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-post-send",
        fromTransport: "websocket",
        toTransport: "sse",
        reason: "stream_failure",
      });
      emitAttempt({
        callId: "call-post-send",
        ordinal: 2,
        reason: "transport_fallback",
        transport: "sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-post-send", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        attempts: { total: 2, initial: 1, retries: 0, transportFallbacks: 1 },
        fallbacks: { total: 1, streamFailures: 1 },
      },
    });
  });

  it("lowers only attempts when an accepted fallback target remains pending", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pending-target");
      emitAttempt({ callId: "call-pending-target", ordinal: 1, outcome: "failed" });
      emitTransportFallback({
        callId: "call-pending-target",
        fromTransport: ROUTE.transport,
        toTransport: "sse",
      });
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { outcomeKind: "lower_bound" },
        attempts: { total: 1, totalKind: "lower_bound" },
        fallbacks: { total: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "exact" },
      },
    });
  });

  it("lets target connections validate without consuming a pending fallback", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-target-connection");
      emitTransportFallback({
        callId: "call-target-connection",
        fromTransport: "websocket",
        toTransport: "sse",
      });
      observeProviderTransportLogicalCallSettled("call-target-connection", "completed");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "target-connection",
        callId: "call-target-connection",
        provider: ROUTE.provider,
        model: ROUTE.model,
        api: ROUTE.api,
        transport: "sse",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      emitAttempt({
        callId: "call-target-connection",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "sse",
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
        connections: { total: 1 },
        attempts: { transportFallbacks: 1 },
      },
    });
  });

  it("consumes a pending fallback with route-phase zero-submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-target");
      emitAttempt({
        callId: "call-zero-target",
        ordinal: 1,
        transport: "websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-zero-target",
        fromTransport: "websocket",
        toTransport: "sse",
      });
      emitZeroSubmission({ callId: "call-zero-target", outcome: "aborted", transport: "sse" });
      observeProviderTransportLogicalCallSettled("call-zero-target", "aborted");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: { aborted: 1 },
        attempts: { total: 1 },
        zeroSubmissions: { total: 1, aborted: 1 },
      },
    });
  });

  it("allows zero-submission on the current route after earlier failed attempts", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-retry");
      emitAttempt({ callId: "call-zero-retry", ordinal: 1, outcome: "failed" });
      emitZeroSubmission({ callId: "call-zero-retry", outcome: "failed" });
      observeProviderTransportLogicalCallSettled("call-zero-retry", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        attempts: { total: 1, totalKind: "lower_bound" },
        zeroSubmissions: { total: 1 },
        logicalCalls: { failed: 1 },
      },
    });
  });

  it("keeps an explicit first-phase zero-submission at exact zero attempts", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-zero-initial");
      emitZeroSubmission({ callId: "call-zero-initial", outcome: "failed" });
      observeProviderTransportLogicalCallSettled("call-zero-initial", "failed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "partial" },
      snapshot: {
        logicalCalls: { failed: 1, outcomeKind: "exact" },
        attempts: { total: 0, totalKind: "lower_bound" },
        connections: { total: 0, totalKind: "exact" },
        fallbacks: { total: 0, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("accepts chained in-stream server fallback before the terminal attempt", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-server-chain", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-server-chain",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
      });
      emitServerFallback({
        callId: "call-server-chain",
        fromModel: "claude-opus-4-8",
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-server-chain",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-server-chain", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [
            {
              provider: "anthropic",
              model: "claude-fable-5",
              transport: "sse",
              servingModel: "claude-opus-5",
              outcome: "completed",
            },
          ],
        },
        providerFallbacks: { total: 2, server: 2 },
      },
    });
  });

  it("resets serving model to the requested model on a new retry submission", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-serving-reset", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-serving-reset",
        fromModel: ANTHROPIC_ROUTE.model,
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-serving-reset",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitAttempt({
        callId: "call-serving-reset",
        ordinal: 2,
        reason: "retry",
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-serving-reset", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [{ model: ANTHROPIC_ROUTE.model, servingModel: ANTHROPIC_ROUTE.model }],
        },
        attempts: { total: 2, retries: 1 },
        providerFallbacks: { total: 1 },
      },
    });
  });

  it("lowers only provider fallback identity when terminal metadata is unavailable", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-provider-coverage", ANTHROPIC_ROUTE);
      emitAttempt({
        callId: "call-provider-coverage",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      emitProviderFallbackCoverage({ callId: "call-provider-coverage" });
      observeProviderTransportLogicalCallSettled("call-provider-coverage", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          completed: 1,
          entries: [{ transport: "sse", outcome: "completed" }],
        },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 2, totalKind: "exact" },
      },
    });
    expect(collector.project().snapshot?.logicalCalls.entries[0]).not.toHaveProperty(
      "servingModel",
    );
  });

  it("keeps a content-confirmed serving model when fallback totals become lower-bound", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-confirmed-serving-lower-bound", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-confirmed-serving-lower-bound",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
      emitAttempt({
        callId: "call-confirmed-serving-lower-bound",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitProviderFallbackCoverage({
        callId: "call-confirmed-serving-lower-bound",
      });
      observeProviderTransportLogicalCallSettled("call-confirmed-serving-lower-bound", "failed");
      collector.finalize("call-confirmed-serving-lower-bound");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ servingModel: "claude-opus-5", outcome: "failed" }],
        },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 1, totalKind: "lower_bound" },
        events: { total: 3, totalKind: "exact" },
      },
    });
  });

  it("keeps a content-confirmed serving model after a fallback chain returns to the request", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-confirmed-serving-cycle", ANTHROPIC_ROUTE);
      emitServerFallback({
        callId: "call-confirmed-serving-cycle",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      });
      emitServerFallback({
        callId: "call-confirmed-serving-cycle",
        fromModel: "claude-opus-5",
        toModel: "claude-fable-5",
      });
      emitAttempt({
        callId: "call-confirmed-serving-cycle",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitProviderFallbackCoverage({
        callId: "call-confirmed-serving-cycle",
      });
      observeProviderTransportLogicalCallSettled("call-confirmed-serving-cycle", "failed");
      collector.finalize("call-confirmed-serving-cycle");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ servingModel: "claude-fable-5", outcome: "failed" }],
        },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 2, totalKind: "lower_bound" },
        events: { total: 4, totalKind: "exact" },
      },
    });
  });

  it("accepts fallback coverage after unattested endpoint coverage on the same transport", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-unattested-provider-coverage", ANTHROPIC_ROUTE);
      emitTransportSemanticCoverage({
        callId: "call-unattested-provider-coverage",
        reason: "transport_endpoint_authority_partial",
      });
      emitProviderFallbackCoverage({
        callId: "call-unattested-provider-coverage",
      });
      observeProviderTransportLogicalCallSettled("call-unattested-provider-coverage", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: ["transport_endpoint_authority_partial", "transport_totals_lower_bound"],
      },
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 2, totalKind: "exact" },
      },
    });
  });

  it("rejects unattested fallback coverage before endpoint authority is established", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-unattested-provider-coverage-first", ANTHROPIC_ROUTE);
      emitProviderFallbackCoverage({
        callId: "call-unattested-provider-coverage-first",
      });
      observeProviderTransportLogicalCallSettled(
        "call-unattested-provider-coverage-first",
        "completed",
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("does not treat terminal uncertainty as unattested endpoint authority", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-terminal-only-provider-coverage", ANTHROPIC_ROUTE);
      emitTransportSemanticCoverage({
        callId: "call-terminal-only-provider-coverage",
        reason: "transport_terminal_unverified",
      });
      emitProviderFallbackCoverage({
        callId: "call-terminal-only-provider-coverage",
      });
      observeProviderTransportLogicalCallSettled(
        "call-terminal-only-provider-coverage",
        "completed",
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining([
          "transport_event_conflict",
          "transport_terminal_unverified",
        ]),
      },
      snapshot: {
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("does not carry unattested endpoint authority across transports", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-cross-transport-coverage", ANTHROPIC_ROUTE);
      emitTransportSemanticCoverage({
        callId: "call-cross-transport-coverage",
        reason: "transport_endpoint_authority_partial",
      });
      emitProviderFallbackCoverage({
        callId: "call-cross-transport-coverage",
        transport: "http",
      });
      observeProviderTransportLogicalCallSettled("call-cross-transport-coverage", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("does not carry unattested endpoint authority across calls", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-authority-source", ANTHROPIC_ROUTE);
      emitTransportSemanticCoverage({
        callId: "call-authority-source",
        reason: "transport_endpoint_authority_partial",
      });
      startCall("call-authority-target", ANTHROPIC_ROUTE);
      emitProviderFallbackCoverage({
        callId: "call-authority-target",
      });
      observeProviderTransportLogicalCallSettled("call-authority-source", "completed");
      observeProviderTransportLogicalCallSettled("call-authority-target", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_event_conflict"]),
      },
      snapshot: {
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("keeps fallback coverage lower-bound after a later retry restores serving identity", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-provider-coverage-retry", ANTHROPIC_ROUTE);
      emitAttempt({
        callId: "call-provider-coverage-retry",
        ordinal: 1,
        route: ANTHROPIC_ROUTE,
        outcome: "failed",
      });
      emitProviderFallbackCoverage({ callId: "call-provider-coverage-retry" });
      emitAttempt({
        callId: "call-provider-coverage-retry",
        ordinal: 2,
        reason: "retry",
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-provider-coverage-retry", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [{ servingModel: ANTHROPIC_ROUTE.model, outcome: "completed" }],
        },
        attempts: { total: 2, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 3, totalKind: "exact" },
      },
    });
  });

  it("accepts the planned PR6B pre-send OpenAI fallback contract fixture", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pr6b-pre");
      observeProviderTransportEvent({
        type: "connection",
        eventId: "pr6b-ws-connection",
        callId: "call-pr6b-pre",
        provider: ROUTE.provider,
        model: ROUTE.model,
        api: ROUTE.api,
        transport: "native-codex-websocket",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-pr6b-pre",
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "connection_failure",
      });
      emitAttempt({
        callId: "call-pr6b-pre",
        ordinal: 1,
        reason: "transport_fallback",
        transport: "native-codex-sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pr6b-pre", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: { attempts: { transportFallbacks: 1 }, logicalCalls: { completed: 1 } },
    });
  });

  it("accepts the planned PR6B post-send OpenAI fallback contract fixture", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-pr6b-post");
      emitAttempt({
        callId: "call-pr6b-post",
        ordinal: 1,
        transport: "native-codex-websocket",
        outcome: "failed",
      });
      emitTransportFallback({
        callId: "call-pr6b-post",
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "stream_failure",
      });
      emitAttempt({
        callId: "call-pr6b-post",
        ordinal: 2,
        reason: "transport_fallback",
        transport: "native-codex-sse",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-pr6b-post", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: { attempts: { total: 2, transportFallbacks: 1 }, fallbacks: { streamFailures: 1 } },
    });
  });

  it("accepts the planned PR6C Anthropic retry and serving-transition contract fixture", () => {
    // The audited PR6C branch does not emit this planned restack contract yet.
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      const callId = "call-pr6c";
      startCall(callId, ANTHROPIC_ROUTE);
      emitAttempt({ callId, ordinal: 1, route: ANTHROPIC_ROUTE, outcome: "failed" });
      emitServerFallback({
        callId,
        fromModel: "claude-fable-5",
        toModel: "claude-opus-4-8",
      });
      emitAttempt({
        callId,
        ordinal: 2,
        reason: "retry",
        route: ANTHROPIC_ROUTE,
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled(callId, "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        logicalCalls: {
          entries: [{ model: "claude-fable-5", servingModel: "claude-opus-4-8" }],
        },
        attempts: { total: 2, retries: 1 },
        providerFallbacks: { total: 1, server: 1 },
      },
    });
  });
});
