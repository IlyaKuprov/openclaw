import { describe, expect, it } from "vitest";
import type { AgentCommandRunAccountingSnapshot } from "../agents/command/run-accounting.types.js";
import { createProviderTransportAccountingCollector } from "../agents/provider-transport-accounting.js";
import {
  createAgentExecZeroSubmissionProof,
  sealAgentExecDispatchReceipt,
  type AgentExecDispatchReceiptContents,
} from "./agent-exec-dispatch-receipt-schema.internal.js";
import { projectAgentExecDispatchReceipt } from "./agent-exec-trace-receipt.js";

const ROUTE = { provider: "openai", model: "gpt-test", api: "openai-responses" } as const;

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
    providerTransport: projected.snapshot,
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
      providerTransport: projected.coverage,
    },
  };
}

function createFixture() {
  const source = zeroSubmissionSnapshot();
  const receipt = projectAgentExecDispatchReceipt(source);
  if (!receipt) {
    throw new Error("expected zero-submission receipt");
  }
  const { schemaVersion: _schemaVersion, kind: _kind, sha256: _sha256, ...baseContents } = receipt;
  return { source, baseContents };
}

describe("zero-submission receipt proof integrity", () => {
  it.each([
    {
      label: "hidden property",
      mutate: (contents: AgentExecDispatchReceiptContents) => {
        Object.defineProperty(contents, "hidden", { value: 1 });
      },
    },
    {
      label: "locked hidden toJSON blocker",
      mutate: (contents: AgentExecDispatchReceiptContents) => {
        Object.defineProperty(contents, "toJSON", { value: undefined });
      },
    },
    {
      label: "symbol property",
      mutate: (contents: AgentExecDispatchReceiptContents) => {
        Object.defineProperty(contents, Symbol("hidden"), { value: 1 });
      },
    },
    {
      label: "accessor",
      mutate: (contents: AgentExecDispatchReceiptContents) => {
        const outcome = contents.calls[0]!.outcome;
        Object.defineProperty(contents.calls[0]!, "outcome", {
          enumerable: true,
          get: () => outcome,
        });
      },
    },
    {
      label: "prototype",
      mutate: (contents: AgentExecDispatchReceiptContents) => {
        Object.setPrototypeOf(contents, { hidden: true });
      },
    },
  ])("rejects or prevents $label mutation around proof issuance", ({ mutate }) => {
    const { source, baseContents } = createFixture();
    const preIssuanceMutation = structuredClone(baseContents);
    mutate(preIssuanceMutation);
    expect(
      createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        preIssuanceMutation,
      ),
    ).toBeUndefined();

    const boundContents = structuredClone(baseContents);
    const proof = createAgentExecZeroSubmissionProof(
      source.providerTransport,
      source.coverage.providerTransport,
      boundContents,
    );
    expect(() => mutate(boundContents)).toThrow(TypeError);
    expect(sealAgentExecDispatchReceipt(boundContents, proof)).toBeDefined();
  });

  it.each([
    {
      label: "shallow-frozen root",
      freeze: (contents: AgentExecDispatchReceiptContents) => {
        Object.freeze(contents);
      },
    },
    {
      label: "mixed frozen depth",
      freeze: (contents: AgentExecDispatchReceiptContents) => {
        Object.freeze(contents.calls);
        Object.freeze(contents);
      },
    },
  ])("deep-freezes nested values beneath a $label", ({ freeze }) => {
    const { source, baseContents } = createFixture();
    const boundContents = structuredClone(baseContents);
    freeze(boundContents);

    const proof = createAgentExecZeroSubmissionProof(
      source.providerTransport,
      source.coverage.providerTransport,
      boundContents,
    );
    expect(proof).toBeDefined();
    expect(() => {
      boundContents.calls[0]!.outcome = "aborted";
    }).toThrow(TypeError);
    expect(() => {
      boundContents.route!.model = "mutated-model";
    }).toThrow(TypeError);
    expect(sealAgentExecDispatchReceipt(boundContents, proof)).toBeDefined();
  });

  it.each([
    {
      label: "transparent proxy",
      wrap: (contents: AgentExecDispatchReceiptContents) => new Proxy(contents, {}),
    },
    {
      label: "prototype trap",
      wrap: (contents: AgentExecDispatchReceiptContents) =>
        new Proxy(contents, {
          getPrototypeOf() {
            throw new Error("prototype trap");
          },
        }),
    },
    {
      label: "ownKeys trap",
      wrap: (contents: AgentExecDispatchReceiptContents) =>
        new Proxy(contents, {
          ownKeys() {
            throw new Error("ownKeys trap");
          },
        }),
    },
    {
      label: "descriptor trap",
      wrap: (contents: AgentExecDispatchReceiptContents) =>
        new Proxy(contents, {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap");
          },
        }),
    },
  ])("rejects $label contents without invoking hostile traps", ({ wrap }) => {
    const { source, baseContents } = createFixture();
    const boundContents = structuredClone(baseContents);
    const proxy = wrap(boundContents);

    expect(() =>
      createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        proxy,
      ),
    ).not.toThrow();
    expect(
      createAgentExecZeroSubmissionProof(
        source.providerTransport,
        source.coverage.providerTransport,
        proxy,
      ),
    ).toBeUndefined();

    const proof = createAgentExecZeroSubmissionProof(
      source.providerTransport,
      source.coverage.providerTransport,
      boundContents,
    );
    expect(sealAgentExecDispatchReceipt(new Proxy(boundContents, {}), proof)).toBeUndefined();
  });
});
