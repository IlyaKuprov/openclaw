import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AiModelTransportEvent } from "@openclaw/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFrontierModeConfigProof,
  buildFrozenFrontierMatrixPlan,
  createFrozenFrontierMatrixChildIsolation,
  frozenFrontierMatrixTesting,
  runFrozenFrontierMatrix,
  verifyFrontierAuditBundle,
  type FrontierMatrixCellObservation,
  type FrozenFrontierMatrixIdentity,
  type FrozenFrontierMatrixPlan,
} from "../../scripts/lib/code-mode-frontier-matrix.js";
import { createCodeModeStats } from "../../src/agents/code-mode-stats.js";
import type { AgentCommandRunAccountingSnapshot } from "../../src/agents/command/run-accounting.types.js";
import {
  agentExecTraceTesting,
  type AgentExecDispatchReceipt,
} from "../../src/commands/agent-exec-trace.js";

const tempRoots: string[] = [];
const sourceIdentity = {
  sourceSha: "a".repeat(40),
  sourceDirty: false,
  buildSha256: "b".repeat(64),
  configSha256: "c".repeat(64),
  entrypointSha256: "d".repeat(64),
  lockfileSha256: "e".repeat(64),
  modelCapabilitySha256: "f".repeat(64),
  nodeVersion: "v24.15.0",
  oracleSha256: "1".repeat(64),
} satisfies FrozenFrontierMatrixIdentity;
const modeConfigProof = buildFrontierModeConfigProof({
  agentId: "proof",
  direct: {
    agents: { entries: { proof: { tools: { codeMode: { enabled: false } } } } },
    tools: { codeMode: { enabled: false } },
  },
  code: {
    agents: { entries: { proof: { tools: { codeMode: { enabled: true } } } } },
    tools: { codeMode: { enabled: true } },
  },
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-frontier-matrix-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function plan(): FrozenFrontierMatrixPlan {
  return buildFrozenFrontierMatrixPlan({
    api: "responses",
    blockId: "block-01",
    campaignId: "campaign-01",
    campaignNonce: "one-use-campaign-nonce",
    fixtureSha256: "2".repeat(64),
    identity: sourceIdentity,
    model: "openai/gpt-test",
    promptSha256: "3".repeat(64),
    providerMaxRetries: 2,
    runDate: "2026-08-08",
    taskSubset: ["task-01", "task-02"],
    modeConfigProof,
  });
}

function attemptEvent(callId: string): AiModelTransportEvent {
  return {
    eventId: `attempt-${callId}`,
    type: "attempt",
    provider: "openai",
    model: "gpt-test",
    api: "responses",
    callId,
    transport: "sse",
    ordinal: 1,
    reason: "initial",
    outcome: "completed",
  };
}

function snapshot(mode: "direct" | "code"): AgentCommandRunAccountingSnapshot {
  const code = mode === "code";
  const turns = code ? 8 : 10;
  const calls = code ? 9 : 10;
  const tokens = code ? 900 : 1_000;
  const callIds = Array.from({ length: calls }, (_, index) => `call-${mode}-${index + 1}`);
  const events = callIds.map(attemptEvent);
  const codeModeStats = createCodeModeStats();
  codeModeStats.bridgeCalls = code ? { search: 1, call: 2 } : {};
  codeModeStats.bridgeLifecycle = code
    ? { registered: 3, started: 3, settled: 3, unresolvedAtExtraction: 0 }
    : {};
  return {
    candidates: {
      total: 1,
      returned: 1,
      threw: 0,
      runtimes: { embedded: 1, cli: 0, native: 0, cloud: 0, unknown: 0 },
      entries: [
        {
          provider: "openai",
          model: "gpt-test",
          runtime: "embedded",
          outcome: "returned",
          effectiveModels: {
            entries: [{ provider: "openai", model: "gpt-test" }],
            truncated: 0,
          },
        },
      ],
      truncated: 0,
    },
    agentSubmissions: { total: 1, completed: 1, failed: 0 },
    modelCalls: { total: calls, completed: calls, failed: 0 },
    assistantTurns: turns,
    usage: {
      input: tokens - 200,
      cacheRead: 100,
      cacheWrite: 0,
      output: 200,
      reasoningTokens: 100,
      total: tokens,
    },
    toolSummary: { calls: code ? 1 : 5, tools: code ? ["code_mode"] : ["read"] },
    providerTransport: {
      logicalCalls: {
        total: calls,
        totalKind: "exact",
        outcomeKind: "exact",
        completed: calls,
        failed: 0,
        aborted: 0,
        entries: callIds.map((callId, index) => ({
          callId,
          provider: "openai",
          model: "gpt-test",
          api: "responses",
          transport: "sse",
          outcome: "completed",
          cachedInput: { state: "exact", tokens: index === 0 ? 50 : 0 },
        })),
        entriesTruncated: false,
      },
      attempts: {
        total: calls,
        totalKind: "exact",
        initial: calls,
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
    commandExecutionDurationMs: code ? 950 : 1_000,
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
    ...(code
      ? {
          codeMode: {
            engaged: true,
            stats: codeModeStats,
            lifecycle: {
              maxUnresolvedAtExtraction: 0,
              attemptsWithUnresolved: 0,
              finalQuiescence: { state: "quiescent" as const },
            },
          },
        }
      : {}),
  };
}

function receipt(source: AgentCommandRunAccountingSnapshot): AgentExecDispatchReceipt {
  const calls = source.providerTransport?.logicalCalls.entries ?? [];
  return {
    schemaVersion: 1,
    authority: "host_dispatch_guard",
    complete: true,
    truncated: false,
    route: { provider: "openai", model: "gpt-test", api: "responses" },
    logicalCalls: calls.length,
    physicalFetchDispatch: calls.length,
    calls: calls.map((call, index) => ({
      ordinal: index + 1,
      callIdSha256: agentExecTraceTesting.hashCallId(call.callId),
      physicalFetchDispatch: 1,
    })),
  };
}

function createObservation(
  mode: "direct" | "code",
  taskPassed = true,
): FrontierMatrixCellObservation {
  const source = snapshot(mode);
  const code = mode === "code";
  return {
    execution: {
      campaignId: "",
      blockId: "",
      cellId: "",
      cellStateKey: "",
      modeConfigSha256: "",
      declaredProviderMaxRetries: 2,
      harnessAttempt: 1,
      identitySha256: "",
      source: "simulated_harness_observation",
      openClawState: "cold_fresh",
      gatewayProcess: "cold",
      transportPrewarm: "unobserved",
      transportReuse: "unobserved",
      startedAtUtc: "2026-08-08T12:00:00.000Z",
      endedAtUtc: "2026-08-08T12:00:01.000Z",
    },
    taskPassed,
    traceInput: {
      snapshot: source,
      agentDurationMs: code ? 900 : 1_000,
      codeModeConfigured: code,
      codeModeEngaged: code,
      dispatchReceipt: receipt(source),
      model: "gpt-test",
      provider: "openai",
    },
  };
}

function runner(params: {
  matrixPlan: FrozenFrontierMatrixPlan;
  taskFailureCell?: string;
  invalidTraceCell?: string;
}) {
  return {
    runCell: async (cell: FrozenFrontierMatrixPlan["cells"][number]) => {
      const fixture = createObservation(cell.mode, cell.id !== params.taskFailureCell);
      if (cell.id === params.invalidTraceCell && fixture.traceInput.snapshot) {
        fixture.traceInput.snapshot.coverage.providerTransport = {
          state: "partial",
          reasons: ["transport_terminal_unverified"],
        };
      }
      return {
        ...fixture,
        execution: {
          ...fixture.execution,
          campaignId: params.matrixPlan.campaign.id,
          blockId: params.matrixPlan.campaign.blockId,
          cellId: cell.id,
          cellStateKey: cell.stateKey,
          modeConfigSha256:
            cell.mode === "direct"
              ? params.matrixPlan.execution.modeConfigProof.directSha256
              : params.matrixPlan.execution.modeConfigProof.codeSha256,
          identitySha256: params.matrixPlan.identitySha256,
        },
      };
    },
  };
}

describe("frozen frontier matrix plan", () => {
  it("freezes runtime, campaign, task, recovery, and serial ABBA identity", () => {
    const matrixPlan = plan();

    expect(matrixPlan).toMatchObject({
      campaign: {
        id: "campaign-01",
        blockId: "block-01",
        nonceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        evidenceAuthority: "simulated_contract_only",
      },
      runDate: "2026-08-08",
      model: { ref: "openai/gpt-test", provider: "openai", api: "responses" },
      source: sourceIdentity,
      task: {
        subset: ["task-01", "task-02"],
        subsetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        fixtureSha256: "2".repeat(64),
        promptSha256: "3".repeat(64),
        oracleSha256: sourceIdentity.oracleSha256,
      },
      execution: {
        concurrency: 1,
        schedule: "serial_abba",
        sampling: {
          seedSupport: "unsupported",
          seed: "unset",
          temperature: "provider_default",
          topP: "provider_default",
        },
        state: "fresh_process_and_state_per_cell",
        warmCold: {
          build: "warm_shared_immutable",
          gatewayProcess: "cold_per_cell",
          openClawState: "cold_fresh_per_cell",
          providerFirstCallCache: "observed_per_trace",
          transportPrewarm: "unobserved",
          transportReuse: "unobserved",
        },
        retryPolicy: {
          harness: { status: "disabled", maxRetries: 0 },
          provider: { status: "declared_unverified", declaredMaxRetries: 2 },
          encryptedPayloadRecovery: { status: "mandatory", maxRecoveries: 1 },
          transport: { status: "unknown" },
          comparability: "blocked",
          blocker: "mandatory_or_unknown_recovery_layers",
        },
      },
    });
    expect(matrixPlan.cells.map((cell) => cell.id)).toEqual([
      "direct-1",
      "code-1",
      "code-2",
      "direct-2",
    ]);
    expect(new Set(matrixPlan.cells.map((cell) => cell.stateKey)).size).toBe(4);
    expect(frozenFrontierMatrixTesting.schedule).toHaveLength(4);
  });

  it("rejects dirty identities, duplicate subsets, and ambiguous retry policy", () => {
    expect(() =>
      buildFrozenFrontierMatrixPlan({
        api: "responses",
        blockId: "block",
        campaignId: "campaign",
        campaignNonce: "one-use-campaign-nonce",
        fixtureSha256: "2".repeat(64),
        identity: {
          ...sourceIdentity,
          sourceDirty: true,
        } as unknown as FrozenFrontierMatrixIdentity,
        model: "openai/gpt-test",
        promptSha256: "3".repeat(64),
        providerMaxRetries: 2,
        runDate: "2026-08-08",
        taskSubset: ["task"],
        modeConfigProof,
      }),
    ).toThrow("clean frozen runtime identity");
    expect(() =>
      buildFrozenFrontierMatrixPlan({
        api: "responses",
        blockId: "block",
        campaignId: "campaign",
        campaignNonce: "one-use-campaign-nonce",
        fixtureSha256: "2".repeat(64),
        identity: sourceIdentity,
        model: "openai/gpt-test",
        promptSha256: "3".repeat(64),
        providerMaxRetries: 2,
        runDate: "2026-08-08",
        taskSubset: ["task", "task"],
        modeConfigProof,
      }),
    ).toThrow("non-empty, unique");
    expect(() =>
      buildFrozenFrontierMatrixPlan({
        api: "responses",
        blockId: "block",
        campaignId: "campaign",
        campaignNonce: "one-use-campaign-nonce",
        fixtureSha256: "2".repeat(64),
        identity: sourceIdentity,
        model: "openai/gpt-test",
        promptSha256: "3".repeat(64),
        providerMaxRetries: -1,
        runDate: "2026-08-08",
        taskSubset: ["task"],
        modeConfigProof,
      }),
    ).toThrow("retry policy");
  });

  it("keeps Direct and Code child configs mode-only and credentials out of artifacts", async () => {
    const credential = "frontier-matrix-secret";
    const stateDir = await tempRoot();
    const base = {
      agentId: "proof",
      authProfileId: "openai:proof",
      credential,
      model: "openai/gpt-test",
      sourceEnv: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: credential,
        HTTPS_PROXY: "http://proxy.invalid",
      },
    };
    const direct = createFrozenFrontierMatrixChildIsolation({ ...base, mode: "direct" });
    const code = createFrozenFrontierMatrixChildIsolation({ ...base, mode: "code" });
    const directConfig = await direct.prepareConfigBeforeSpawn({
      config: {},
      stateDir: path.join(stateDir, "direct"),
    });
    const codeConfig = await code.prepareConfigBeforeSpawn({
      config: {},
      stateDir: path.join(stateDir, "code"),
    });

    expect(direct.childBaseEnv).toEqual({ LANG: "en_US.UTF-8", PATH: "/usr/bin" });
    expect(directConfig.tools?.codeMode).toEqual({ enabled: false });
    expect(codeConfig.tools?.codeMode).toEqual({ enabled: true });
    expect(directConfig.agents?.entries?.proof?.tools?.codeMode).toEqual({ enabled: false });
    expect(codeConfig.agents?.entries?.proof?.tools?.codeMode).toEqual({ enabled: true });
    expect(() =>
      buildFrontierModeConfigProof({
        agentId: "proof",
        direct: directConfig,
        code: codeConfig,
      }),
    ).not.toThrow();
    expect(JSON.stringify({ direct, code })).not.toContain(credential);
  });

  it("rejects any Direct/Code config delta beyond the two enable flags", async () => {
    const stateDir = await tempRoot();
    const base = {
      agentId: "proof",
      authProfileId: "openai:proof",
      credential: "test-credential",
      model: "openai/gpt-test",
      sourceEnv: { PATH: "/usr/bin" },
    };
    const direct = await createFrozenFrontierMatrixChildIsolation({
      ...base,
      mode: "direct",
    }).prepareConfigBeforeSpawn({
      config: {},
      stateDir: path.join(stateDir, "direct"),
    });
    const code = await createFrozenFrontierMatrixChildIsolation({
      ...base,
      mode: "code",
    }).prepareConfigBeforeSpawn({
      config: {},
      stateDir: path.join(stateDir, "code"),
    });
    code.tools = { ...code.tools, toolSearch: { enabled: true } };

    expect(() => buildFrontierModeConfigProof({ agentId: "proof", direct, code })).toThrow(
      "differ only at Code Mode enable flags",
    );
  });
});

describe("frozen frontier matrix runner", () => {
  it("runs serial ABBA, writes recomputable audit bundles, and remains ineligible", async () => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    const observedCells: string[] = [];
    const cellRunner = runner({ matrixPlan });

    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => sourceIdentity,
        runCell: async (cell, currentPlan) => {
          observedCells.push(cell.id);
          return await cellRunner.runCell(cell, currentPlan);
        },
      },
    });

    expect(observedCells).toEqual(["direct-1", "code-1", "code-2", "direct-2"]);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({
      evidenceAuthority: "simulated_contract_only",
      evidenceValid: false,
      betaEligible: false,
      comparability: {
        state: "blocked",
        reasons: expect.arrayContaining([
          "dispatch_authority_not_bound",
          "mandatory_encrypted_payload_recovery",
          "transport_retry_policy_unknown",
        ]),
      },
      direct: {
        cells: 2,
        passed: 2,
        validTraces: 2,
        totals: {
          effectiveTurns: 20,
          underlyingTotalCalls: 30,
          totalTokens: 2_000,
          wallLatencyMs: 2_000,
        },
      },
      code: {
        cells: 2,
        passed: 2,
        validTraces: 2,
        totals: {
          effectiveTurns: 16,
          underlyingTotalCalls: 26,
          totalTokens: 1_800,
          wallLatencyMs: 1_900,
        },
      },
    });
    const resultLines = (
      await fs.readFile(path.join(repoRoot, "evidence", "results.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bundle = resultLines[0].auditBundle;
    const { digests, ...contents } = bundle;
    expect(digests.projectionInputSha256).toBe(
      frozenFrontierMatrixTesting.digestJson(bundle.projectionInput),
    );
    expect(digests.bundleSha256).toBe(frozenFrontierMatrixTesting.digestJson(contents));
    expect(digests.traceSha256).toBe(frozenFrontierMatrixTesting.digestJson(bundle.trace));
    expect(verifyFrontierAuditBundle(bundle)).toBe(true);
    bundle.oracle.passed = false;
    expect(verifyFrontierAuditBundle(bundle)).toBe(false);
    const manifest = await fs.readFile(path.join(repoRoot, "evidence", "manifest.json"), "utf8");
    expect(manifest).toContain(matrixPlan.identitySha256);
    expect(manifest).not.toContain("one-use-campaign-nonce");
    expect(manifest).not.toMatch(/api[_-]?key|credential|secret/iu);
  });

  it("stops on an invalid trace without retrying the cell", async () => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    const cellRunner = runner({ matrixPlan, invalidTraceCell: "code-1" });
    let calls = 0;

    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => sourceIdentity,
        runCell: async (cell, currentPlan) => {
          calls += 1;
          return await cellRunner.runCell(cell, currentPlan);
        },
      },
    });

    expect(calls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(result.results.at(-1)).toMatchObject({
      cellId: "code-1",
      failure: "trace_invalid",
      passed: false,
    });
  });

  it("keeps task failures comparable and completes the matched schedule", async () => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    const cellRunner = runner({ matrixPlan, taskFailureCell: "code-1" });
    let calls = 0;

    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => sourceIdentity,
        runCell: async (cell, currentPlan) => {
          calls += 1;
          return await cellRunner.runCell(cell, currentPlan);
        },
      },
    });

    expect(calls).toBe(4);
    expect(result.results.find((entry) => entry.cellId === "code-1")).toMatchObject({
      failure: "task_failed",
      auditBundle: { trace: { audit: { state: "valid" } } },
    });
    expect(result.summary.betaEligible).toBe(false);
  });

  it("stops and marks the current cell when frozen identity drifts after execution", async () => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    const cellRunner = runner({ matrixPlan });
    let identityReads = 0;

    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => {
          identityReads += 1;
          return identityReads === 2
            ? { ...sourceIdentity, buildSha256: "9".repeat(64) }
            : sourceIdentity;
        },
        runCell: cellRunner.runCell,
      },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      cellId: "direct-1",
      failure: "frozen_identity_mismatch",
      passed: false,
    });
  });

  it("rejects execution receipts from the wrong campaign identity", async () => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    const cellRunner = runner({ matrixPlan });

    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => sourceIdentity,
        runCell: async (cell, currentPlan) => {
          const observation = await cellRunner.runCell(cell, currentPlan);
          observation.execution.campaignId = "wrong-campaign";
          return observation;
        },
      },
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        cellId: "direct-1",
        failure: "execution_receipt_mismatch",
        passed: false,
      }),
    ]);
  });

  it.each([
    [
      "cell state",
      (observation: FrontierMatrixCellObservation) => {
        observation.execution.cellStateKey = "0".repeat(64);
      },
    ],
    [
      "gateway warm/cold state",
      (observation: FrontierMatrixCellObservation) => {
        observation.execution.gatewayProcess = "warm" as "cold";
      },
    ],
    [
      "OpenClaw warm/cold state",
      (observation: FrontierMatrixCellObservation) => {
        observation.execution.openClawState = "warm" as "cold_fresh";
      },
    ],
  ])("fails closed on %s mismatch", async (_label, mutate) => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    const cellRunner = runner({ matrixPlan });

    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => sourceIdentity,
        runCell: async (cell, currentPlan) => {
          const observation = await cellRunner.runCell(cell, currentPlan);
          mutate(observation);
          return observation;
        },
      },
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        cellId: "direct-1",
        failure: "execution_receipt_mismatch",
        passed: false,
      }),
    ]);
  });
});
