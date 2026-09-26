// Model reference and alias resolution through the registered capability CLI.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCapabilityCliMocks,
  resetCapabilityCliMocks,
  restoreCapabilityCliMocks,
} from "./capability-cli.test-harness.js";

const mocks = getCapabilityCliMocks();
// Register mocks from the shared harness before loading the CLI under test.
const { registerCapabilityCli } = await import("./capability-cli.js");

async function runCap(...argv: string[]): Promise<void> {
  const program = new Command();
  await registerCapabilityCli(program, ["node", "openclaw", ...argv]);
  await program.parseAsync(argv, { from: "user" });
}

function runCapability(domain: string, action: string, ...argv: string[]): Promise<void> {
  return runCap("capability", domain, action, ...argv);
}

describe("capability cli model resolution", () => {
  afterEach(restoreCapabilityCliMocks);
  beforeEach(resetCapabilityCliMocks);

  async function runModelRunWithModel(model: string, transport: "local" | "gateway") {
    await runCapability(
      "model",
      "run",
      "--model",
      model,
      "--prompt",
      "hello",
      ...(transport === "gateway" ? ["--gateway"] : []),
      "--json",
    );
  }

  function firstGatewayCall() {
    const calls = mocks.callGateway.mock.calls as unknown as Array<
      [{ method?: unknown; params?: Record<string, unknown> }]
    >;
    return calls[0]?.[0];
  }

  function firstPreparedModelParams() {
    const calls = mocks.acquireSimpleCompletionModelForAgent.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    return calls[0]?.[0];
  }

  function expectModelRunDispatch(transport: "local" | "gateway", modelRef: string) {
    if (transport === "gateway") {
      const slash = modelRef.indexOf("/");
      const gatewayCall = firstGatewayCall();
      expect(gatewayCall?.method).toBe("agent");
      expect(gatewayCall?.params?.provider).toBe(modelRef.slice(0, slash));
      expect(gatewayCall?.params?.model).toBe(modelRef.slice(slash + 1));
      return;
    }
    expect(firstPreparedModelParams()?.modelRef).toBe(modelRef);
  }

  function expectRuntimeErrorContains(expected: string): void {
    expect(
      mocks.runtime.error.mock.calls.map((call) => String(call[0] ?? "")).join("\n"),
    ).toContain(expected);
  }

  it.each(["local", "gateway"] as const)(
    "canonicalizes case-only catalog model refs before %s dispatch",
    async (transport) => {
      mocks.loadModelCatalog.mockResolvedValueOnce([
        { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7" },
      ] as never);

      await runModelRunWithModel("Anthropic/CLAUDE-OPUS-4-7", transport);

      const catalogCalls = mocks.loadModelCatalog.mock.calls as unknown as Array<
        [{ readOnly?: unknown }]
      >;
      const catalogParams = catalogCalls[0]?.[0];
      expect(catalogParams?.readOnly).toBe(true);
      expectModelRunDispatch(transport, "anthropic/claude-opus-4-7");
    },
  );

  it("canonicalizes case-only catalog refs and preserves auth profiles before local dispatch", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7" },
    ] as never);

    await runModelRunWithModel("Anthropic/CLAUDE-OPUS-4-7@work", "local");

    expectModelRunDispatch("local", "anthropic/claude-opus-4-7@work");
  });

  it("leaves auth profile refs unchanged before gateway dispatch", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7" },
    ] as never);

    await runModelRunWithModel("Anthropic/CLAUDE-OPUS-4-7@work", "gateway");

    expectModelRunDispatch("gateway", "Anthropic/CLAUDE-OPUS-4-7@work");
  });

  it("preserves custom mixed-case profile refs before local dispatch when the catalog has no match", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([] as never);

    await runModelRunWithModel("custom/MyModel@work", "local");

    expectModelRunDispatch("local", "custom/MyModel@work");
  });

  function mockConfiguredModelAlias(): void {
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: { "openai/gpt-5.5": { alias: "gpt-5.5-codex" } },
        },
      },
    });
  }

  it.each(["local", "gateway"] as const)(
    "resolves configured bare model aliases before %s dispatch",
    async (transport) => {
      mockConfiguredModelAlias();

      await runModelRunWithModel("gpt-5.5-codex", transport);

      expectModelRunDispatch(transport, "openai/gpt-5.5");
    },
  );

  it("keeps an explicit profile suffix out of configured alias resolution before dispatch", async () => {
    mockConfiguredModelAlias();

    await expect(runModelRunWithModel("gpt-5.5-codex@work", "gateway")).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Model overrides must use the form <provider/model>.");
    expect(mocks.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("resolves configured bare aliases for model inspection", async () => {
    const catalogEntry = { id: "gpt-5.5", provider: "openai", name: "GPT-5.5" };
    mockConfiguredModelAlias();
    mocks.loadModelCatalog.mockResolvedValueOnce([catalogEntry] as never);

    await runCap("capability", "model", "inspect", "--model", "gpt-5.5-codex", "--json");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(catalogEntry);
  });

  it("fails a configured alias whose target is absent instead of reading the alias as a catalog id", async () => {
    mockConfiguredModelAlias();
    // Another provider exposes an id equal to the alias text; the alias must not fall back to it.
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "gpt-5.5-codex", provider: "github-copilot", name: "Copilot Codex" },
    ] as never);

    await expect(
      runCap("capability", "model", "inspect", "--model", "gpt-5.5-codex", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("configured alias for openai/gpt-5.5");
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("keeps an explicit profile suffix out of configured alias resolution for model inspection", async () => {
    mockConfiguredModelAlias();
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "gpt-5.5", provider: "openai", name: "GPT-5.5" },
    ] as never);

    await expect(
      runCap("capability", "model", "inspect", "--model", "gpt-5.5-codex@work", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Model not found: gpt-5.5-codex@work");
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("keeps resolving a bare catalog id for model inspection", async () => {
    const catalogEntry = { id: "gpt-5.6-sol", provider: "openai", name: "GPT-5.6 Sol" };
    mocks.loadConfig.mockReturnValue({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } },
    });
    mocks.loadModelCatalog.mockResolvedValueOnce([catalogEntry] as never);

    await runCap("capability", "model", "inspect", "--model", "gpt-5.6-sol", "--json");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(catalogEntry);
  });

  it("reports the original unknown model name after alias lookup misses", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    });
    mocks.loadModelCatalog.mockResolvedValueOnce([] as never);

    await expect(
      runCap("capability", "model", "inspect", "--model", "missing-model", "--json"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Model not found: missing-model");
  });
});
