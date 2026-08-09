import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeAgentExecDispatchReceiptData,
  trustAgentExecDispatchReceipt,
  type AgentExecDispatchReceipt,
} from "./agent-exec-dispatch-receipt-schema.internal.js";
import type {
  AgentExecTraceCacheObservation,
  AgentExecTraceMetric,
} from "./agent-exec-trace-metrics.js";
import {
  canonicalJson,
  digest,
  hasKeys,
  isolatePlainDataForPersistence,
  MAX_TRACE_BYTES,
  normalizePlainData,
  normalizeReasons,
  parseBoundedJson,
  parseFacts,
  parseMetric,
  parseProviderAttempts,
  parseRoute,
  parseTokens,
  safeInteger,
  SHA256_PATTERN,
  sortedKnownReasons,
  TRACE_SCHEMA_VERSION,
  type SchemaSourceFacts as SourceFacts,
  type SchemaTraceRoute as TraceRoute,
} from "./agent-exec-trace-schema-support.js";

type MetricSet = {
  effectiveTurns: AgentExecTraceMetric;
  logicalModelCalls: AgentExecTraceMetric;
  providerAttempts: {
    total: AgentExecTraceMetric;
    initial: AgentExecTraceMetric;
    retries: AgentExecTraceMetric;
    authRecoveries: AgentExecTraceMetric;
    payloadRecoveries: AgentExecTraceMetric;
    transportFallbacks: AgentExecTraceMetric;
  };
  modelFacingApiCalls: AgentExecTraceMetric;
  outerToolCalls: AgentExecTraceMetric;
  codeModeBridgeCalls: AgentExecTraceMetric;
  totalToolOperations: AgentExecTraceMetric;
  underlyingTotalCalls: AgentExecTraceMetric;
  tokens: {
    input: AgentExecTraceMetric;
    cachedInput: AgentExecTraceMetric;
    firstLogicalCallCachedInput: AgentExecTraceCacheObservation;
    output: AgentExecTraceMetric;
    reasoning: AgentExecTraceMetric;
    total: AgentExecTraceMetric;
  };
  agentDurationMs: AgentExecTraceMetric;
  commandExecutionDurationMs: AgentExecTraceMetric;
};

export type AgentExecTraceSource = {
  kind: "agent_exec_source_facts";
  mode: { configured: false | "auto" | true | "unreported"; engaged: boolean | null };
  route?: TraceRoute;
  dispatchReceipt?: AgentExecDispatchReceipt;
  facts: SourceFacts;
  sha256: string;
};

export type AgentExecTrace = {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  source: AgentExecTraceSource;
  projection: { metrics: MetricSet };
  audit: { state: "valid" } | { state: "inconclusive"; reasons: string[] };
  sha256: string;
};

export type AgentExecTraceSourceContents = Omit<AgentExecTraceSource, "kind" | "sha256">;
export type AgentExecTraceSourceInput = AgentExecTraceSourceContents;

const trustedTraces = new WeakSet<object>();

function trustAgentExecTrace(trace: AgentExecTrace): AgentExecTrace {
  if (trace.source.dispatchReceipt) {
    trustAgentExecDispatchReceipt(trace.source.dispatchReceipt);
  }
  trustedTraces.add(trace);
  return trace;
}

function sumMetrics(
  metrics: readonly AgentExecTraceMetric[],
  incompleteReason: string,
): AgentExecTraceMetric {
  const reasons = normalizeReasons(
    metrics.flatMap((metric) => ("reasons" in metric ? (metric.reasons ?? []) : [])),
  );
  if (metrics.some((metric) => metric.state === "unavailable")) {
    return { state: "unavailable", reasons: normalizeReasons([incompleteReason, ...reasons]) };
  }
  const observed = metrics as Array<Extract<AgentExecTraceMetric, { value: number }>>;
  const value = observed.reduce((total, metric) => total + metric.value, 0);
  if (!safeInteger(value)) {
    return { state: "unavailable", reasons: [incompleteReason] };
  }
  return observed.every((metric) => metric.state === "exact")
    ? { state: "exact", value }
    : { state: "lower_bound", value, reasons: reasons.length > 0 ? reasons : [incompleteReason] };
}

