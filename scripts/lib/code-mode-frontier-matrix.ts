import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { projectAgentExecTrace, type AgentExecTrace } from "../../src/commands/agent-exec-trace.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  reserveCodeModeMatrixOutputDir,
  resolveCodeModeMatrixOutputDir,
} from "../code-mode-model-matrix.js";
import {
  buildCodeModeConversationProofChildEnv,
  CODE_MODE_CONVERSATION_PROOF_ENV_OMIT_PATTERNS,
  createCodeModeConversationProofConfigPreparation,
  hasCodeModeConversationProofProviderEnv,
} from "./code-mode-model-matrix-conversation-proof-security.js";
import { redactJsonValueForDevToolLog } from "./dev-tooling-safety.js";

const FRONTIER_MATRIX_SCHEMA_VERSION = 1 as const;
const FRONTIER_MATRIX_SCHEDULE = [
  { id: "direct-1", mode: "direct", repetition: 1 },
  { id: "code-1", mode: "code", repetition: 1 },
  { id: "code-2", mode: "code", repetition: 2 },
  { id: "direct-2", mode: "direct", repetition: 2 },
] as const;

type FrontierMatrixMode = "direct" | "code";
type Sha256 = string;

export type FrozenFrontierMatrixIdentity = {
  sourceSha: string;
  sourceDirty: false;
  buildSha256: Sha256;
  configSha256: Sha256;
  entrypointSha256: Sha256;
  lockfileSha256: Sha256;
  modelCapabilitySha256: Sha256;
  nodeVersion: string;
  oracleSha256: Sha256;
};

export type FrozenFrontierMatrixPlan = {
  schemaVersion: typeof FRONTIER_MATRIX_SCHEMA_VERSION;
  campaign: {
    id: string;
    blockId: string;
    nonceSha256: Sha256;
    evidenceAuthority: "simulated_contract_only";
  };
  runDate: string;
  model: {
    ref: string;
    provider: string;
    api: string;
  };
  source: FrozenFrontierMatrixIdentity;
  task: {
    subset: string[];
    subsetSha256: Sha256;
    fixtureSha256: Sha256;
    promptSha256: Sha256;
    oracleSha256: Sha256;
  };
  execution: {
    concurrency: 1;
    schedule: "serial_abba";
    sampling: {
      seedSupport: "unsupported";
      seed: "unset";
      temperature: "provider_default";
      topP: "provider_default";
    };
    state: "fresh_process_and_state_per_cell";
    warmCold: {
      build: "warm_shared_immutable";
      gatewayProcess: "cold_per_cell";
      openClawState: "cold_fresh_per_cell";
      providerFirstCallCache: "observed_per_trace";
      transportPrewarm: "unobserved";
      transportReuse: "unobserved";
    };
    retryPolicy: {
      harness: {
        status: "disabled";
        maxRetries: 0;
      };
      provider: {
        status: "declared_unverified";
        declaredMaxRetries: number;
      };
      encryptedPayloadRecovery: {
        status: "mandatory";
        maxRecoveries: 1;
      };
      transport: {
        status: "unknown";
      };
      comparability: "blocked";
      blocker: "mandatory_or_unknown_recovery_layers";
    };
    modeConfigProof: FrontierModeConfigProof;
  };
  cells: Array<{
    id: (typeof FRONTIER_MATRIX_SCHEDULE)[number]["id"];
    mode: FrontierMatrixMode;
    repetition: 1 | 2;
    sequence: number;
    stateKey: Sha256;
  }>;
  identitySha256: Sha256;
};

export type FrontierMatrixTraceInput = Parameters<typeof projectAgentExecTrace>[0];

export type FrontierModeConfigProof = {
  baseSha256: Sha256;
  directSha256: Sha256;
  codeSha256: Sha256;
};

export type FrontierMatrixCellExecution = {
  campaignId: string;
  blockId: string;
  cellId: string;
  cellStateKey: Sha256;
  modeConfigSha256: Sha256;
  declaredProviderMaxRetries: number;
  harnessAttempt: 1;
  identitySha256: Sha256;
  source: "simulated_harness_observation";
  openClawState: "cold_fresh";
  gatewayProcess: "cold";
  transportPrewarm: "unobserved";
  transportReuse: "unobserved";
  startedAtUtc: string;
  endedAtUtc: string;
};

export type FrontierMatrixCellObservation = {
  execution: FrontierMatrixCellExecution;
  taskPassed: boolean;
  traceInput: FrontierMatrixTraceInput;
};

