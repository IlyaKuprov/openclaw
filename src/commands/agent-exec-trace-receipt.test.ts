import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import { extractAuditableProviderTransportAccountingSnapshot } from "../agents/provider-transport-accounting-audit.js";
import { createProviderTransportAccountingCollector } from "../agents/provider-transport-accounting.js";
import {
  createAgentExecZeroSubmissionProof,
  sealAgentExecDispatchReceipt,
} from "./agent-exec-dispatch-receipt-schema.internal.js";
import {
  projectAgentExecDispatchAuthority,
  projectAgentExecDispatchReceipt,
} from "./agent-exec-trace-receipt.js";
import { canonicalJson } from "./agent-exec-trace-schema-support.js";
import {
  normalizeAgentExecDispatchReceipt,
  verifyAgentExecDispatchReceipt,
} from "./agent-exec-trace-schema.js";

const ROUTE = { provider: "openai", model: "gpt-test", api: "openai-responses" } as const;
type Receipt = NonNullable<ReturnType<typeof projectAgentExecDispatchReceipt>>;
type ZeroSubmissionMutation = {
  label: string;
  complete: boolean;
  truncated: boolean;
  incompleteReasons: string[];
  call?: Partial<Receipt["calls"][number]>;
  dispatches?: Receipt["dispatches"];
  omitOutcome?: boolean;
};

function snapshot(
  overrides: Partial<NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>> = {},
): AgentCommandRunAccountingSnapshot {
  const collector = createProviderTransportAccountingCollector();
  const firstCall = { callId: "private-call-one", ...ROUTE };
  const secondCall = { callId: "private-call-two", ...ROUTE };
  collector.observer.onLogicalCallStarted(firstCall);
  collector.observer.onLogicalCallStarted(secondCall);
  const emit = (event: Parameters<typeof collector.observer.onTransportEvent>[0]) =>
    collector.observer.onTransportEvent(event);
  emit({
    eventId: "dispatch-1",
    type: "dispatch",
    ...firstCall,
    transport: "http",
    ordinal: 1,
    attemptOrdinal: 1,
    hopOrdinal: 1,
    reason: "initial",
  });
  emit({
    eventId: "dispatch-2",
    type: "dispatch",
    ...secondCall,
    transport: "http",
    ordinal: 1,
    attemptOrdinal: 1,
    hopOrdinal: 1,
    reason: "initial",
  });
  emit({
    eventId: "dispatch-3",
    type: "dispatch",
    ...firstCall,
    transport: "http",
    ordinal: 2,
    attemptOrdinal: 1,
    hopOrdinal: 2,
    reason: "initial",
  });
  emit({
    eventId: "attempt-1-1",
    type: "attempt",
    ...firstCall,
    transport: "http",
    ordinal: 1,
    reason: "initial",
    outcome: "failed",
  });
  emit({
    eventId: "attempt-2-1",
    type: "attempt",
    ...secondCall,
    transport: "http",
    ordinal: 1,
    reason: "initial",
    outcome: "completed",
  });
  emit({
    eventId: "dispatch-4",
    type: "dispatch",
    ...firstCall,
    transport: "http",
    ordinal: 3,
    attemptOrdinal: 2,
    hopOrdinal: 1,
    reason: "retry",
  });
  emit({
    eventId: "attempt-1-2",
    type: "attempt",
    ...firstCall,
    transport: "http",
    ordinal: 2,
    reason: "retry",
    outcome: "completed",
  });
  collector.observer.onLogicalCallSettled(firstCall.callId, "completed", {
    state: "exact",
    tokens: 0,
  });
  collector.observer.onLogicalCallSettled(secondCall.callId, "completed", {
    state: "exact",
    tokens: 0,
  });
  collector.finalize(firstCall.callId);
  collector.finalize(secondCall.callId);
  collector.seal();
  const projected = collector.project();
  if (!projected.snapshot || projected.coverage.state !== "complete") {
    throw new Error("expected complete provider transport fixture");
  }
  const providerTransport = {
    ...projected.snapshot,
    ...overrides,
  };
  const complete = { state: "complete" as const };
  return {
    candidates: {
      total: 1,
      returned: 1,
      threw: 0,
      runtimes: { embedded: 1, cli: 0, native: 0, cloud: 0, unknown: 0 },
      entries: [],
      truncated: 0,
    },
    commandExecutionDurationMs: 1,
    providerTransport,
    coverage: {
      candidates: complete,
      agentSubmissions: complete,
      modelCalls: complete,
      assistantTurns: complete,
      usage: complete,
      usageBuckets: {
        input: complete,
        output: complete,
        cacheRead: complete,
        cacheWrite: complete,
        reasoningTokens: complete,
        total: complete,
      },
      tools: complete,
      cost: complete,
      agentTime: complete,
      commandExecutionDuration: complete,
      wallLatency: complete,
      providerTransport: complete,
    },
  };
}

