import { describe, expect, it } from "vitest";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportLogicalCallFinalized,
  observeProviderTransportLogicalCallSettled,
  runWithProviderTransportAccountingObserver,
} from "./provider-transport-accounting.js";
import {
  emitAttempt,
  emitDispatch,
  startCall,
} from "./provider-transport-accounting.test-support.js";

function projectInvalidDispatch(emit: (callId: string) => void, callId = "call-invalid-dispatch") {
  const collector = createProviderTransportAccountingCollector();
  runWithProviderTransportAccountingObserver(collector.observer, () => {
    startCall(callId);
    emit(callId);
  });
  return collector.project();
}

describe("provider transport dispatch accounting", () => {
  it("binds redirect hops and retries to their exact owning attempts", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-redirect-retry");
      emitDispatch({
        callId: "call-redirect-retry",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
      });
      emitDispatch({
        callId: "call-redirect-retry",
        ordinal: 2,
        attemptOrdinal: 1,
        hopOrdinal: 2,
      });
      emitAttempt({ callId: "call-redirect-retry", ordinal: 1, outcome: "failed" });
      emitDispatch({
        callId: "call-redirect-retry",
        ordinal: 3,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "retry",
      });
      emitAttempt({
        callId: "call-redirect-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-redirect-retry", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        attempts: { total: 2, totalKind: "exact" },
        dispatches: {
          total: 3,
          totalKind: "exact",
          entries: [
            { attemptOrdinal: 1, hopOrdinal: 1, reason: "initial" },
            { attemptOrdinal: 1, hopOrdinal: 2, reason: "initial" },
            { attemptOrdinal: 2, hopOrdinal: 1, reason: "retry" },
          ],
        },
      },
    });
  });

  it("rejects a dispatch for the wrong attempt ordinal", () => {
    const projection = projectInvalidDispatch((callId) => {
      emitDispatch({ callId, ordinal: 1, attemptOrdinal: 2, hopOrdinal: 1 });
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_dispatch_relation_invalid"]),
      },
      snapshot: { dispatches: { total: 0, totalKind: "lower_bound" } },
    });
  });

  it.each([
    { label: "gap", hops: [1, 3] },
    { label: "duplicate", hops: [1, 1] },
    { label: "reorder", hops: [2] },
  ])("rejects a dispatch hop $label", ({ hops }) => {
    const projection = projectInvalidDispatch((callId) => {
      for (const [index, hopOrdinal] of hops.entries()) {
        emitDispatch({
          callId,
          ordinal: index + 1,
          attemptOrdinal: 1,
          hopOrdinal,
          eventId: `dispatch-hop-${String(index + 1)}`,
        });
      }
    });

    expect(projection).toMatchObject({
      coverage: {
        state: hops[0] === 1 ? "partial" : "unavailable",
        reasons: expect.arrayContaining(["transport_dispatch_relation_invalid"]),
      },
      snapshot: { dispatches: { total: hops[0] === 1 ? 1 : 0, totalKind: "lower_bound" } },
    });
  });

  it("rejects a dispatch reason that cannot own the attempt", () => {
    const projection = projectInvalidDispatch((callId) => {
      emitDispatch({
        callId,
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "retry",
      });
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "unavailable",
        reasons: expect.arrayContaining(["transport_dispatch_relation_invalid"]),
      },
      snapshot: { dispatches: { total: 0, totalKind: "lower_bound" } },
    });
  });

  it("rejects an attempt reason that contradicts its dispatch group", () => {
    const projection = projectInvalidDispatch((callId) => {
      emitDispatch({ callId, ordinal: 1, attemptOrdinal: 1, hopOrdinal: 1 });
      emitAttempt({
        callId,
        ordinal: 1,
        reason: "auth_recovery",
        outcome: "completed",
      });
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_invalid"]),
      },
      snapshot: {
        attempts: { total: 0, totalKind: "lower_bound" },
        dispatches: { total: 1, totalKind: "lower_bound" },
      },
    });
  });

  it("marks an observed dispatch group incomplete when its attempt is missing", () => {
    const projection = projectInvalidDispatch((callId) => {
      emitDispatch({ callId, ordinal: 1, attemptOrdinal: 1, hopOrdinal: 1 });
      observeProviderTransportLogicalCallFinalized(callId);
    });

    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: { dispatches: { total: 1, totalKind: "lower_bound" } },
    });
  });

  it("keeps dispatch groups isolated when a call ID is reused", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      for (const outcome of ["failed", "completed"] as const) {
        startCall("call-reused");
        emitDispatch({
          callId: "call-reused",
          ordinal: 1,
          attemptOrdinal: 1,
          hopOrdinal: 1,
          eventId: `dispatch-reused-${outcome}`,
        });
        emitAttempt({
          callId: "call-reused",
          ordinal: 1,
          outcome,
          eventId: `attempt-reused-${outcome}`,
        });
        observeProviderTransportLogicalCallSettled("call-reused", outcome);
        observeProviderTransportLogicalCallFinalized("call-reused");
      }
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_lifecycle_ambiguous"]),
      },
      snapshot: {
        logicalCalls: { total: 2, totalKind: "exact", outcomeKind: "lower_bound" },
        attempts: { total: 2, totalKind: "lower_bound" },
        dispatches: {
          total: 2,
          totalKind: "lower_bound",
          entries: [
            { logicalCallOrdinal: 1, attemptOrdinal: 1, hopOrdinal: 1 },
            { logicalCallOrdinal: 2, attemptOrdinal: 1, hopOrdinal: 1 },
          ],
        },
        connections: { totalKind: "lower_bound" },
        fallbacks: { totalKind: "lower_bound" },
        providerFallbacks: { totalKind: "lower_bound" },
        zeroSubmissions: { totalKind: "lower_bound" },
        events: { total: 4, totalKind: "lower_bound" },
      },
    });
  });

  it("does not let a later exact dispatch hide an earlier missing dispatch", () => {
    const collector = createProviderTransportAccountingCollector();
    runWithProviderTransportAccountingObserver(collector.observer, () => {
      startCall("call-mixed-dispatch");
      emitAttempt({ callId: "call-mixed-dispatch", ordinal: 1, outcome: "failed" });
      emitDispatch({
        callId: "call-mixed-dispatch",
        ordinal: 1,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "retry",
      });
      emitAttempt({
        callId: "call-mixed-dispatch",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-mixed-dispatch", "completed");
    });

    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_dispatch_relation_incomplete"]),
      },
      snapshot: {
        attempts: { total: 2, totalKind: "exact" },
        dispatches: { total: 1, totalKind: "lower_bound" },
      },
    });
  });
});