type FrontierMatrixFailure =
  | "execution_receipt_mismatch"
  | "frozen_identity_mismatch"
  | "runner_failed"
  | "task_failed"
  | "trace_invalid"
  | "trace_route_mismatch";

export type FrontierMatrixAuditBundle = {
  campaign: {
    id: string;
    blockId: string;
    identitySha256: Sha256;
  };
  cell: FrozenFrontierMatrixPlan["cells"][number];
  execution: FrontierMatrixCellExecution;
  oracle: {
    passed: boolean;
    sha256: Sha256;
  };
  projectionInput: FrontierMatrixTraceInput;
  trace?: AgentExecTrace;
  verdict: {
    failure: FrontierMatrixFailure | null;
    passed: boolean;
  };
  digests: {
    projectionInputSha256: Sha256;
    dispatchReceiptSha256: Sha256 | null;
    traceSha256: Sha256 | null;
    bundleSha256: Sha256;
  };
};

export type FrozenFrontierMatrixCellResult = {
  cellId: string;
  failure: FrontierMatrixFailure | null;
  mode: FrontierMatrixMode;
  passed: boolean;
  repetition: 1 | 2;
  sequence: number;
  auditBundle?: FrontierMatrixAuditBundle;
};

type FrozenFrontierMatrixDependencies = {
  readIdentity: () => Promise<FrozenFrontierMatrixIdentity>;
  runCell: (
    cell: FrozenFrontierMatrixPlan["cells"][number],
    plan: FrozenFrontierMatrixPlan,
  ) => Promise<FrontierMatrixCellObservation>;
};