function zeroSubmissionSnapshot(): AgentCommandRunAccountingSnapshot {
  const collector = createProviderTransportAccountingCollector();
  const call = { callId: "private-zero-submission", ...ROUTE };
  collector.observer.onLogicalCallStarted(call);
  collector.observer.onTransportEvent({
    eventId: "zero-submission",
    type: "submission",
    ...call,
    transport: "http",
    total: 0,
    outcome: "failed",
    reason: "failed_before_submission",
  });
  collector.observer.onLogicalCallSettled(call.callId, "failed", {
    state: "exact",
    tokens: 0,
  });
  collector.finalize(call.callId);
  collector.seal();
  const projected = collector.project();
  if (!projected.snapshot || projected.coverage.state !== "complete") {
    throw new Error("expected complete zero-submission transport fixture");
  }
  const source = snapshot();
  source.providerTransport = projected.snapshot;
  source.coverage.providerTransport = projected.coverage;
  return source;
}

function mixedRouteZeroSubmissionSnapshot(): AgentCommandRunAccountingSnapshot {
  const collector = createProviderTransportAccountingCollector();
  const calls = [
    { callId: "private-zero-one", ...ROUTE },
    { callId: "private-zero-two", ...ROUTE, model: "gpt-other" },
  ];
  for (const call of calls) {
    collector.observer.onLogicalCallStarted(call);
    collector.observer.onTransportEvent({
      eventId: `zero-${call.callId}`,
      type: "submission",
      ...call,
      transport: "http",
      total: 0,
      outcome: "failed",
      reason: "failed_before_submission",
    });
    collector.observer.onLogicalCallSettled(call.callId, "failed", {
      state: "exact",
      tokens: 0,
    });
    collector.finalize(call.callId);
  }
  collector.seal();
  const projected = collector.project();
  if (!projected.snapshot || projected.coverage.state !== "complete") {
    throw new Error("expected complete mixed-route transport fixture");
  }
  const source = snapshot();
  source.providerTransport = projected.snapshot;
  source.coverage.providerTransport = projected.coverage;
  return source;
}

function resealReceipt(receipt: Receipt): void {
  const { sha256: _sha256, ...contents } = receipt;
  receipt.sha256 = createHash("sha256")
    .update("openclaw.agent-exec.dispatch-receipt.v2")
    .update("\0")
    .update(canonicalJson(contents))
    .digest("hex");
}