function deriveMetrics(source: AgentExecTraceSource): MetricSet {
  const receipt = source.dispatchReceipt;
  const modelFacingApiCalls: AgentExecTraceMetric =
    receipt?.complete === true
      ? { state: "exact", value: receipt.modelFacingApiCalls }
      : receipt
        ? {
            state: "unavailable",
            reasons: normalizeReasons([
              "dispatch_receipt_incomplete",
              ...receipt.incompleteReasons,
            ]),
          }
        : { state: "unavailable", reasons: ["dispatch_receipt_unavailable"] };
  const totalToolOperations = sumMetrics(
    [source.facts.tools.outerToolCalls, source.facts.tools.codeModeBridgeCalls],
    "tool_operation_components_incomplete",
  );
  return {
    effectiveTurns: source.facts.accounting.effectiveTurns,
    logicalModelCalls: source.facts.accounting.logicalModelCalls,
    providerAttempts: source.facts.accounting.providerAttempts,
    modelFacingApiCalls,
    outerToolCalls: source.facts.tools.outerToolCalls,
    codeModeBridgeCalls: source.facts.tools.codeModeBridgeCalls,
    totalToolOperations,
    underlyingTotalCalls: sumMetrics(
      [modelFacingApiCalls, totalToolOperations],
      "underlying_call_components_incomplete",
    ),
    tokens: source.facts.usage,
    agentDurationMs: source.facts.duration.agentDurationMs,
    commandExecutionDurationMs: source.facts.duration.commandExecutionDurationMs,
  };
}

function parseMetrics(value: unknown): MetricSet | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "effectiveTurns",
      "logicalModelCalls",
      "providerAttempts",
      "modelFacingApiCalls",
      "outerToolCalls",
      "codeModeBridgeCalls",
      "totalToolOperations",
      "underlyingTotalCalls",
      "tokens",
      "agentDurationMs",
      "commandExecutionDurationMs",
    ])
  ) {
    return undefined;
  }
  const parsed = {
    effectiveTurns: parseMetric(value.effectiveTurns),
    logicalModelCalls: parseMetric(value.logicalModelCalls),
    providerAttempts: parseProviderAttempts(value.providerAttempts),
    modelFacingApiCalls: parseMetric(value.modelFacingApiCalls),
    outerToolCalls: parseMetric(value.outerToolCalls),
    codeModeBridgeCalls: parseMetric(value.codeModeBridgeCalls),
    totalToolOperations: parseMetric(value.totalToolOperations),
    underlyingTotalCalls: parseMetric(value.underlyingTotalCalls),
    tokens: parseTokens(value.tokens),
    agentDurationMs: parseMetric(value.agentDurationMs),
    commandExecutionDurationMs: parseMetric(value.commandExecutionDurationMs),
  };
  return Object.values(parsed).every(Boolean) ? (parsed as MetricSet) : undefined;
}

function metricAuditReasons(metrics: MetricSet): string[] {
  const entries: Array<[string, AgentExecTraceMetric]> = [
    ["effective_turns", metrics.effectiveTurns],
    ["logical_model_calls", metrics.logicalModelCalls],
    ["provider_attempts", metrics.providerAttempts.total],
    ["provider_initial_attempts", metrics.providerAttempts.initial],
    ["provider_retries", metrics.providerAttempts.retries],
    ["provider_auth_recoveries", metrics.providerAttempts.authRecoveries],
    ["provider_payload_recoveries", metrics.providerAttempts.payloadRecoveries],
    ["provider_transport_fallbacks", metrics.providerAttempts.transportFallbacks],
    ["model_facing_api_calls", metrics.modelFacingApiCalls],
    ["outer_tool_calls", metrics.outerToolCalls],
    ["code_mode_bridge_calls", metrics.codeModeBridgeCalls],
    ["total_tool_operations", metrics.totalToolOperations],
    ["underlying_total_calls", metrics.underlyingTotalCalls],
    ["input_tokens", metrics.tokens.input],
    ["cached_input_tokens", metrics.tokens.cachedInput],
    ["output_tokens", metrics.tokens.output],
    ["reasoning_tokens", metrics.tokens.reasoning],
    ["total_tokens", metrics.tokens.total],
    ["agent_duration", metrics.agentDurationMs],
    ["command_execution_duration", metrics.commandExecutionDurationMs],
  ];
  return entries.flatMap(([name, metric]) =>
    metric.state === "exact" ? [] : [`${name}_${metric.state}`],
  );
}

