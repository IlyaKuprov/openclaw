import { createHash } from "node:crypto";
import { types } from "node:util";
import { AI_MODEL_TRANSPORT_ATTEMPT_REASONS } from "@openclaw/ai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { extractAuditableProviderTransportAccountingSnapshot } from "../agents/provider-transport-accounting-audit.js";
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

declare const zeroSubmissionProofBrand: unique symbol;
export type AgentExecZeroSubmissionProof = {
  readonly [zeroSubmissionProofBrand]: true;
};

type ZeroSubmissionProofData = {
  contents: AgentExecDispatchReceiptContents;
  contentsSha256: string;
  zeroSubmissionOrdinals: ReadonlySet<number>;
};

const trustedReceipts = new WeakSet<object>();
const zeroSubmissionProofs = new WeakMap<object, ZeroSubmissionProofData>();

export function trustAgentExecDispatchReceipt(receipt: AgentExecDispatchReceipt): void {
  trustedReceipts.add(receipt);
}

function parseReceiptContents(
  value: unknown,
  options: {
    allowStoredTerminalZeroDispatch?: boolean;
    zeroSubmissionOrdinals?: ReadonlySet<number>;
  } = {},
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
        calls.some(
          (call) =>
            !call.outcome ||
            !call.finalized ||
            (!counts.has(call.ordinal) &&
              !options.zeroSubmissionOrdinals?.has(call.ordinal) &&
              !(
                options.allowStoredTerminalZeroDispatch &&
                (call.outcome === "failed" || call.outcome === "aborted")
              )),
        ))) ||
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
  const contents = parseReceiptContents(rawContents, {
    allowStoredTerminalZeroDispatch: true,
  });
  if (
    !contents ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    sha256 !== digest("openclaw.agent-exec.dispatch-receipt.v2", contents)
  ) {
    return undefined;
  }
  const dispatchedCallOrdinals = new Set(
    contents.dispatches.map((dispatch) => dispatch.logicalCallOrdinal),
  );
  const producerProofWasRequired = contents.calls.some(
    (call) => !dispatchedCallOrdinals.has(call.ordinal),
  );
  const persistedIncompleteReasons = producerProofWasRequired
    ? normalizeReasons([
        ...contents.incompleteReasons,
        "dispatch_receipt_producer_proof_not_persisted",
      ])
    : contents.incompleteReasons;
  if (!sortedKnownReasons(persistedIncompleteReasons, true)) {
    return undefined;
  }
  const persistedContents = producerProofWasRequired
    ? {
        ...contents,
        complete: false,
        incompleteReasons: persistedIncompleteReasons,
      }
    : contents;
  const receipt = isolatePlainDataForPersistence({
    ...persistedContents,
    sha256: producerProofWasRequired
      ? digest("openclaw.agent-exec.dispatch-receipt.v2", persistedContents)
      : sha256,
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

function hashCallId(callId: string): string {
  return createHash("sha256").update(callId).digest("hex");
}

const MAX_PROOF_GRAPH_DEPTH = 32;
const MAX_PROOF_GRAPH_NODES = 16_384;

function deepFreezePlainData(
  value: unknown,
  state = { nodes: 0, seen: new WeakSet<object>() },
  depth = 0,
): boolean {
  if (!value || typeof value !== "object") {
    return true;
  }
  state.nodes += 1;
  if (
    state.nodes > MAX_PROOF_GRAPH_NODES ||
    depth > MAX_PROOF_GRAPH_DEPTH ||
    types.isProxy(value)
  ) {
    return false;
  }
  if (state.seen.has(value)) {
    return true;
  }
  state.seen.add(value);

  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const values: unknown[] = [];
  if (Array.isArray(value)) {
    if (
      prototype !== Array.prototype ||
      keys.length !== value.length + 1 ||
      keys.at(-1) !== "length"
    ) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (keys[index] !== key || !descriptor?.enumerable || !("value" in descriptor)) {
        return false;
      }
      values.push(descriptor.value);
    }
  } else {
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return false;
      }
      values.push(descriptor.value);
    }
  }
  for (const entry of values) {
    if (!deepFreezePlainData(entry, state, depth + 1)) {
      return false;
    }
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return Object.isFrozen(value);
}