describe("projectAgentExecDispatchReceipt", () => {
  it("preserves global dispatch order and hashes private call ids", () => {
    const receipt = projectAgentExecDispatchReceipt(snapshot());

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      complete: true,
      logicalCalls: 2,
      modelFacingApiCalls: 4,
      dispatches: [
        { sequence: 1, logicalCallOrdinal: 1, perCallAttemptOrdinal: 1 },
        { sequence: 2, logicalCallOrdinal: 2, perCallAttemptOrdinal: 1 },
        {
          sequence: 3,
          logicalCallOrdinal: 1,
          perCallAttemptOrdinal: 1,
          hopOrdinal: 2,
        },
        { sequence: 4, logicalCallOrdinal: 1, perCallAttemptOrdinal: 2 },
      ],
    });
    expect(verifyAgentExecDispatchReceipt(receipt)).toBe(true);
    expect(verifyAgentExecDispatchReceipt(JSON.stringify(receipt))).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("private-call");
    expect(receipt?.calls.every((call) => /^[a-f0-9]{64}$/u.test(call.callIdSha256))).toBe(true);
  });

  it("seals one terminal logical call with zero model-facing API calls", () => {
    const authority = projectAgentExecDispatchAuthority(zeroSubmissionSnapshot());

    expect(authority.receipt).toMatchObject({
      complete: true,
      logicalCalls: 1,
      modelFacingApiCalls: 0,
      calls: [
        {
          ordinal: 1,
          finalized: true,
          outcome: "failed",
        },
      ],
      dispatches: [],
    });
    expect(authority.providerTransport).toMatchObject({
      attempts: { total: 0, totalKind: "exact" },
      dispatches: { total: 0, totalKind: "exact" },
      fallbacks: { total: 0, totalKind: "exact" },
      zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
    });
    const persisted = normalizeAgentExecDispatchReceipt(JSON.stringify(authority.receipt));
    expect(persisted).toMatchObject({
      complete: false,
      incompleteReasons: ["dispatch_receipt_producer_proof_not_persisted"],
      logicalCalls: 1,
      modelFacingApiCalls: 0,
    });
    expect(verifyAgentExecDispatchReceipt(JSON.stringify(authority.receipt))).toBe(true);
    expect(JSON.stringify(authority.receipt)).not.toContain("zeroSubmission");
    expect(JSON.stringify(authority.receipt)).not.toContain("Proof");
  });

  it("requires a fresh replay-derived proof and rejects serialized proof fields", () => {
    const source = zeroSubmissionSnapshot();
    const receipt = projectAgentExecDispatchReceipt(source)!;
    const { schemaVersion: _schemaVersion, kind: _kind, sha256: _sha256, ...contents } = receipt;

    expect(sealAgentExecDispatchReceipt(contents)).toBeUndefined();
    const cloneContents = structuredClone(contents);
    const cloneProof = createAgentExecZeroSubmissionProof(
      source.providerTransport,
      source.coverage.providerTransport,
      cloneContents,
    );
    expect(cloneProof).toBeDefined();
    expect(
      sealAgentExecDispatchReceipt(structuredClone(cloneContents), cloneProof),
    ).toBeUndefined();

    const copyContents = structuredClone(contents);
    const copyProof = createAgentExecZeroSubmissionProof(
      source.providerTransport,
      source.coverage.providerTransport,
      copyContents,
    );
    expect(copyProof).toBeDefined();
    const copiedProof = { ...copyProof } as typeof copyProof;
    expect(sealAgentExecDispatchReceipt(copyContents, copiedProof)).toBeUndefined();
    const resealed = sealAgentExecDispatchReceipt(copyContents, copyProof);
    expect(resealed).toBeDefined();
    expect(JSON.stringify(resealed)).not.toContain("zeroSubmission");
    expect(sealAgentExecDispatchReceipt(copyContents, copyProof)).toBeUndefined();

    const forged = structuredClone(receipt) as Receipt & {
      calls: Array<Receipt["calls"][number] & { zeroSubmission?: true }>;
    };
    forged.calls[0]!.zeroSubmission = true;
    resealReceipt(forged);
    expect(verifyAgentExecDispatchReceipt(JSON.stringify(forged))).toBe(false);

    const publiclyResealed = structuredClone(receipt);
    publiclyResealed.calls[0]!.callIdSha256 = "a".repeat(64);
    resealReceipt(publiclyResealed);
    expect(normalizeAgentExecDispatchReceipt(JSON.stringify(publiclyResealed))).toMatchObject({
      complete: false,
      incompleteReasons: ["dispatch_receipt_producer_proof_not_persisted"],
    });
  });

  it("rejects a persistence downgrade that would exceed the reason bound", () => {
    const metricNames = [
      "effective_turns",
      "logical_model_calls",
      "provider_attempts",
      "provider_initial_attempts",
      "provider_retries",
      "provider_auth_recoveries",
      "provider_payload_recoveries",
      "provider_transport_fallbacks",
      "model_facing_api_calls",
      "outer_tool_calls",
      "code_mode_bridge_calls",
      "total_tool_operations",
      "underlying_total_calls",
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "total_tokens",
    ];
    const reasons = [
      ...metricNames.flatMap((name) => [`${name}_lower_bound`, `${name}_unavailable`]),
      "candidate_failed",
      "cli_runtime",
      "native_runtime",
      "cloud_runtime",
      "unknown_runtime",
      "missing_usage",
      "partial_usage",
      "partial_provider_billed_cost",
      "missing_pricing",
      "tiered_pricing_aggregate",
      "acp_runtime",
      "settled_finalization_failed",
      "session_core_compaction",
      "session_extension_compaction",
      "native_harness_compaction",
      "deferred_context_engine_maintenance",
      "post_turn_compaction",
      "exec_auto_review_model_completion",
      "agent_submission_unsettled",
      "model_call_unsettled",
      "not_instrumented",
      "not_observed",
      "attempt_extraction_only",
      "transport_totals_lower_bound",
      "transport_outcomes_lower_bound",
      "transport_unknown_route",
      "transport_uncorrelated_event",
      "transport_event_id_missing",
    ].toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    expect(reasons).toHaveLength(64);

    const receipt = structuredClone(projectAgentExecDispatchReceipt(zeroSubmissionSnapshot())!);
    receipt.complete = false;
    receipt.incompleteReasons = reasons;
    resealReceipt(receipt);

    expect(verifyAgentExecDispatchReceipt(JSON.stringify(receipt))).toBe(false);
    expect(normalizeAgentExecDispatchReceipt(JSON.stringify(receipt))).toBeUndefined();
  });

  it("rejects noncanonical issuance and post-issuance mutation", () => {
    const source = zeroSubmissionSnapshot();
    const receipt = projectAgentExecDispatchReceipt(source)!;
    const { schemaVersion: _schemaVersion, kind: _kind, sha256: _sha256, ...contents } = receipt;
    expect(
      createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        {
          ...contents,
          calls: [{ ...contents.calls[0]!, callIdSha256: "f".repeat(64) }],
        },
      ),
    ).toBeUndefined();
    expect(
      createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        {
          ...contents,
          calls: [{ ...contents.calls[0]!, outcome: "aborted" }],
        },
      ),
    ).toBeUndefined();
    expect(
      createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        {
          ...contents,
          route: { ...contents.route!, model: "drifted-model" },
        },
      ),
    ).toBeUndefined();

    const mutableContents = structuredClone(contents);
    const mutationProof = createAgentExecZeroSubmissionProof(
      source.providerTransport,
      source.coverage.providerTransport,
      mutableContents,
    );
    expect(() => {
      mutableContents.calls[0]!.outcome = "aborted";
    }).toThrow(TypeError);
    expect(sealAgentExecDispatchReceipt(mutableContents, mutationProof)).toBeDefined();
  });

  it("rejects zero-submission proof issuance for mixed canonical routes", () => {
    const source = mixedRouteZeroSubmissionSnapshot();
    const calls = source.providerTransport!.logicalCalls.entries;
    const contents = {
      complete: true,
      truncated: false,
      incompleteReasons: [],
      route: ROUTE,
      logicalCalls: calls.length,
      modelFacingApiCalls: 0,
      calls: calls.map((call) => ({
        ordinal: call.ordinal!,
        callIdSha256: createHash("sha256").update(call.callId).digest("hex"),
        outcome: call.outcome!,
        finalized: call.finalized!,
      })),
      dispatches: [],
    } satisfies Parameters<typeof sealAgentExecDispatchReceipt>[0];

    expect(
      createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        contents,
      ),
    ).toBeUndefined();
  });

  it.each<ZeroSubmissionMutation>([
    {
      label: "incomplete receipt",
      complete: false,
      truncated: false,
      incompleteReasons: ["dispatch_receipt_incomplete"],
    },
    {
      label: "truncated receipt",
      complete: false,
      truncated: true,
      incompleteReasons: ["transport_details_truncated"],
    },
    {
      label: "unsettled call",
      complete: true,
      truncated: false,
      incompleteReasons: [],
      call: { finalized: false },
      omitOutcome: true,
    },
    {
      label: "completed call",
      complete: true,
      truncated: false,
      incompleteReasons: [],
      call: { outcome: "completed", finalized: true },
    },
    {
      label: "contradictory dispatch",
      complete: true,
      truncated: false,
      incompleteReasons: [],
      dispatches: [
        {
          sequence: 1,
          logicalCallOrdinal: 1,
          perCallAttemptOrdinal: 1,
          hopOrdinal: 1,
          reason: "initial",
          transport: "http",
        },
      ],
    },
  ])(
    "rejects zero-submission proof issuance for a $label",
    ({
      complete,
      truncated,
      incompleteReasons,
      call: callPatch,
      dispatches: nextDispatches,
      omitOutcome,
    }) => {
      const source = zeroSubmissionSnapshot();
      const receipt = projectAgentExecDispatchReceipt(source)!;
      const baseCall = receipt.calls[0]!;
      const call = { ...baseCall, ...callPatch };
      if (omitOutcome) {
        delete call.outcome;
      }
      const dispatches = nextDispatches ?? receipt.dispatches;

      const contents = {
        complete,
        truncated,
        incompleteReasons,
        route: receipt.route,
        logicalCalls: 1,
        modelFacingApiCalls: dispatches.length,
        calls: [call],
        dispatches,
      };
      const proof = createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        contents,
      );
      expect(proof).toBeUndefined();
    },
  );

  it("rejects invalid stored order instead of sorting or renumbering facts", () => {
    const source = snapshot();
    const dispatches = source.providerTransport?.dispatches?.entries;
    if (!dispatches) {
      throw new Error("expected dispatch ledger");
    }
    dispatches[1] = { ...dispatches[1]!, sequence: 3 };
    dispatches[2] = { ...dispatches[2]!, sequence: 2 };

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
  });

  it("marks event conservation mismatches incomplete", () => {
    const source = snapshot();
    source.providerTransport!.events = {
      total: 0,
      totalKind: "exact",
      entries: [],
      entriesTruncated: false,
    };

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      dispatches: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecDispatchReceipt(receipt)).toBe(true);
  });

  it("closes dispatch authority when cached-input evidence is malformed", () => {
    const source = snapshot();
    source.providerTransport!.logicalCalls.entries[0]!.cachedInput = {
      state: "exact",
      tokens: -1,
    };

    const authority = projectAgentExecDispatchAuthority(source);

    expect(authority.providerTransport).toBeUndefined();
    expect(authority.receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      dispatches: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecDispatchReceipt(authority.receipt)).toBe(true);
  });

  it("rejects type-balanced event substitutions and foreign call identities", () => {
    const substituted = snapshot();
    const substitutedEvents = substituted.providerTransport!.events.entries;
    const attempt = substitutedEvents.find((event) => event.type === "attempt");
    const dispatchIndex = substitutedEvents.findIndex((event) => event.type === "dispatch");
    if (!attempt || dispatchIndex < 0) {
      throw new Error("expected dispatch and attempt events");
    }
    substitutedEvents[dispatchIndex] = {
      ...attempt,
      eventId: "substituted-attempt",
    };

    const substitutedReceipt = projectAgentExecDispatchReceipt(substituted);

    expect(substitutedReceipt?.complete).toBe(false);
    expect(substitutedReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");

    const foreign = snapshot();
    const foreignDispatch = foreign.providerTransport!.events.entries.find(
      (event) => event.type === "dispatch",
    );
    if (!foreignDispatch || foreignDispatch.type !== "dispatch") {
      throw new Error("expected dispatch event");
    }
    foreignDispatch.callId = "foreign-call";

    const foreignReceipt = projectAgentExecDispatchReceipt(foreign);

    expect(foreignReceipt?.complete).toBe(false);
    expect(foreignReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");
  });

  it("rejects duplicated events and unsettled fallback phases", () => {
    const duplicated = snapshot();
    const duplicatedEvents = duplicated.providerTransport!.events.entries;
    duplicatedEvents[1] = { ...duplicatedEvents[0]! };

    const duplicatedReceipt = projectAgentExecDispatchReceipt(duplicated);

    expect(duplicatedReceipt?.complete).toBe(false);
    expect(duplicatedReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");

    const unsettled = snapshot();
    const transport = unsettled.providerTransport!;
    transport.fallbacks = {
      total: 1,
      totalKind: "exact",
      unsupported: 1,
      connectionFailures: 0,
      submissionFailures: 0,
      streamFailures: 0,
      policy: 0,
    };
    transport.events.entries.push({
      eventId: "unsettled-fallback",
      type: "fallback",
      ...ROUTE,
      callId: "private-call-one",
      fromTransport: "http",
      toTransport: "websocket",
      reason: "unsupported",
    });
    transport.events.total += 1;

    const unsettledReceipt = projectAgentExecDispatchReceipt(unsettled);

    expect(unsettledReceipt?.complete).toBe(false);
    expect(unsettledReceipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");
  });

  it("rejects duplicate logical call identities despite balanced ledgers", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    const duplicate = transport.logicalCalls.entries[0]!.callId;
    const replaced = transport.logicalCalls.entries[1]!.callId;
    transport.logicalCalls.entries[1]!.callId = duplicate;
    for (const dispatch of transport.dispatches!.entries) {
      if (dispatch.callId === replaced) {
        dispatch.callId = duplicate;
      }
    }
    for (const event of transport.events.entries) {
      if ("callId" in event && event.callId === replaced) {
        event.callId = duplicate;
      }
    }

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt?.complete).toBe(false);
    expect(receipt?.incompleteReasons).toContain("provider_event_conservation_mismatch");
    expect(receipt?.calls).toEqual([]);
  });

  it("rejects cross-call ordinal aliasing while preserving same-call physical hops", () => {
    const source = snapshot();
    const transport = source.providerTransport!;
    const secondCallDispatch = transport.dispatches!.entries.find(
      (dispatch) => dispatch.logicalCallOrdinal === 2,
    );
    if (!secondCallDispatch) {
      throw new Error("expected second-call dispatch");
    }
    secondCallDispatch.logicalCallOrdinal = 1;

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(
      snapshot().providerTransport?.dispatches?.entries.filter(
        (dispatch) => dispatch.logicalCallOrdinal === 1 && dispatch.attemptOrdinal === 1,
      ),
    ).toHaveLength(2);
  });

  it("bounds oversized ledgers and marks the receipt truncated", () => {
    const source = snapshot();
    const transport = source.providerTransport;
    if (!transport?.dispatches) {
      throw new Error("expected provider transport");
    }
    const call = transport.logicalCalls.entries[0]!;
    transport.logicalCalls.entries = Array.from({ length: 65 }, (_, index) => ({
      ...call,
      ordinal: index + 1,
      callId: `hidden-${String(index + 1)}`,
    }));
    transport.logicalCalls.total = 65;
    transport.logicalCalls.completed = 65;
    transport.attempts.entries = transport.logicalCalls.entries.map((_entry, index) => ({
      logicalCallOrdinal: index + 1,
      ordinal: 1,
      transport: "http",
      reason: "initial",
      outcome: "completed",
    }));
    transport.attempts.total = 65;
    transport.attempts.initial = 65;
    transport.attempts.retries = 0;
    transport.dispatches.entries = [
      ...transport.logicalCalls.entries.map((entry, index) => ({
        sequence: index + 1,
        logicalCallOrdinal: index + 1,
        callId: entry.callId,
        ...ROUTE,
        transport: "http",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial" as const,
      })),
      ...Array.from({ length: 64 }, (_, index) => ({
        sequence: index + 66,
        logicalCallOrdinal: 1,
        callId: "hidden-1",
        ...ROUTE,
        transport: "http",
        ordinal: index + 2,
        attemptOrdinal: 1,
        hopOrdinal: index + 2,
        reason: "initial" as const,
      })),
    ];
    transport.dispatches.total = 129;

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      truncated: true,
      logicalCalls: 0,
    });
    expect(receipt?.dispatches).toEqual([]);
    expect(receipt?.incompleteReasons).toEqual(
      expect.arrayContaining([
        "provider_event_conservation_mismatch",
        "transport_details_truncated",
      ]),
    );
    expect(verifyAgentExecDispatchReceipt(receipt)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("hidden-");
  });

  it("returns a sealed incomplete receipt when transport accounting is unavailable", () => {
    const source = snapshot();
    source.providerTransport = undefined;
    source.coverage.providerTransport = { state: "unavailable", reasons: ["not_observed"] };

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      truncated: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      incompleteReasons: expect.arrayContaining([
        "dispatch_route_not_singular",
        "provider_transport_not_observed",
      ]),
    });
    expect(verifyAgentExecDispatchReceipt(receipt)).toBe(true);
  });

  it.each([
    {
      label: "nested accessor",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        Object.defineProperty(transport.events.entries[0]!, "provider", {
          enumerable: true,
          get() {
            throw new Error("provider accessor");
          },
        });
        return transport;
      },
    },
    {
      label: "get proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          get() {
            throw new Error("get trap");
          },
        });
      },
    },
    {
      label: "ownKeys proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          ownKeys() {
            throw new Error("ownKeys trap");
          },
        });
      },
    },
    {
      label: "descriptor proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap");
          },
        });
      },
    },
    {
      label: "prototype proxy",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        return new Proxy(transport, {
          getPrototypeOf() {
            throw new Error("prototype trap");
          },
        });
      },
    },
    {
      label: "cycle",
      mutate(transport: NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>) {
        Object.defineProperty(transport, "cycle", {
          enumerable: true,
          value: transport,
        });
        return transport;
      },
    },
  ])("seals hostile $label transport input without leaking raw facts", (testCase) => {
    const source = snapshot();
    const hostile = testCase.mutate(source.providerTransport!);
    Object.defineProperty(source, "providerTransport", {
      enumerable: true,
      value: hostile,
      writable: true,
    });

    const audit = extractAuditableProviderTransportAccountingSnapshot(
      hostile,
      source.coverage.providerTransport,
    );
    const receipt = projectAgentExecDispatchReceipt(source);

    expect(audit.snapshot).toBeUndefined();
    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      dispatches: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecDispatchReceipt(receipt)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("private-call");
  });

  it("seals a top-level provider transport accessor without invoking it", () => {
    const source = snapshot();
    const get = () => {
      throw new Error("transport accessor");
    };
    Object.defineProperty(source, "providerTransport", {
      enumerable: true,
      get,
    });

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      dispatches: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(verifyAgentExecDispatchReceipt(receipt)).toBe(true);
  });

  it.each([
    {
      label: "unknown coverage reason",
      reasons: ["unknown_transport_reason"],
    },
    {
      label: "inconsistent truncation reason",
      reasons: ["transport_details_truncated"],
    },
  ])("seals invalid $label without throwing", ({ reasons }) => {
    const source = snapshot();
    source.coverage.providerTransport = {
      state: "partial",
      reasons,
    } as never;

    const receipt = projectAgentExecDispatchReceipt(source);

    expect(receipt).toMatchObject({
      complete: false,
      truncated: false,
      logicalCalls: 0,
      modelFacingApiCalls: 0,
      calls: [],
      dispatches: [],
      incompleteReasons: expect.arrayContaining(["provider_event_conservation_mismatch"]),
    });
    expect(receipt?.incompleteReasons).not.toContain(reasons[0]);
    expect(verifyAgentExecDispatchReceipt(receipt)).toBe(true);
  });

  it.each([
    {
      label: "returns undefined",
      seal: () => undefined,
    },
    {
      label: "throws",
      seal: () => {
        throw new Error("seal failed");
      },
    },
  ])("falls back to closed invalid authority when the primary sealer $label", ({ seal }) => {
    const authority = projectAgentExecDispatchAuthority(snapshot(), seal);

    expect(authority.providerTransport).toBeUndefined();
    expect(authority.receipt).toEqual(
      expect.objectContaining({
        complete: false,
        truncated: false,
        logicalCalls: 0,
        modelFacingApiCalls: 0,
        calls: [],
        dispatches: [],
        incompleteReasons: ["dispatch_receipt_conservation_mismatch"],
      }),
    );
    expect(verifyAgentExecDispatchReceipt(authority.receipt)).toBe(true);
  });
});
