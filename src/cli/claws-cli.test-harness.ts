import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createClawUpdatePlanFixture } from "./claws-cli.test-fixtures.js";

export const INSTALL_POLICY_ACKNOWLEDGEMENT_ID = `sha256:${"a".repeat(64)}`;
export const SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID = `sha256:${"b".repeat(64)}`;
export const THIRD_INSTALL_POLICY_ACKNOWLEDGEMENT_ID = `sha256:${"c".repeat(64)}`;

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    logs,
    errors,
    runtime,
    loadConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
    listConfiguredMcpServers: vi.fn(),
    closeReadOnlyDatabase: vi.fn(),
    stateTableGet: vi.fn(),
    openExistingOpenClawStateDatabaseReadOnly: vi.fn(),
    applyClawAddPlan: vi.fn(),
    readClawStatus: vi.fn(),
    buildClawRemovePlan: vi.fn(),
    applyClawRemovePlan: vi.fn(),
    applyClawUpdatePlan: vi.fn(),
    buildClawUpdatePlan: vi.fn(),
    exportClawAgent: vi.fn(),
    callGatewayFromCli: vi.fn(),
    sleep: vi.fn(),
  };
});

export function getClawsCliMocks() {
  return mocks;
}

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

vi.mock("../utils/sleep.js", () => ({
  sleep: mocks.sleep,
}));

vi.mock("../state/openclaw-state-db.js", async () => ({
  ...(await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
    "../state/openclaw-state-db.js",
  )),
  openExistingOpenClawStateDatabaseReadOnly: mocks.openExistingOpenClawStateDatabaseReadOnly,
}));

vi.mock("../claws/add.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/add.js")>("../claws/add.js")),
  applyClawAddPlan: mocks.applyClawAddPlan,
}));

vi.mock("../claws/lifecycle-state.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/lifecycle-state.js")>(
    "../claws/lifecycle-state.js",
  )),
  readClawStatus: mocks.readClawStatus,
  buildClawRemovePlan: mocks.buildClawRemovePlan,
  applyClawRemovePlan: mocks.applyClawRemovePlan,
}));

vi.mock("../claws/export.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/export.js")>("../claws/export.js")),
  exportClawAgent: mocks.exportClawAgent,
}));

vi.mock("../claws/update-plan.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-plan.js")>("../claws/update-plan.js")),
  buildClawUpdatePlan: mocks.buildClawUpdatePlan,
}));

vi.mock("../claws/update-apply.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-apply.js")>("../claws/update-apply.js")),
  applyClawUpdatePlan: mocks.applyClawUpdatePlan,
}));

export const { registerClawsCli } = await import("./claws-cli.js");
export const { waitUntilGatewayConfigApplied } = await import("./claws-cli.gateway-readiness.js");
export const { runClawsAddCommand, runClawsUpdateCommand } = await import("./claws-cli.runtime.js");
export const { ClawAddMutationError } = await import("../claws/add.js");
export const { resolveClawInstallPolicyAcknowledgement } =
  await import("../claws/install-policy-acknowledgement.js");
export const { ClawUpdateMutationError } = await import("../claws/update-apply.js");
export const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const minimalManifest = { schemaVersion: 1, agent: { id: "demo-agent", name: "Demo Agent" } };

export async function writeManifest(value: unknown = minimalManifest): Promise<string> {
  const dir = tempDirs.make("openclaw-claws-cli-");
  const path = join(dir, "openclaw.claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

export async function writePackage(): Promise<{ root: string; workspace: string }> {
  const root = tempDirs.make("openclaw-claws-cli-package-");
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Demo\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/demo-agent",
      version: "1.2.3",
      openclaw: { claw: "openclaw.claw.json" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "openclaw.claw.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
      },
      packages: [
        {
          kind: "skill",
          source: "clawhub",
          ref: "@acme/demo-skill",
          version: "1.0.0",
        },
      ],
    }),
    "utf8",
  );
  return { root, workspace: join(root, "target-workspace") };
}

export async function canonicalFuturePath(target: string): Promise<string> {
  return join(await realpath(dirname(target)), basename(target));
}