export function createAgentExecZeroSubmissionProof(
  snapshot: unknown,
  coverage: unknown,
  contents: AgentExecDispatchReceiptContents,
): AgentExecZeroSubmissionProof | undefined {
  const normalizedContents = normalizePlainData(contents, MAX_RECEIPT_BYTES, {
    allowToJSONBlocker: false,
  });
  if (!normalizedContents) {
    return undefined;
  }
  const audit = extractAuditableProviderTransportAccountingSnapshot(snapshot, coverage);
  const transport = audit.snapshot;
  if (
    audit.truncated ||
    audit.coverage?.state !== "complete" ||
    !transport ||
    transport.attempts.totalKind !== "exact" ||
    transport.attempts.entries === undefined ||
    transport.attempts.entriesTruncated ||
    transport.dispatches?.totalKind !== "exact" ||
    transport.dispatches.entriesTruncated ||
    transport.fallbacks.totalKind !== "exact" ||
    transport.providerFallbacks.totalKind !== "exact" ||
    transport.zeroSubmissions.totalKind !== "exact" ||
    transport.events.totalKind !== "exact" ||
    transport.events.entriesTruncated
  ) {
    return undefined;
  }
  const firstCall = transport.logicalCalls.entries[0];
  if (
    !firstCall ||
    transport.logicalCalls.entries.some(
      (call) =>
        call.provider !== firstCall.provider ||
        call.model !== firstCall.model ||
        call.api !== firstCall.api,
    ) ||
    transport.dispatches.entries.some(
      (dispatch) =>
        dispatch.provider !== firstCall.provider ||
        dispatch.model !== firstCall.model ||
        dispatch.api !== firstCall.api,
    )
  ) {
    return undefined;
  }
  const zeroSubmissionOrdinals = new Set<number>();
  for (const call of transport.logicalCalls.entries) {
    if (
      (call.outcome !== "failed" && call.outcome !== "aborted") ||
      call.finalized !== true ||
      transport.attempts.entries.some((attempt) => attempt.logicalCallOrdinal === call.ordinal) ||
      transport.dispatches.entries.some((dispatch) => dispatch.logicalCallOrdinal === call.ordinal)
    ) {
      continue;
    }
    const callEvents = transport.events.entries.filter(
      (event) => "callId" in event && event.callId === call.callId,
    );
    const zeroSubmissions = callEvents.filter(
      (event) => event.type === "submission" && event.total === 0,
    );
    const zeroSubmission = zeroSubmissions[0];
    if (
      zeroSubmissions.length === 1 &&
      zeroSubmission?.type === "submission" &&
      zeroSubmission.outcome === call.outcome &&
      callEvents.every(
        (event) =>
          event.type !== "attempt" &&
          event.type !== "dispatch" &&
          event.type !== "fallback" &&
          event.type !== "provider_fallback" &&
          event.type !== "coverage",
      )
    ) {
      zeroSubmissionOrdinals.add(call.ordinal!);
    }
  }
  if (
    zeroSubmissionOrdinals.size === 0 ||
    zeroSubmissionOrdinals.size !== transport.zeroSubmissions.total
  ) {
    return undefined;
  }
  const expectedCalls = transport.logicalCalls.entries.map((call) => ({
    ordinal: call.ordinal!,
    callIdSha256: hashCallId(call.callId),
    outcome: call.outcome!,
    finalized: call.finalized!,
  }));
  const expectedDispatches = transport.dispatches.entries.map((dispatch) => ({
    sequence: dispatch.sequence,
    logicalCallOrdinal: dispatch.logicalCallOrdinal,
    perCallAttemptOrdinal: dispatch.attemptOrdinal,
    hopOrdinal: dispatch.hopOrdinal,
    reason: dispatch.reason,
    transport: dispatch.transport,
  }));
  const dispatchOrdinals = new Set(
    expectedDispatches.map((dispatch) => dispatch.logicalCallOrdinal),
  );
  const missingDispatchOrdinals = new Set(
    expectedCalls.filter((call) => !dispatchOrdinals.has(call.ordinal)).map((call) => call.ordinal),
  );
  if (
    !contents.complete ||
    contents.truncated ||
    contents.incompleteReasons.length > 0 ||
    contents.logicalCalls !== expectedCalls.length ||
    contents.modelFacingApiCalls !== expectedDispatches.length ||
    contents.calls.length !== expectedCalls.length ||
    contents.calls.some((call, index) => {
      const expected = expectedCalls[index];
      return (
        !expected ||
        call.ordinal !== expected.ordinal ||
        call.callIdSha256 !== expected.callIdSha256 ||
        call.outcome !== expected.outcome ||
        call.finalized !== expected.finalized
      );
    }) ||
    contents.dispatches.length !== expectedDispatches.length ||
    contents.dispatches.some((dispatch, index) => {
      const expected = expectedDispatches[index];
      return (
        !expected ||
        dispatch.sequence !== expected.sequence ||
        dispatch.logicalCallOrdinal !== expected.logicalCallOrdinal ||
        dispatch.perCallAttemptOrdinal !== expected.perCallAttemptOrdinal ||
        dispatch.hopOrdinal !== expected.hopOrdinal ||
        dispatch.reason !== expected.reason ||
        dispatch.transport !== expected.transport
      );
    }) ||
    missingDispatchOrdinals.size !== zeroSubmissionOrdinals.size ||
    [...missingDispatchOrdinals].some((ordinal) => !zeroSubmissionOrdinals.has(ordinal)) ||
    !contents.route ||
    contents.route.provider !== firstCall.provider ||
    contents.route.model !== firstCall.model ||
    contents.route.api !== firstCall.api
  ) {
    return undefined;
  }
  if (!deepFreezePlainData(contents)) {
    return undefined;
  }
  const proof = Object.freeze({}) as AgentExecZeroSubmissionProof;
  zeroSubmissionProofs.set(proof, {
    contents,
    contentsSha256: digest("openclaw.agent-exec.zero-submission-proof.v1", normalizedContents),
    zeroSubmissionOrdinals,
  });
  return proof;
}

