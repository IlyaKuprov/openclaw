import { createHash } from "node:crypto";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import { extractAuditableProviderTransportAccountingSnapshot } from "../agents/provider-transport-accounting-audit.js";
import {
  createAgentExecZeroSubmissionProof,
  sealAgentExecDispatchReceipt,
  type AgentExecDispatchReceipt,
  type AgentExecDispatchReceiptContents,
} from "./agent-exec-dispatch-receipt-schema.internal.js";
import { MAX_CALLS, MAX_DISPATCHES, safeLabel } from "./agent-exec-trace-schema-support.js";

type Transport = NonNullable<AgentCommandRunAccountingSnapshot["providerTransport"]>;
type SourceCall = Transport["logicalCalls"]["entries"][number];
type SourceDispatch = NonNullable<Transport["dispatches"]>["entries"][number];
type SealDispatchReceipt = typeof sealAgentExecDispatchReceipt;

export type AgentExecDispatchAuthority = {
  receipt?: AgentExecDispatchReceipt;
  providerTransport?: Transport;
};

type CapturedProviderTransport = {
  valid: boolean;
  transport?: unknown;
  coverage?: unknown;
};

function readOwnDataProperty(value: unknown, key: string): { ok: boolean; value?: unknown } {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? { ok: true, value: descriptor.value }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function captureProviderTransport(snapshot: unknown): CapturedProviderTransport {
  const transport = readOwnDataProperty(snapshot, "providerTransport");
  const coverageContainer = readOwnDataProperty(snapshot, "coverage");
  const coverage = coverageContainer.ok
    ? readOwnDataProperty(coverageContainer.value, "providerTransport")
    : { ok: false };
  return {
    valid: transport.ok && coverage.ok,
    ...(transport.ok ? { transport: transport.value } : {}),
    ...(coverage.ok ? { coverage: coverage.value } : {}),
  };
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hashCallId(callId: string): string {
  return createHash("sha256").update(callId).digest("hex");
}

function projectRoute(
  calls: readonly SourceCall[],
  dispatches: readonly SourceDispatch[],
  reasons: Set<string>,
): AgentExecDispatchReceipt["route"] | undefined {
  const first = calls[0];
  const route = first
    ? { provider: first.provider, model: first.model, api: first.api }
    : undefined;
  if (
    !route ||
    !safeLabel(route.provider) ||
    !safeLabel(route.model) ||
    !safeLabel(route.api) ||
    calls.some(
      (call) =>
        call.provider !== route.provider || call.model !== route.model || call.api !== route.api,
    ) ||
    dispatches.some(
      (dispatch) =>
        dispatch.provider !== route.provider ||
        dispatch.model !== route.model ||
        dispatch.api !== route.api,
    )
  ) {
    reasons.add("dispatch_route_not_singular");
    return undefined;
  }
  return route;
}

function projectDispatches(
  calls: readonly SourceCall[],
  source: readonly SourceDispatch[],
  reasons: Set<string>,
): AgentExecDispatchReceipt["dispatches"] | undefined {
  const callsByOrdinal = new Map(calls.slice(0, MAX_CALLS).map((call) => [call.ordinal, call]));
  const projected: AgentExecDispatchReceipt["dispatches"] = [];
  for (const [index, dispatch] of source.slice(0, MAX_DISPATCHES).entries()) {
    const call = callsByOrdinal.get(dispatch.logicalCallOrdinal);
    if (!call && calls.length > MAX_CALLS && dispatch.logicalCallOrdinal > MAX_CALLS) {
      break;
    }
    if (
      dispatch.sequence !== index + 1 ||
      !call ||
      dispatch.callId !== call.callId ||
      !safeLabel(dispatch.transport)
    ) {
      reasons.add(
        dispatch.sequence !== index + 1
          ? "dispatch_global_sequence_invalid"
          : "dispatch_orphan_fact",
      );
      return undefined;
    }
    projected.push({
      sequence: dispatch.sequence,
      logicalCallOrdinal: dispatch.logicalCallOrdinal,
      perCallAttemptOrdinal: dispatch.attemptOrdinal,
      hopOrdinal: dispatch.hopOrdinal,
      reason: dispatch.reason,
      transport: dispatch.transport,
    });
  }
  return projected;
}

export function projectAgentExecDispatchAuthority(
  snapshot: AgentCommandRunAccountingSnapshot | undefined,
  sealReceipt: SealDispatchReceipt = sealAgentExecDispatchReceipt,
): AgentExecDispatchAuthority {
  if (!snapshot) {
    return {};
  }
  const captured = captureProviderTransport(snapshot);
  const reasons = new Set<string>();
  const audit = captured.valid
    ? extractAuditableProviderTransportAccountingSnapshot(captured.transport, captured.coverage)
    : { truncated: false };
  if (!captured.valid) {
    reasons.add("provider_event_conservation_mismatch");
  } else if (captured.transport === undefined) {
    reasons.add("provider_transport_not_observed");
  } else if (audit.coverage?.state !== "complete") {
    for (const reason of audit.coverage?.reasons ?? []) {
      reasons.add(reason);
    }
  }
  const canonical = audit.snapshot;
  if (captured.transport !== undefined && !canonical) {
    reasons.add("provider_event_conservation_mismatch");
  }

  const sourceCalls = canonical?.logicalCalls.entries ?? [];
  const sourceDispatches = canonical?.dispatches?.entries ?? [];
  const route = projectRoute(sourceCalls, sourceDispatches, reasons);
  const dispatchCounts = new Map<number, number>();
  for (const dispatch of sourceDispatches) {
    dispatchCounts.set(
      dispatch.logicalCallOrdinal,
      (dispatchCounts.get(dispatch.logicalCallOrdinal) ?? 0) + 1,
    );
  }
  const calls: AgentExecDispatchReceiptContents["calls"] = sourceCalls
    .slice(0, MAX_CALLS)
    .map((call) => ({
      ordinal: call.ordinal!,
      callIdSha256: hashCallId(call.callId),
      finalized: true,
      outcome: call.outcome!,
    }));
  const dispatches = projectDispatches(sourceCalls, sourceDispatches, reasons);
  const truncated = audit.truncated;
  if (truncated) {
    reasons.add("transport_details_truncated");
  }
  let incompleteReasons = [...reasons].toSorted(bytewiseCompare);
  let contents: AgentExecDispatchReceiptContents = {
    complete: incompleteReasons.length === 0,
    truncated,
    incompleteReasons,
    ...(route ? { route } : {}),
    logicalCalls: calls.length,
    modelFacingApiCalls: dispatches?.length ?? 0,
    calls,
    dispatches: dispatches ?? [],
  };
  const hasMissingDispatch = calls.some((call) => !dispatchCounts.has(call.ordinal));
  const zeroSubmissionProof =
    hasMissingDispatch && captured.valid
      ? createAgentExecZeroSubmissionProof(captured.transport, captured.coverage, contents)
      : undefined;
  if (hasMissingDispatch && !zeroSubmissionProof) {
    reasons.add("dispatch_receipt_conservation_mismatch");
    incompleteReasons = [...reasons].toSorted(bytewiseCompare);
    contents = {
      ...contents,
      complete: false,
      incompleteReasons,
    };
  }
  let receipt: AgentExecDispatchReceipt | undefined;
  try {
    receipt = sealReceipt(contents, zeroSubmissionProof);
  } catch {
    // A rejected seal is not producer evidence. Fall through to the closed
    // invalid-authority receipt so consumers cannot project partial raw facts.
  }
  receipt ??= sealAgentExecDispatchReceipt({
    complete: false,
    truncated: false,
    incompleteReasons: ["dispatch_receipt_conservation_mismatch"],
    logicalCalls: 0,
    modelFacingApiCalls: 0,
    calls: [],
    dispatches: [],
  });
  return {
    ...(receipt ? { receipt } : {}),
    ...(receipt?.complete && canonical ? { providerTransport: canonical } : {}),
  };
}

export function projectAgentExecDispatchReceipt(
  snapshot: AgentCommandRunAccountingSnapshot | undefined,
): AgentExecDispatchReceipt | undefined {
  return projectAgentExecDispatchAuthority(snapshot).receipt;
}