function deriveAudit(source: AgentExecTraceSource, metrics: MetricSet): AgentExecTrace["audit"] {
  const reasons = new Set(source.facts.auditReasons);
  if (source.mode.configured === "unreported") {
    reasons.add("code_mode_configuration_unreported");
  }
  if (source.mode.engaged === null) {
    reasons.add("code_mode_engagement_unreported");
  }
  if (
    (source.mode.configured === true && source.mode.engaged === false) ||
    (source.mode.configured === false && source.mode.engaged === true)
  ) {
    reasons.add("code_mode_configuration_mismatch");
  }
  if (!source.route) {
    reasons.add("route_unavailable");
  }
  if (!source.dispatchReceipt) {
    reasons.add("dispatch_receipt_unavailable");
  } else {
    const attempts = new Map<string, number>();
    for (const dispatch of source.dispatchReceipt.dispatches) {
      attempts.set(
        `${dispatch.logicalCallOrdinal}:${dispatch.perCallAttemptOrdinal}`,
        dispatch.perCallAttemptOrdinal,
      );
    }
    const attemptReasons = {
      initial: 0,
      retry: 0,
      auth_recovery: 0,
      payload_recovery: 0,
      transport_fallback: 0,
    };
    for (const dispatch of source.dispatchReceipt.dispatches) {
      const key = `${dispatch.logicalCallOrdinal}:${dispatch.perCallAttemptOrdinal}`;
      if (attempts.get(key) === dispatch.perCallAttemptOrdinal) {
        attemptReasons[dispatch.reason] += 1;
        attempts.delete(key);
      }
    }
    const providerAttempts = source.facts.accounting.providerAttempts;
    const expectedAttempts = [
      [
        providerAttempts.total,
        Object.values(attemptReasons).reduce((sum, value) => sum + value, 0),
      ],
      [providerAttempts.initial, attemptReasons.initial],
      [providerAttempts.retries, attemptReasons.retry],
      [providerAttempts.authRecoveries, attemptReasons.auth_recovery],
      [providerAttempts.payloadRecoveries, attemptReasons.payload_recovery],
      [providerAttempts.transportFallbacks, attemptReasons.transport_fallback],
    ] as const;
    if (
      source.dispatchReceipt.complete &&
      expectedAttempts.some(
        ([metric, observed]) => metric.state === "exact" && metric.value !== observed,
      )
    ) {
      reasons.add("provider_attempt_conservation_mismatch");
    }
    if (
      source.dispatchReceipt.complete &&
      source.facts.accounting.logicalModelCalls.state === "exact" &&
      source.facts.accounting.logicalModelCalls.value !== source.dispatchReceipt.logicalCalls
    ) {
      reasons.add("model_provider_call_count_mismatch");
    }
    if (!source.dispatchReceipt.complete) {
      reasons.add("dispatch_receipt_incomplete");
      for (const reason of source.dispatchReceipt.incompleteReasons) {
        reasons.add(reason);
      }
    }
    if (source.dispatchReceipt.truncated) {
      reasons.add("dispatch_receipt_truncated");
    }
    if (
      source.route &&
      (!source.dispatchReceipt.route ||
        source.route.provider !== source.dispatchReceipt.route.provider ||
        source.route.model !== source.dispatchReceipt.route.model ||
        source.route.api !== source.dispatchReceipt.route.api)
    ) {
      reasons.add("dispatch_receipt_route_mismatch");
    }
  }
  for (const reason of metricAuditReasons(metrics)) {
    reasons.add(reason);
  }
  if (metrics.tokens.firstLogicalCallCachedInput.state !== "exact") {
    reasons.add("first_logical_call_cached_input_unknown");
  }
  const normalized = normalizeReasons([...reasons]);
  return normalized.length === 0
    ? { state: "valid" }
    : { state: "inconclusive", reasons: normalized };
}

function downgradeFactsAfterProducerProofLoss(facts: SourceFacts): SourceFacts {
  const reasons = ["dispatch_receipt_producer_proof_not_persisted"];
  const unavailable = (): AgentExecTraceMetric => ({ state: "unavailable", reasons });
  return {
    auditReasons: normalizeReasons([...facts.auditReasons, ...reasons]),
    accounting: {
      effectiveTurns: unavailable(),
      logicalModelCalls: unavailable(),
      providerAttempts: {
        total: unavailable(),
        initial: unavailable(),
        retries: unavailable(),
        authRecoveries: unavailable(),
        payloadRecoveries: unavailable(),
        transportFallbacks: unavailable(),
      },
    },
    tools: {
      outerToolCalls: unavailable(),
      codeModeBridgeCalls: unavailable(),
    },
    usage: {
      input: unavailable(),
      cachedInput: unavailable(),
      firstLogicalCallCachedInput: { state: "unknown", reasons },
      output: unavailable(),
      reasoning: unavailable(),
      total: unavailable(),
    },
    duration: {
      agentDurationMs: unavailable(),
      commandExecutionDurationMs: unavailable(),
    },
  };
}

