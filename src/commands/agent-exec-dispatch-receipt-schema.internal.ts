import { AI_MODEL_TRANSPORT_ATTEMPT_REASONS } from "@openclaw/ai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  digest,
  hasKeys,
  MAX_CALLS,
  MAX_DISPATCHES,
  MAX_RECEIPT_BYTES,
  isolatePlainDataForPersistence,
  normalizePlainData,
  normalizeReasons,
  parseBoundedJson,
  parseRoute,
  RECEIPT_SCHEMA_VERSION,
  safeInteger,
  safeLabel,
  SHA256_PATTERN,
  sortedKnownReasons,
  type SchemaRoute as Route,
} from "./agent-exec-trace-schema-support.js";

export type AgentExecDispatchReceipt = {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  kind: "transport_dispatch_receipt";
  complete: boolean;
  truncated: boolean;
  incompleteReasons: string[];
  route?: Route;
  logicalCalls: number;
  modelFacingApiCalls: number;
  calls: Array<{
    ordinal: number;
    callIdSha256: string;
    outcome?: "completed" | "failed" | "aborted";
    finalized: boolean;
  }>;
  dispatches: Array<{
    sequence: number;
    logicalCallOrdinal: number;
    perCallAttemptOrdinal: number;
    hopOrdinal: number;
    reason: (typeof AI_MODEL_TRANSPORT_ATTEMPT_REASONS)[number];
    transport: string;
  }>;
  sha256: string;
};

export type AgentExecDispatchReceiptContents = Omit<
  AgentExecDispatchReceipt,
  "schemaVersion" | "kind" | "sha256"
>;

const trustedReceipts = new WeakSet<object>();

export function trustAgentExecDispatchReceipt(receipt: AgentExecDispatchReceipt): void {
  trustedReceipts.add(receipt);
}

function parseReceiptContents(
  value: unknown,
): Omit<AgentExecDispatchReceipt, "sha256"> | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "schemaVersion",
      "kind",
      "complete",
      "truncated",
      "incompleteReasons",
      ...(value.route === undefined ? [] : ["route"]),
      "logicalCalls",
      "modelFacingApiCalls",
      "calls",
      "dispatches",
    ]) ||
    value.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    value.kind !== "transport_dispatch_receipt" ||
    typeof value.complete !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    !sortedKnownReasons(value.incompleteReasons, true) ||
    !safeInteger(value.logicalCalls) ||
    !safeInteger(value.modelFacingApiCalls) ||
    !Array.isArray(value.calls) ||
    value.calls.length > MAX_CALLS ||
    !Array.isArray(value.dispatches) ||
    value.dispatches.length > MAX_DISPATCHES
  ) {
    return undefined;
  }
  const route = value.route === undefined ? undefined : parseRoute(value.route, false);
  if (value.route !== undefined && !route) {
    return undefined;
  }
  const calls: AgentExecDispatchReceipt["calls"] = [];
  for (const [index, call] of value.calls.entries()) {
    if (
      !isRecord(call) ||
      !hasKeys(call, [
        "ordinal",
        "callIdSha256",
        ...(call.outcome === undefined ? [] : ["outcome"]),
        "finalized",
      ]) ||
      call.ordinal !== index + 1 ||
      typeof call.callIdSha256 !== "string" ||
      !SHA256_PATTERN.test(call.callIdSha256) ||
      typeof call.finalized !== "boolean" ||
      (call.outcome !== undefined &&
        call.outcome !== "completed" &&
        call.outcome !== "failed" &&
        call.outcome !== "aborted")
    ) {
      return undefined;
    }
    calls.push({
      ordinal: call.ordinal,
      callIdSha256: call.callIdSha256,
      ...(call.outcome ? { outcome: call.outcome } : {}),
      finalized: call.finalized,
    });
  }
  const dispatches: AgentExecDispatchReceipt["dispatches"] = [];
  const perCall = new Map<
    number,
    { attempt: number; hop: number; reason: string; transport: string }
  >();
  const counts = new Map<number, number>();
  for (const [index, dispatch] of value.dispatches.entries()) {
    if (
      !isRecord(dispatch) ||
      !hasKeys(dispatch, [
        "sequence",
        "logicalCallOrdinal",
        "perCallAttemptOrdinal",
        "hopOrdinal",
        "reason",
        "transport",
      ]) ||
      dispatch.sequence !== index + 1 ||
      !safeInteger(dispatch.logicalCallOrdinal) ||
      dispatch.logicalCallOrdinal < 1 ||
      dispatch.logicalCallOrdinal > calls.length ||
      !safeInteger(dispatch.perCallAttemptOrdinal) ||
      dispatch.perCallAttemptOrdinal < 1 ||
      !safeInteger(dispatch.hopOrdinal) ||
      dispatch.hopOrdinal < 1 ||
      !AI_MODEL_TRANSPORT_ATTEMPT_REASONS.includes(
        dispatch.reason as (typeof AI_MODEL_TRANSPORT_ATTEMPT_REASONS)[number],
      ) ||
      !safeLabel(dispatch.transport)
    ) {
      return undefined;
    }
    const prior = perCall.get(dispatch.logicalCallOrdinal);
    if (
      (!prior &&
        (dispatch.perCallAttemptOrdinal !== 1 ||
          dispatch.hopOrdinal !== 1 ||
          dispatch.reason !== "initial")) ||
      (prior &&
        !(
          (dispatch.perCallAttemptOrdinal === prior.attempt &&
            dispatch.hopOrdinal === prior.hop + 1 &&
            dispatch.reason === prior.reason &&
            dispatch.transport === prior.transport) ||
          (dispatch.perCallAttemptOrdinal === prior.attempt + 1 &&
            dispatch.hopOrdinal === 1 &&
            dispatch.reason !== "initial")
        ))
    ) {
      return undefined;
    }
    const reason = dispatch.reason as AgentExecDispatchReceipt["dispatches"][number]["reason"];
    perCall.set(dispatch.logicalCallOrdinal, {
      attempt: dispatch.perCallAttemptOrdinal,
      hop: dispatch.hopOrdinal,
      reason,
      transport: dispatch.transport,
    });
    counts.set(dispatch.logicalCallOrdinal, (counts.get(dispatch.logicalCallOrdinal) ?? 0) + 1);
    dispatches.push({
      sequence: dispatch.sequence,
      logicalCallOrdinal: dispatch.logicalCallOrdinal,
      perCallAttemptOrdinal: dispatch.perCallAttemptOrdinal,
      hopOrdinal: dispatch.hopOrdinal,
      reason,
      transport: dispatch.transport,
    });
  }
  if (
    value.logicalCalls !== calls.length ||
    value.modelFacingApiCalls !== dispatches.length ||
    value.truncated !== value.incompleteReasons.some((reason) => reason.includes("truncated")) ||
    (value.complete &&
      (value.truncated ||
        value.incompleteReasons.length > 0 ||
        !route ||
        calls.length === 0 ||
        calls.some((call) => !call.outcome || !call.finalized || !counts.has(call.ordinal)))) ||
    (!value.complete && value.incompleteReasons.length === 0)
  ) {
    return undefined;
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: "transport_dispatch_receipt",
    complete: value.complete,
    truncated: value.truncated,
    incompleteReasons: [...value.incompleteReasons],
    ...(route ? { route: route as Route } : {}),
    logicalCalls: value.logicalCalls,
    modelFacingApiCalls: value.modelFacingApiCalls,
    calls,
    dispatches,
  };
}