function consumeZeroSubmissionProof(
  proof: AgentExecZeroSubmissionProof | undefined,
): ZeroSubmissionProofData | undefined {
  if (!proof || typeof proof !== "object") {
    return undefined;
  }
  const data = zeroSubmissionProofs.get(proof);
  zeroSubmissionProofs.delete(proof);
  return data;
}

export function sealAgentExecDispatchReceipt(
  input: AgentExecDispatchReceiptContents,
  proof?: AgentExecZeroSubmissionProof,
): AgentExecDispatchReceipt | undefined {
  const proofData = consumeZeroSubmissionProof(proof);
  const dispatchOrdinals = new Set(input.dispatches.map((dispatch) => dispatch.logicalCallOrdinal));
  const missingDispatchOrdinals = new Set(
    input.calls.filter((call) => !dispatchOrdinals.has(call.ordinal)).map((call) => call.ordinal),
  );
  let proofContentsMatch = false;
  if (proofData && input === proofData.contents) {
    try {
      const normalizedInput = normalizePlainData(input, MAX_RECEIPT_BYTES, {
        allowToJSONBlocker: false,
      });
      proofContentsMatch =
        normalizedInput !== undefined &&
        digest("openclaw.agent-exec.zero-submission-proof.v1", normalizedInput) ===
          proofData.contentsSha256;
    } catch {
      proofContentsMatch = false;
    }
  }
  if (
    ((input.complete && missingDispatchOrdinals.size > 0) || proofData) &&
    (!proofData ||
      !proofContentsMatch ||
      !input.complete ||
      input.truncated ||
      input.incompleteReasons.length > 0 ||
      missingDispatchOrdinals.size !== proofData.zeroSubmissionOrdinals.size ||
      [...missingDispatchOrdinals].some(
        (ordinal) => !proofData.zeroSubmissionOrdinals.has(ordinal),
      ))
  ) {
    return undefined;
  }
  const candidate = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: "transport_dispatch_receipt" as const,
    ...input,
    calls: input.calls.map((call) => ({
      ordinal: call.ordinal,
      callIdSha256: call.callIdSha256,
      ...(call.outcome ? { outcome: call.outcome } : {}),
      finalized: call.finalized,
    })),
    incompleteReasons: normalizeReasons(input.incompleteReasons),
  };
  const contents = parseReceiptContents(candidate, {
    zeroSubmissionOrdinals: proofData?.zeroSubmissionOrdinals,
  });
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