function parseSourceContents(value: unknown): Omit<AgentExecTraceSource, "sha256"> | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "kind",
      "mode",
      ...(value.route === undefined ? [] : ["route"]),
      ...(value.dispatchReceipt === undefined ? [] : ["dispatchReceipt"]),
      "facts",
    ]) ||
    value.kind !== "agent_exec_source_facts" ||
    !isRecord(value.mode) ||
    !hasKeys(value.mode, ["configured", "engaged"]) ||
    (value.mode.configured !== false &&
      value.mode.configured !== true &&
      value.mode.configured !== "auto" &&
      value.mode.configured !== "unreported") ||
    (typeof value.mode.engaged !== "boolean" && value.mode.engaged !== null)
  ) {
    return undefined;
  }
  const route = value.route === undefined ? undefined : parseRoute(value.route, true);
  const receipt =
    value.dispatchReceipt === undefined
      ? undefined
      : normalizeAgentExecDispatchReceiptData(value.dispatchReceipt);
  const facts = parseFacts(value.facts);
  if (
    (value.route !== undefined && !route) ||
    (value.dispatchReceipt !== undefined && !receipt) ||
    !facts
  ) {
    return undefined;
  }
  const producerProofWasLost =
    receipt?.incompleteReasons.includes("dispatch_receipt_producer_proof_not_persisted") === true;
  return {
    kind: "agent_exec_source_facts",
    mode: { configured: value.mode.configured, engaged: value.mode.engaged },
    ...(!producerProofWasLost && route ? { route: route as TraceRoute } : {}),
    ...(receipt ? { dispatchReceipt: receipt } : {}),
    facts: producerProofWasLost ? downgradeFactsAfterProducerProofLoss(facts) : facts,
  };
}

function normalizeSource(value: unknown): AgentExecTraceSource | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "kind",
      "mode",
      ...(value.route === undefined ? [] : ["route"]),
      ...(value.dispatchReceipt === undefined ? [] : ["dispatchReceipt"]),
      "facts",
      "sha256",
    ])
  ) {
    return undefined;
  }
  const { sha256, ...rawContents } = value;
  if (sha256 !== digest("openclaw.agent-exec.trace-source.v2", rawContents)) {
    return undefined;
  }
  const contents = parseSourceContents(rawContents);
  if (!contents || typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    return undefined;
  }
  return {
    ...contents,
    sha256: digest("openclaw.agent-exec.trace-source.v2", contents),
  };
}

function parseAudit(value: unknown): AgentExecTrace["audit"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.state === "valid" && hasKeys(value, ["state"])) {
    return { state: "valid" };
  }
  if (
    value.state === "inconclusive" &&
    hasKeys(value, ["state", "reasons"]) &&
    sortedKnownReasons(value.reasons, false)
  ) {
    return { state: "inconclusive", reasons: [...value.reasons] };
  }
  return undefined;
}

function normalizeAgentExecTraceData(value: unknown): AgentExecTrace | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, ["schemaVersion", "source", "projection", "audit", "sha256"]) ||
    value.schemaVersion !== TRACE_SCHEMA_VERSION ||
    !isRecord(value.projection) ||
    !hasKeys(value.projection, ["metrics"]) ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    return undefined;
  }
  const rawContents = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    source: value.source,
    projection: value.projection,
    audit: value.audit,
  };
  if (value.sha256 !== digest("openclaw.agent-exec.trace.v2", rawContents)) {
    return undefined;
  }
  const source = normalizeSource(value.source);
  const metrics = parseMetrics(value.projection.metrics);
  const audit = parseAudit(value.audit);
  if (!source || !metrics || !audit) {
    return undefined;
  }
  const derivedMetrics = deriveMetrics(source);
  const derivedAudit = deriveAudit(source, derivedMetrics);
  const sourceWasDowngraded = canonicalJson(source) !== canonicalJson(value.source);
  if (
    !sourceWasDowngraded &&
    (canonicalJson(metrics) !== canonicalJson(derivedMetrics) ||
      canonicalJson(audit) !== canonicalJson(derivedAudit))
  ) {
    return undefined;
  }
  const contents = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    source,
    projection: { metrics: sourceWasDowngraded ? derivedMetrics : metrics },
    audit: sourceWasDowngraded ? derivedAudit : audit,
  };
  return {
    ...contents,
    sha256: digest("openclaw.agent-exec.trace.v2", contents),
  };
}