export function normalizeAgentExecDispatchReceiptData(
  value: unknown,
): AgentExecDispatchReceipt | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "schemaVersion",
      "kind",
      "complete",
      "truncated",
      "incompleteReasons",
      ...(value.route === undefined ? [] : ["route"]),
      "logicalCalls",
      "modelFacingApiCalls",
      "calls",
      "dispatches",
      "sha256",
    ])
  ) {
    return undefined;
  }
  const { sha256, ...rawContents } = value;
  const contents = parseReceiptContents(rawContents);
  if (
    !contents ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    sha256 !== digest("openclaw.agent-exec.dispatch-receipt.v2", contents)
  ) {
    return undefined;
  }
  const receipt = isolatePlainDataForPersistence({
    ...contents,
    sha256,
  }) as AgentExecDispatchReceipt;
  trustAgentExecDispatchReceipt(receipt);
  return receipt;
}

export function normalizeAgentExecDispatchReceipt(
  value: unknown,
): AgentExecDispatchReceipt | undefined {
  if (value !== null && typeof value === "object" && trustedReceipts.has(value)) {
    return value as AgentExecDispatchReceipt;
  }
  const parsed = parseBoundedJson(value, MAX_RECEIPT_BYTES);
  const data = parsed === undefined ? undefined : normalizePlainData(parsed, MAX_RECEIPT_BYTES);
  return data === undefined ? undefined : normalizeAgentExecDispatchReceiptData(data);
}

export function verifyAgentExecDispatchReceipt(value: unknown): boolean {
  return normalizeAgentExecDispatchReceipt(value) !== undefined;
}

export function sealAgentExecDispatchReceipt(
  input: AgentExecDispatchReceiptContents,
): AgentExecDispatchReceipt | undefined {
  const candidate = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: "transport_dispatch_receipt" as const,
    ...input,
    incompleteReasons: normalizeReasons(input.incompleteReasons),
  };
  const contents = parseReceiptContents(candidate);
  if (!contents) {
    return undefined;
  }
  const receipt = isolatePlainDataForPersistence({
    ...contents,
    sha256: digest("openclaw.agent-exec.dispatch-receipt.v2", contents),
  }) as AgentExecDispatchReceipt;
  trustAgentExecDispatchReceipt(receipt);
  return receipt;
}