export async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

export function resetClawsCliMocks(): void {
  vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
  mocks.logs.length = 0;
  mocks.errors.length = 0;
  mocks.runtime.log.mockClear();
  mocks.runtime.error.mockClear();
  mocks.runtime.writeJson.mockClear();
  mocks.runtime.exit.mockClear();
  mocks.loadConfig.mockReset();
  mocks.loadConfig.mockReturnValue({});
  mocks.listConfiguredMcpServers.mockReset();
  mocks.listConfiguredMcpServers.mockResolvedValue({
    ok: true,
    path: "config",
    config: {},
    mcpServers: {},
  });
  mocks.callGatewayFromCli.mockReset();
  mocks.sleep.mockReset();
  mocks.sleep.mockResolvedValue(undefined);
  mocks.closeReadOnlyDatabase.mockReset();
  mocks.stateTableGet.mockReset();
  mocks.stateTableGet.mockReturnValue({ 1: 1 });
  mocks.openExistingOpenClawStateDatabaseReadOnly.mockReset();
  mocks.openExistingOpenClawStateDatabaseReadOnly.mockReturnValue({
    db: { prepare: () => ({ get: mocks.stateTableGet }) },
    path: "state.sqlite",
    walMaintenance: { checkpoint: () => false, close: mocks.closeReadOnlyDatabase },
  });
  mocks.applyClawAddPlan.mockReset();
  mocks.applyClawAddPlan.mockImplementation(async (plan) => ({
    schemaVersion: "openclaw.clawAddResult.v1",
    stability: "experimental",
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: plan.planIntegrity,
    status: "complete",
    claw: plan.claw,
    agent: plan.agent,
    workspaceCreated: true,
    configCommitted: true,
    installRecord: { agentId: plan.agent.finalId },
  }));
  mocks.readClawStatus.mockReset();
  mocks.readClawStatus.mockResolvedValue({
    schemaVersion: "openclaw.clawStatus.v1",
    records: [],
    summary: { claws: 0, partial: 0, missingAgents: 0, driftedFiles: 0, packageRefs: 0 },
  });
  mocks.buildClawRemovePlan.mockReset();
  mocks.buildClawRemovePlan.mockResolvedValue({
    schemaVersion: "openclaw.clawRemovePlan.v1",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:remove-plan",
    target: "demo-agent",
    agentId: "demo-agent",
    actions: [
      {
        kind: "agent",
        id: "demo-agent",
        action: "remove",
        target: 'agents.entries["demo-agent"]',
        blocked: false,
      },
    ],
    blockers: [],
  });
  mocks.applyClawRemovePlan.mockReset();
  mocks.applyClawRemovePlan.mockResolvedValue({
    schemaVersion: "openclaw.clawRemoveResult.v1",
    dryRun: false,
    status: "complete",
    agentId: "demo-agent",
    agentRemoved: true,
    workspaceFiles: [],
    packages: [],
    mcpServers: [],
    cronJobs: [],
    packageRefsReleased: 1,
  });
  mocks.buildClawUpdatePlan.mockReset();
  mocks.buildClawUpdatePlan.mockResolvedValue(createClawUpdatePlanFixture());
  mocks.applyClawUpdatePlan.mockReset();
  mocks.applyClawUpdatePlan.mockResolvedValue({
    schemaVersion: "openclaw.clawUpdateResult.v1",
    stability: "experimental",
    dryRun: false,
    mutationAllowed: true,
    status: "complete",
    agentId: "demo-agent",
    previousClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
    appliedActions: [],
    installRecord: { agentId: "demo-agent" },
  });
  mocks.exportClawAgent.mockReset();
  mocks.exportClawAgent.mockResolvedValue({
    schemaVersion: "openclaw.clawExportResult.v1",
    stability: "experimental",
    agentId: "demo-agent",
    outputDirectory: "/tmp/exported",
    manifest: {
      schemaVersion: 1,
      agent: { id: "demo-agent" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    },
    filesWritten: ["package.json", "openclaw.claw.json"],
  });
}