export function normalizeAgentExecTrace(value: unknown): AgentExecTrace | undefined {
  if (value !== null && typeof value === "object" && trustedTraces.has(value)) {
    return value as AgentExecTrace;
  }
  const parsed = parseBoundedJson(value, MAX_TRACE_BYTES);
  const data = parsed === undefined ? undefined : normalizePlainData(parsed, MAX_TRACE_BYTES);
  const trace = data === undefined ? undefined : normalizeAgentExecTraceData(data);
  if (!trace) {
    return undefined;
  }
  const isolated = isolatePlainDataForPersistence(trace) as AgentExecTrace;
  return trustAgentExecTrace(isolated);
}

export function verifyAgentExecTrace(value: unknown): boolean {
  return normalizeAgentExecTrace(value) !== undefined;
}

function canonicalMetric(metric: AgentExecTraceMetric): AgentExecTraceMetric {
  return "reasons" in metric
    ? { ...metric, reasons: normalizeReasons(metric.reasons ?? []) }
    : { ...metric };
}

function canonicalCache(cache: AgentExecTraceCacheObservation): AgentExecTraceCacheObservation {
  return cache.state === "unknown"
    ? { state: "unknown", reasons: normalizeReasons(cache.reasons) }
    : { ...cache };
}

function canonicalSourceInput(input: AgentExecTraceSourceInput): unknown {
  return {
    kind: "agent_exec_source_facts",
    mode: { ...input.mode },
    ...(input.route ? { route: { ...input.route } } : {}),
    ...(input.dispatchReceipt ? { dispatchReceipt: input.dispatchReceipt } : {}),
    facts: {
      auditReasons: normalizeReasons(input.facts.auditReasons),
      accounting: {
        effectiveTurns: canonicalMetric(input.facts.accounting.effectiveTurns),
        logicalModelCalls: canonicalMetric(input.facts.accounting.logicalModelCalls),
        providerAttempts: Object.fromEntries(
          Object.entries(input.facts.accounting.providerAttempts).map(([key, metric]) => [
            key,
            canonicalMetric(metric),
          ]),
        ),
      },
      tools: {
        outerToolCalls: canonicalMetric(input.facts.tools.outerToolCalls),
        codeModeBridgeCalls: canonicalMetric(input.facts.tools.codeModeBridgeCalls),
      },
      usage: {
        input: canonicalMetric(input.facts.usage.input),
        cachedInput: canonicalMetric(input.facts.usage.cachedInput),
        firstLogicalCallCachedInput: canonicalCache(input.facts.usage.firstLogicalCallCachedInput),
        output: canonicalMetric(input.facts.usage.output),
        reasoning: canonicalMetric(input.facts.usage.reasoning),
        total: canonicalMetric(input.facts.usage.total),
      },
      duration: {
        agentDurationMs: canonicalMetric(input.facts.duration.agentDurationMs),
        commandExecutionDurationMs: canonicalMetric(
          input.facts.duration.commandExecutionDurationMs,
        ),
      },
    },
  };
}

export function buildAgentExecTrace(input: AgentExecTraceSourceInput): AgentExecTrace | undefined {
  const sourceContents = parseSourceContents(canonicalSourceInput(input));
  if (!sourceContents) {
    return undefined;
  }
  const source: AgentExecTraceSource = {
    ...sourceContents,
    sha256: digest("openclaw.agent-exec.trace-source.v2", sourceContents),
  };
  const metrics = deriveMetrics(source);
  const audit = deriveAudit(source, metrics);
  const contents = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    source,
    projection: { metrics },
    audit,
  };
  const trace: AgentExecTrace = {
    ...contents,
    sha256: digest("openclaw.agent-exec.trace.v2", contents),
  };
  const data = normalizePlainData(trace, MAX_TRACE_BYTES);
  const normalized = data === undefined ? undefined : normalizeAgentExecTraceData(data);
  if (!normalized) {
    return undefined;
  }
  const isolated = isolatePlainDataForPersistence(normalized) as AgentExecTrace;
  return trustAgentExecTrace(isolated);
}
