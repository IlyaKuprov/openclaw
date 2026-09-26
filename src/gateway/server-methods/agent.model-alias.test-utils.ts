// Imported by agent.test.ts so aliases use the registered Gateway agent harness.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  primeMainAgentRun,
  invokeAgent,
  waitForAgentCommandCall,
  expectRecordFields,
  expectRespondError,
  expectStringFieldContains,
  describe0AfterEach0,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent model aliases", () => {
  afterEach(describe0AfterEach0);
  it("resolves an exact model-run alias from the selected Gateway agent", async () => {
    primeMainAgentRun();
    mocks.loadConfigReturn = {
      agents: {
        entries: { main: { models: { "anthropic/claude-haiku-4-5": { alias: "remote-only" } } } },
      },
    };
    await invokeAgent(
      {
        message: "alias probe",
        agentId: "main",
        sessionKey: "agent:main:main",
        modelAlias: "remote-only",
        modelRun: true,
        idempotencyKey: "alias-probe-1",
      },
      { client: operatorWriteCliClient(["operator.admin"]) },
    );
    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("accepts a case-normalized explicit agent ID for a model-run alias", async () => {
    primeMainAgentRun();
    mocks.loadConfigReturn = {
      agents: {
        entries: { main: { models: { "anthropic/claude-haiku-4-5": { alias: "remote-only" } } } },
      },
    };
    await invokeAgent(
      {
        message: "alias probe",
        agentId: "Main",
        sessionKey: "agent:main:main",
        modelAlias: "remote-only",
        modelRun: true,
        idempotencyKey: "alias-probe-case-normalized",
      },
      { client: operatorWriteCliClient(["operator.admin"]) },
    );
    expectRecordFields(await waitForAgentCommandCall(), {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it.each([
    {
      name: "unknown",
      alias: "missing",
      modelRun: true,
      scopes: ["operator.admin"],
      error: "Unknown model alias",
    },
    {
      name: "unauthorized",
      alias: "remote-only",
      modelRun: true,
      scopes: ["operator.write"],
      error: "not authorized",
    },
    {
      name: "non-model-run",
      alias: "remote-only",
      modelRun: false,
      scopes: ["operator.admin"],
      error: "modelRun=true",
    },
  ])(
    "rejects $name Gateway alias requests before dispatch",
    async ({ alias, modelRun, scopes, error }) => {
      mocks.loadConfigReturn = {
        agents: {
          entries: { main: { models: { "anthropic/claude-haiku-4-5": { alias: "remote-only" } } } },
        },
      };
      const respond = vi.fn();
      await invokeAgent(
        {
          message: "probe",
          agentId: "main",
          sessionKey: "agent:main:main",
          modelAlias: alias,
          modelRun,
          idempotencyKey: `alias-${alias}-${modelRun}-${scopes[0]}`,
        },
        { client: operatorWriteCliClient(scopes), respond },
      );
      expectStringFieldContains(expectRespondError(respond, {}), "message", error);
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    },
  );

  it("rejects simultaneous modelAlias and provider/model overrides", async () => {
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "probe",
        agentId: "main",
        modelAlias: "remote-only",
        provider: "openai",
        model: "gpt-5",
        modelRun: true,
        idempotencyKey: "alias-conflict",
      },
      { client: operatorWriteCliClient(["operator.admin"]), respond },
    );
    expectStringFieldContains(
      expectRespondError(respond, {}),
      "message",
      "no provider/model override",
    );
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("rejects alias resolution when an explicit agent differs from the session-key agent", async () => {
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "probe",
        agentId: "other",
        sessionKey: "agent:main:main",
        modelAlias: "remote-only",
        modelRun: true,
        idempotencyKey: "alias-mismatched-owner",
      },
      { client: operatorWriteCliClient(["operator.admin"]), respond },
    );
    expectStringFieldContains(expectRespondError(respond, {}), "message", "selected Gateway agent");
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });
});