function sha256(value: string): Sha256 {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: unknown): Sha256 {
  return sha256(JSON.stringify(value));
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isSourceSha(value: string): boolean {
  return /^[a-f0-9]{40,64}$/u.test(value);
}

function isBoundedId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

function assertFrozenIdentity(identity: FrozenFrontierMatrixIdentity): void {
  const digests = [
    identity.buildSha256,
    identity.configSha256,
    identity.entrypointSha256,
    identity.lockfileSha256,
    identity.modelCapabilitySha256,
    identity.oracleSha256,
  ];
  if (
    identity.sourceDirty ||
    !isSourceSha(identity.sourceSha) ||
    digests.some((digest) => !isSha256(digest)) ||
    !/^v\d+\.\d+\.\d+/u.test(identity.nodeVersion)
  ) {
    throw new Error("frontier matrix requires a clean frozen runtime identity");
  }
}

function sameIdentity(
  left: FrozenFrontierMatrixIdentity,
  right: FrozenFrontierMatrixIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildFrozenFrontierMatrixPlan(params: {
  api: string;
  blockId: string;
  campaignId: string;
  campaignNonce: string;
  fixtureSha256: string;
  identity: FrozenFrontierMatrixIdentity;
  model: string;
  promptSha256: string;
  providerMaxRetries: number;
  runDate: string;
  taskSubset: readonly string[];
  modeConfigProof: FrontierModeConfigProof;
}): FrozenFrontierMatrixPlan {
  assertFrozenIdentity(params.identity);
  const separator = params.model.indexOf("/");
  const provider = separator > 0 ? params.model.slice(0, separator) : "";
  if (!provider || !params.model.slice(separator + 1) || !params.api.trim()) {
    throw new Error("frontier matrix requires an exact provider/model and API");
  }
  if (
    !isBoundedId(params.campaignId) ||
    !isBoundedId(params.blockId) ||
    params.campaignNonce.length < 16
  ) {
    throw new Error("frontier matrix requires bounded campaign, block, and nonce identity");
  }
  if (
    !isSha256(params.fixtureSha256) ||
    !isSha256(params.promptSha256) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(params.runDate)
  ) {
    throw new Error("frontier matrix fixture, prompt, and run date must be frozen");
  }
  if (
    !Number.isSafeInteger(params.providerMaxRetries) ||
    params.providerMaxRetries < 0 ||
    params.providerMaxRetries > 10
  ) {
    throw new Error("frontier matrix provider retry policy must be an integer from 0 to 10");
  }
  if (
    !isSha256(params.modeConfigProof.baseSha256) ||
    !isSha256(params.modeConfigProof.directSha256) ||
    !isSha256(params.modeConfigProof.codeSha256) ||
    params.modeConfigProof.directSha256 === params.modeConfigProof.codeSha256
  ) {
    throw new Error("frontier matrix requires a bound Direct/Code config proof");
  }
  const subset = [
    ...new Set(params.taskSubset.map((value) => value.trim()).filter(Boolean)),
  ].toSorted();
  if (subset.length === 0 || subset.length !== params.taskSubset.length) {
    throw new Error("frontier matrix task subset must be non-empty, unique, and explicit");
  }
  const subsetSha256 = digestJson(subset);
  const identityBasis = {
    schemaVersion: FRONTIER_MATRIX_SCHEMA_VERSION,
    campaign: {
      id: params.campaignId,
      blockId: params.blockId,
      nonceSha256: sha256(params.campaignNonce),
      evidenceAuthority: "simulated_contract_only" as const,
    },
    runDate: params.runDate,
    model: { ref: params.model, provider, api: params.api },
    source: params.identity,
    task: {
      subset,
      subsetSha256,
      fixtureSha256: params.fixtureSha256,
      promptSha256: params.promptSha256,
      oracleSha256: params.identity.oracleSha256,
    },
    execution: {
      concurrency: 1 as const,
      schedule: "serial_abba" as const,
      sampling: {
        seedSupport: "unsupported" as const,
        seed: "unset" as const,
        temperature: "provider_default" as const,
        topP: "provider_default" as const,
      },
      state: "fresh_process_and_state_per_cell" as const,
      warmCold: {
        build: "warm_shared_immutable" as const,
        gatewayProcess: "cold_per_cell" as const,
        openClawState: "cold_fresh_per_cell" as const,
        providerFirstCallCache: "observed_per_trace" as const,
        transportPrewarm: "unobserved" as const,
        transportReuse: "unobserved" as const,
      },
      retryPolicy: {
        harness: { status: "disabled" as const, maxRetries: 0 as const },
        provider: {
          status: "declared_unverified" as const,
          declaredMaxRetries: params.providerMaxRetries,
        },
        encryptedPayloadRecovery: {
          status: "mandatory" as const,
          maxRecoveries: 1 as const,
        },
        transport: { status: "unknown" as const },
        comparability: "blocked" as const,
        blocker: "mandatory_or_unknown_recovery_layers" as const,
      },
      modeConfigProof: params.modeConfigProof,
    },
  };
  const identitySha256 = digestJson(identityBasis);
  return {
    ...identityBasis,
    cells: FRONTIER_MATRIX_SCHEDULE.map((cell, index) => ({
      ...cell,
      sequence: index + 1,
      stateKey: sha256(`${identitySha256}\0${params.campaignId}\0${params.blockId}\0${cell.id}`),
    })),
    identitySha256,
  };
}

function withCodeMode(
  config: OpenClawConfig,
  agentId: string,
  mode: FrontierMatrixMode,
): OpenClawConfig {
  const enabled = mode === "code";
  const entry = config.agents?.entries?.[agentId];
  return {
    ...config,
    agents: {
      ...config.agents,
      entries: {
        ...config.agents?.entries,
        [agentId]: {
          ...entry,
          tools: {
            ...entry?.tools,
            codeMode: { enabled },
          },
        },
      },
    },
    tools: {
      ...config.tools,
      codeMode: { enabled },
    },
  };
}

function configWithoutMode(
  config: OpenClawConfig,
  agentId: string,
): {
  config: OpenClawConfig;
  globalEnabled: unknown;
  agentEnabled: unknown;
} {
  const copy = structuredClone(config);
  const globalCodeMode = copy.tools?.codeMode;
  const agentCodeMode = copy.agents?.entries?.[agentId]?.tools?.codeMode;
  const globalEnabled =
    typeof globalCodeMode === "object" && globalCodeMode !== null
      ? globalCodeMode.enabled
      : undefined;
  const agentEnabled =
    typeof agentCodeMode === "object" && agentCodeMode !== null ? agentCodeMode.enabled : undefined;
  if (typeof globalCodeMode === "object" && globalCodeMode !== null) {
    delete globalCodeMode.enabled;
  }
  if (typeof agentCodeMode === "object" && agentCodeMode !== null) {
    delete agentCodeMode.enabled;
  }
  return { config: copy, globalEnabled, agentEnabled };
}

export function buildFrontierModeConfigProof(params: {
  agentId: string;
  direct: OpenClawConfig;
  code: OpenClawConfig;
}): FrontierModeConfigProof {
  const direct = configWithoutMode(params.direct, params.agentId);
  const code = configWithoutMode(params.code, params.agentId);
  if (
    direct.globalEnabled !== false ||
    direct.agentEnabled !== false ||
    code.globalEnabled !== true ||
    code.agentEnabled !== true ||
    digestJson(direct.config) !== digestJson(code.config)
  ) {
    throw new Error(
      "frontier matrix Direct and Code configs must differ only at Code Mode enable flags",
    );
  }
  return {
    baseSha256: digestJson(direct.config),
    directSha256: digestJson(params.direct),
    codeSha256: digestJson(params.code),
  };
}

export function createFrozenFrontierMatrixChildIsolation(params: {
  agentId: string;
  authProfileId: string;
  credential: string;
  mode: FrontierMatrixMode;
  model: string;
  sourceEnv?: NodeJS.ProcessEnv;
}) {
  const childBaseEnv = buildCodeModeConversationProofChildEnv(params.sourceEnv ?? process.env);
  if (hasCodeModeConversationProofProviderEnv(childBaseEnv)) {
    throw new Error("frontier matrix child environment contains provider routing inputs");
  }
  const prepareBaseConfig = createCodeModeConversationProofConfigPreparation(params);
  return {
    childBaseEnv,
    prepareConfigBeforeSpawn: async (
      context: Parameters<typeof prepareBaseConfig>[0],
    ): Promise<OpenClawConfig> =>
      withCodeMode(await prepareBaseConfig(context), params.agentId, params.mode),
    runtimeEnvOmitPatterns: [...CODE_MODE_CONVERSATION_PROOF_ENV_OMIT_PATTERNS],
  };
}

function exactValue(metric: AgentExecTrace["metrics"]["effectiveTurns"]): number {
  if (metric.state !== "exact") {
    throw new Error("frontier matrix accepted a non-exact trace metric");
  }
  return metric.value;
}

function traceMetrics(trace: AgentExecTrace) {
  return {
    effectiveTurns: exactValue(trace.metrics.effectiveTurns),
    logicalModelCalls: exactValue(trace.metrics.logicalModelCalls),
    modelFacingApiCalls: exactValue(trace.metrics.physicalFetchDispatch),
    retries: exactValue(trace.metrics.providerAttempts.retries),
    authRecoveries: exactValue(trace.metrics.providerAttempts.authRecoveries),
    payloadRecoveries: exactValue(trace.metrics.providerAttempts.payloadRecoveries),
    transportFallbacks: exactValue(trace.metrics.providerAttempts.transportFallbacks),
    toolCalls: exactValue(trace.metrics.totalToolOperations),
    underlyingTotalCalls: exactValue(trace.metrics.underlyingTotalCalls),
    inputTokens: exactValue(trace.metrics.tokens.input),
    outputTokens: exactValue(trace.metrics.tokens.output),
    totalTokens: exactValue(trace.metrics.tokens.total),
    agentTimeMs: exactValue(trace.metrics.agentDurationMs),
    wallLatencyMs: exactValue(trace.metrics.commandExecutionDurationMs),
  };
}

function summarize(
  plan: FrozenFrontierMatrixPlan,
  results: readonly FrozenFrontierMatrixCellResult[],
) {
  const summarizeMode = (mode: FrontierMatrixMode) => {
    const selected = results.filter((result) => result.mode === mode);
    const valid = selected.filter((result) => result.auditBundle?.trace?.audit.state === "valid");
    const totals = valid.reduce(
      (sum, result) => {
        const metrics = traceMetrics(result.auditBundle!.trace!);
        for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) {
          sum[key] += metrics[key];
        }
        return sum;
      },
      {
        effectiveTurns: 0,
        logicalModelCalls: 0,
        modelFacingApiCalls: 0,
        retries: 0,
        authRecoveries: 0,
        payloadRecoveries: 0,
        transportFallbacks: 0,
        toolCalls: 0,
        underlyingTotalCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        agentTimeMs: 0,
        wallLatencyMs: 0,
      },
    );
    return {
      cells: selected.length,
      passed: selected.filter((result) => result.passed).length,
      validTraces: valid.length,
      totals,
    };
  };
  const direct = summarizeMode("direct");
  const code = summarizeMode("code");
  const observedTimes = results
    .flatMap((result) => {
      const execution = result.auditBundle?.execution;
      return execution ? [execution.startedAtUtc, execution.endedAtUtc] : [];
    })
    .toSorted((left, right) => Date.parse(left) - Date.parse(right));
  return {
    evidenceAuthority: plan.campaign.evidenceAuthority,
    evidenceValid: false,
    betaEligible: false,
    comparability: {
      state: "blocked" as const,
      reasons: [
        "dispatch_authority_not_bound",
        "provider_retry_configuration_unverified",
        "mandatory_encrypted_payload_recovery",
        "transport_retry_policy_unknown",
        "transport_warm_cold_state_unobserved",
      ],
    },
    observedWindow:
      observedTimes.length > 0
        ? { startedAtUtc: observedTimes[0], endedAtUtc: observedTimes.at(-1) }
        : null,
    direct,
    code,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeArtifacts(params: {
  outputDir: string;
  plan: FrozenFrontierMatrixPlan;
  results: readonly FrozenFrontierMatrixCellResult[];
}) {
  if (
    params.results.some(
      (result) =>
        result.auditBundle !== undefined &&
        (!verifyFrontierAuditBundle(result.auditBundle) ||
          result.auditBundle.verdict.failure !== result.failure ||
          result.auditBundle.verdict.passed !== result.passed),
    )
  ) {
    throw new Error("frontier matrix audit bundle digest mismatch");
  }
  const summary = summarize(params.plan, params.results);
  await writeJson(path.join(params.outputDir, "manifest.json"), params.plan);
  await fs.writeFile(
    path.join(params.outputDir, "results.jsonl"),
    params.results.map((result) => JSON.stringify(result)).join("\n") +
      (params.results.length > 0 ? "\n" : ""),
    "utf8",
  );
  await writeJson(path.join(params.outputDir, "summary.json"), summary);
  return summary;
}

function utcEpoch(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return undefined;
  }
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : undefined;
}

function observationMatchesCell(
  observation: FrontierMatrixCellObservation,
  cell: FrozenFrontierMatrixPlan["cells"][number],
  plan: FrozenFrontierMatrixPlan,
): boolean {
  const execution = observation.execution;
  const startedAt = utcEpoch(execution.startedAtUtc);
  const endedAt = utcEpoch(execution.endedAtUtc);
  const expectedConfigSha256 =
    cell.mode === "direct"
      ? plan.execution.modeConfigProof.directSha256
      : plan.execution.modeConfigProof.codeSha256;
  return (
    execution.campaignId === plan.campaign.id &&
    execution.blockId === plan.campaign.blockId &&
    execution.cellId === cell.id &&
    execution.cellStateKey === cell.stateKey &&
    execution.modeConfigSha256 === expectedConfigSha256 &&
    execution.declaredProviderMaxRetries ===
      plan.execution.retryPolicy.provider.declaredMaxRetries &&
    execution.harnessAttempt === 1 &&
    execution.identitySha256 === plan.identitySha256 &&
    execution.source === "simulated_harness_observation" &&
    execution.openClawState === "cold_fresh" &&
    execution.gatewayProcess === "cold" &&
    execution.transportPrewarm === "unobserved" &&
    execution.transportReuse === "unobserved" &&
    startedAt !== undefined &&
    endedAt !== undefined &&
    startedAt <= endedAt
  );
}

function modeMatchesTrace(mode: FrontierMatrixMode, input: FrontierMatrixTraceInput): boolean {
  return mode === "direct"
    ? input.codeModeConfigured === false && input.codeModeEngaged === false
    : input.codeModeConfigured === true && input.codeModeEngaged === true;
}

function redactProjectionInput(input: FrontierMatrixTraceInput): FrontierMatrixTraceInput {
  return redactJsonValueForDevToolLog(structuredClone(input)) as FrontierMatrixTraceInput;
}

function buildAuditBundle(params: {
  cell: FrozenFrontierMatrixPlan["cells"][number];
  failure: FrontierMatrixFailure | null;
  observation: FrontierMatrixCellObservation;
  plan: FrozenFrontierMatrixPlan;
  projectionInput: FrontierMatrixTraceInput;
  trace?: AgentExecTrace;
}): FrontierMatrixAuditBundle {
  const contents = {
    campaign: {
      id: params.plan.campaign.id,
      blockId: params.plan.campaign.blockId,
      identitySha256: params.plan.identitySha256,
    },
    cell: params.cell,
    execution: params.observation.execution,
    oracle: {
      passed: params.observation.taskPassed,
      sha256: params.plan.task.oracleSha256,
    },
    projectionInput: params.projectionInput,
    ...(params.trace ? { trace: params.trace } : {}),
    verdict: {
      failure: params.failure,
      passed: params.failure === null,
    },
  };
  return {
    ...contents,
    digests: {
      projectionInputSha256: digestJson(params.projectionInput),
      dispatchReceiptSha256: params.projectionInput.dispatchReceipt
        ? digestJson(params.projectionInput.dispatchReceipt)
        : null,
      traceSha256: params.trace ? digestJson(params.trace) : null,
      bundleSha256: digestJson(contents),
    },
  };
}

export function verifyFrontierAuditBundle(bundle: FrontierMatrixAuditBundle): boolean {
  const { digests, ...contents } = bundle;
  const projectedTrace = projectAgentExecTrace(bundle.projectionInput);
  const projectedTraceSha256 = projectedTrace ? digestJson(projectedTrace) : null;
  return (
    digests.projectionInputSha256 === digestJson(bundle.projectionInput) &&
    digests.dispatchReceiptSha256 ===
      (bundle.projectionInput.dispatchReceipt
        ? digestJson(bundle.projectionInput.dispatchReceipt)
        : null) &&
    digests.traceSha256 === (bundle.trace ? digestJson(bundle.trace) : null) &&
    projectedTraceSha256 === digests.traceSha256 &&
    digests.bundleSha256 === digestJson(contents)
  );
}

export async function runFrozenFrontierMatrix(params: {
  deps: FrozenFrontierMatrixDependencies;
  outputDir: string;
  plan: FrozenFrontierMatrixPlan;
  repoRoot: string;
}) {
  const resolvedOutput = resolveCodeModeMatrixOutputDir(
    params.repoRoot,
    params.outputDir,
    new Date(`${params.plan.runDate}T00:00:00.000Z`),
  );
  await reserveCodeModeMatrixOutputDir(params.repoRoot, resolvedOutput);
  const results: FrozenFrontierMatrixCellResult[] = [];
  for (const cell of params.plan.cells) {
    if (!sameIdentity(await params.deps.readIdentity(), params.plan.source)) {
      results.push({
        cellId: cell.id,
        failure: "frozen_identity_mismatch",
        mode: cell.mode,
        passed: false,
        repetition: cell.repetition,
        sequence: cell.sequence,
      });
      break;
    }
    let observation: FrontierMatrixCellObservation;
    try {
      observation = await params.deps.runCell(cell, params.plan);
    } catch {
      results.push({
        cellId: cell.id,
        failure: "runner_failed",
        mode: cell.mode,
        passed: false,
        repetition: cell.repetition,
        sequence: cell.sequence,
      });
      break;
    }
    let failure: FrontierMatrixFailure | null = null;
    const projectionInput = redactProjectionInput(observation.traceInput);
    const trace = projectAgentExecTrace(projectionInput);
    if (!observationMatchesCell(observation, cell, params.plan)) {
      failure = "execution_receipt_mismatch";
    } else if (!modeMatchesTrace(cell.mode, observation.traceInput)) {
      failure = "trace_invalid";
    } else {
      if (!trace || trace.audit.state !== "valid") {
        failure = "trace_invalid";
      } else if (
        trace.route?.provider !== params.plan.model.provider ||
        trace.route.model !== params.plan.model.ref.slice(params.plan.model.provider.length + 1) ||
        trace.route.api !== params.plan.model.api
      ) {
        failure = "trace_route_mismatch";
      } else if (!observation.taskPassed) {
        failure = "task_failed";
      }
    }
    results.push({
      cellId: cell.id,
      failure,
      mode: cell.mode,
      passed: failure === null,
      repetition: cell.repetition,
      sequence: cell.sequence,
      auditBundle: buildAuditBundle({
        cell,
        failure,
        observation,
        plan: params.plan,
        projectionInput,
        trace,
      }),
    });
    if (failure !== null && failure !== "task_failed") {
      break;
    }
    if (!sameIdentity(await params.deps.readIdentity(), params.plan.source)) {
      const last = results.at(-1);
      if (last) {
        last.failure = "frozen_identity_mismatch";
        last.passed = false;
        if (last.auditBundle) {
          last.auditBundle.verdict = {
            failure: "frozen_identity_mismatch",
            passed: false,
          };
          const { digests, ...contents } = last.auditBundle;
          digests.bundleSha256 = digestJson(contents);
        }
      }
      break;
    }
  }
  const summary = await writeArtifacts({
    outputDir: resolvedOutput,
    plan: params.plan,
    results,
  });
  return {
    exitCode: 1,
    outputDir: resolvedOutput,
    results,
    summary,
  };
}

export const frozenFrontierMatrixTesting = {
  digestJson,
  schedule: FRONTIER_MATRIX_SCHEDULE,
  sha256,
};
