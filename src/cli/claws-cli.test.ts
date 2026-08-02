import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createClawUpdatePlanFixture } from "./claws-cli.test-fixtures.js";
import {
  canonicalFuturePath,
  ClawAddMutationError,
  ClawUpdateMutationError,
  getClawsCliMocks,
  INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
  registerClawsCli,
  resetClawsCliMocks,
  resolveClawInstallPolicyAcknowledgement,
  runClawsAddCommand,
  runClawsUpdateCommand,
  runCli,
  SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
  tempDirs,
  THIRD_INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
  waitUntilGatewayConfigApplied,
  writeManifest,
  writePackage,
} from "./claws-cli.test-harness.js";

const mocks = getClawsCliMocks();

describe("claws cli", () => {
  beforeEach(() => {
    resetClawsCliMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it("does not register without the process opt-in", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const program = new Command();

    registerClawsCli(program);

    expect(program.commands.map((command) => command.name())).not.toContain("claws");
  });

  it("registers the experimental grouped lifecycle without prototype apply or feed commands", () => {
    const program = new Command();
    registerClawsCli(program);
    const claws = program.commands.find((command) => command.name() === "claws");

    expect(claws?.commands.map((command) => command.name())).toEqual([
      "inspect",
      "add",
      "status",
      "update",
      "remove",
      "export",
    ]);
  });

  it("accepts an already-applied Gateway config revision", async () => {
    mocks.callGatewayFromCli.mockResolvedValue({
      configRevisionHash: "revision-new",
      appliedConfigHash: "revision-new",
    });

    await expect(waitUntilGatewayConfigApplied()).resolves.toBeUndefined();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledOnce();
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith("config.get", { timeout: "5000" }, {});
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("retries until the Gateway applies the persisted config revision", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce({
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
      })
      .mockResolvedValueOnce({
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      });

    await expect(waitUntilGatewayConfigApplied()).resolves.toBeUndefined();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).toHaveBeenCalledOnce();
    expect(mocks.sleep).toHaveBeenCalledWith(100);
  });

  it("reports the last Gateway error after the reload deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15_000);
    mocks.callGatewayFromCli.mockRejectedValue(new Error("gateway unavailable"));

    await expect(waitUntilGatewayConfigApplied()).rejects.toThrow(
      "Gateway did not apply the Claw agent configuration in time: gateway unavailable",
    );

    expect(mocks.callGatewayFromCli).toHaveBeenCalledOnce();
    expect(mocks.sleep).toHaveBeenCalledOnce();
  });

  it("prints versioned experimental JSON for a development manifest", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: { schemaVersion: 1, agent: { id: "demo-agent" } },
    });
  });

  it("takes identity from package.json and plans one new agent", async () => {
    const { root, workspace } = await writePackage();
    const expectedWorkspace = await canonicalFuturePath(workspace);

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      stability: "experimental",
      claw: { kind: "package", name: "@acme/demo-agent", version: "1.2.3" },
      agent: { finalId: "demo-agent", workspace: expectedWorkspace },
      summary: { agentActions: 1, workspaceActions: 2, packageActions: 1, blockedActions: 1 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("redacts credential-bearing remote MCP URLs in add previews", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      mcpServers: {
        remote: {
          url: "https://example.com/mcp?token=abc123&mode=ok",
          transport: "streamable-http",
        },
      },
    });
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");

    await runClawsAddCommand(manifestPath, { dryRun: true, workspace }, mocks.runtime);

    const output = mocks.logs.join("\n");
    expect(output).toContain("MCP remote:");
    expect(output).toContain("example.com");
    expect(output).not.toContain("abc123");
    expect(output).toContain("token=***");
  });

  it("blocks adding into an existing agent instead of merging", async () => {
    const { root, workspace } = await writePackage();
    mocks.loadConfig.mockReturnValue({ agents: { entries: { "demo-agent": {} } } });

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    const payload = JSON.parse(mocks.logs[0] ?? "{}");
    expect(payload.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_id_collision" }),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("honors an explicit unused agent id in the plan", async () => {
    const { root, workspace } = await writePackage();
    mocks.loadConfig.mockReturnValue({ agents: { entries: { "demo-agent": {} } } });

    await runCli([
      "claws",
      "add",
      root,
      "--dry-run",
      "--agent-id",
      "demo-agent-two",
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}").agent).toMatchObject({
      requestedId: "demo-agent",
      finalId: "demo-agent-two",
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("discloses capability escalations in the human dry-run", async () => {
    const root = tempDirs.make("openclaw-claws-cli-profile-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    allow: [read]\n",
      "utf8",
    );
    const path = join(root, "openclaw.claw.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        metadata: { "openclaw.config": "profiles/openclaw.yml" },
        mcpServers: {
          docs: {
            command: "node",
            env: { API_TOKEN: "${GITHUB_TOKEN}" },
            toolFilter: { include: ["search_*"] },
          },
        },
      }),
      "utf8",
    );

    await runCli(["claws", "add", path, "--dry-run"]);

    expect(mocks.logs).toContain("Capability escalations (2):");
    expect(mocks.logs.some((line) => line.startsWith("  ! agent:demo-agent"))).toBe(true);
    expect(mocks.logs.some((line) => line.startsWith("  ! mcpServer:docs"))).toBe(true);
    expect(mocks.logs.some((line) => line.includes('"env":["API_TOKEN"]'))).toBe(true);
    expect(mocks.logs).toContain("The plan integrity binds every capability line above.");
  });

  it("applies a minimal Claw only after explicit consent", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const expectedWorkspace = await canonicalFuturePath(workspace);
    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    mocks.logs.length = 0;

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--dangerously-force-unsafe-install",
      INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
      "--json",
    ]);

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity }),
      expect.objectContaining({
        consentPlanIntegrity: plan.planIntegrity,
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
      }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      agent: { finalId: "demo-agent", workspace: expectedWorkspace },
    });
  });

  it("prints findings from a fresh warning discovered during final add validation", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const warning = {
      reason: "Review the changed package",
      findings: [
        {
          ruleId: "package.network",
          severity: "warn" as const,
          message: "Package opens a network connection",
        },
      ],
      acknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
    };
    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.applyClawAddPlan.mockRejectedValueOnce(
      new ClawAddMutationError(
        "install_policy_acknowledgement_required",
        "Install policy warning requires acknowledgement.",
        warning,
      ),
    );

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
    ]);

    expect(mocks.logs).toContain("Install policy warning: Review the changed package");
    expect(mocks.logs).toContain("  - [warn] package.network: Package opens a network connection");
    expect(mocks.errors).toContain("Install policy warning requires acknowledgement.");

    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.applyClawAddPlan.mockResolvedValueOnce({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "partial",
      claw: plan.claw,
      agent: plan.agent,
      error: {
        code: "install_policy_acknowledgement_required",
        message: "Install policy warning requires acknowledgement.",
        installPolicyWarning: warning,
      },
    });

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
    ]);

    expect(mocks.logs).toContain("Install policy warning: Review the changed package");
    expect(mocks.errors).toContain("Install policy warning requires acknowledgement.");
  });

  it("resumes consented add with the matching in-flight workspace on disk", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
    await mkdir(workspace);
    await writeFile(join(workspace, "leftover.txt"), "keep", "utf8");
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({});

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity, blockers: [] }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("resumes when config committed before the workspace-ready phase advanced", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
    await mkdir(workspace);
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({ agents: { list: [plan.agent.config] } });

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity, blockers: [] }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("does not claim an on-disk workspace for a partial record without workspace ownership", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "partial", nowMs: 1 });
    await mkdir(workspace);
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      blockers: [expect.objectContaining({ code: "workspace_collision" })],
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves a real agent collision while an add is still pending", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "pending", nowMs: 1 });
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({ agents: { list: [{ id: "demo-agent", workspace }] } });

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      blockers: expect.arrayContaining([expect.objectContaining({ code: "agent_id_collision" })]),
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not resume through another agent's configured workspace", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({ agents: { list: [{ id: "other-agent", workspace }] } });

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      blockers: [expect.objectContaining({ code: "workspace_collision" })],
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
  });

  it("requires the exact dry-run plan identity with explicit consent", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "add", manifestPath, "--yes", "--json"]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "plan_integrity_required" },
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();

    mocks.logs.length = 0;
    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      "sha256:stale",
      "--json",
    ]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      status: "failed",
      error: { code: "plan_integrity_mismatch" },
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
  });

  it("fails closed when add is invoked without dry-run or consent", async () => {
    const path = await writeManifest();

    await runCli(["claws", "add", path, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      stability: "experimental",
      ok: false,
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports installed Claw status by agent id", async () => {
    mocks.readClawStatus.mockResolvedValue({
      schemaVersion: "openclaw.clawStatus.v1",
      target: "demo-agent",
      records: [
        {
          install: { agentId: "demo-agent" },
          agentState: "present",
          workspaceFiles: [],
          packages: [],
        },
      ],
      summary: { claws: 1, partial: 0, missingAgents: 0, driftedFiles: 0, packageRefs: 0 },
    });

    await runCli(["claws", "status", "demo-agent", "--json"]);

    expect(mocks.readClawStatus).toHaveBeenCalledWith("demo-agent");
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawStatus.v1",
      summary: { claws: 1 },
    });
  });

  it("prints a read-only remove plan without applying it", async () => {
    await runCli(["claws", "remove", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.buildClawRemovePlan).toHaveBeenCalledWith("demo-agent", {
      referencedCleanup: { mode: "retain" },
    });
    expect(mocks.applyClawRemovePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawRemovePlan.v1",
      mutationAllowed: false,
    });
  });

  it("prints a read-only grouped update plan", async () => {
    const { root } = await writePackage();

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);

    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "demo-agent",
        targetManifest: expect.objectContaining({
          agent: { id: "demo-agent", name: "Demo Agent" },
        }),
        targetSource: expect.objectContaining({ name: "@acme/demo-agent", version: "1.2.3" }),
        config: {},
        sourceMcpServers: {},
      }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      dryRun: true,
      mutationAllowed: false,
      agentId: "demo-agent",
    });
  });

  it("prints capability escalation details in human update previews", async () => {
    const { root } = await writePackage();
    const fixture = createClawUpdatePlanFixture();
    fixture.actions.push({
      kind: "package",
      id: "skill:@acme/unchanged-skill",
      action: "unchanged",
      target: "clawhub:@acme/unchanged-skill@1.0.0",
      blocked: false,
      reason: "package is unchanged",
      installPolicyWarning: {
        reason: "Stale warning for unchanged package",
        acknowledgementId: SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
      },
    });
    mocks.buildClawUpdatePlan.mockResolvedValueOnce(fixture);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run"]);

    const output = mocks.logs.join("\n");
    expect(output).toContain("Capability changes: 1; escalations requiring explicit review: 1");
    expect(output).toContain("Plan integrity: sha256:update-plan");
    expect(output).toContain("Install policy warning: Review skill behavior");
    expect(output).toContain("[warn] shell: Runs a shell command");
    expect(output).toContain(`Install policy acknowledgement: sha256:${"a".repeat(64)}`);
    expect(output).not.toContain("Stale warning for unchanged package");
    expect(output).not.toContain(SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID);
    expect(output).toContain(
      "Capability consent: the exact plan-integrity token binds every ! change disclosed below.",
    );
    expect(output).toContain("! agent.sandbox.mode: non-main -> all (change)");
    expect(output).toContain(
      'effect: {"path":"sandbox.mode","current":"non-main","desired":"all"}',
    );
  });

  it("returns failure when an update plan contains blocked actions", async () => {
    const { root } = await writePackage();
    mocks.buildClawUpdatePlan.mockResolvedValueOnce({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:blocked-plan",
      found: true,
      agentId: "demo-agent",
      summary: {
        totalActions: 1,
        added: 0,
        changed: 0,
        removed: 0,
        released: 0,
        unchanged: 0,
        manual: 1,
        blocked: 1,
        capabilityChanges: 0,
        capabilityEscalations: 0,
      },
      capabilityChanges: [],
      actions: [
        {
          kind: "workspaceFile",
          id: "SOUL.md",
          action: "manual",
          target: "workspace:SOUL.md",
          blocked: true,
          reason: "Local content changed.",
        },
      ],
      blockers: [],
      diagnostics: [],
    });

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);

    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("uses the source recorded by the installed Claw when --from is omitted", async () => {
    const { root } = await writePackage();
    mocks.readClawStatus.mockResolvedValue({
      schemaVersion: "openclaw.clawStatus.v1",
      records: [
        {
          install: {
            agentId: "demo-agent",
            claw: {
              kind: "package",
              name: "@acme/demo-agent",
              version: "1.0.0",
              packageRoot: root,
              manifestPath: join(root, "openclaw.claw.json"),
              integrity: "sha256:old",
            },
          },
          workspaceFiles: [],
          packages: [],
          mcpServers: [],
          cronJobs: [],
        },
      ],
      summary: { claws: 1 },
    });

    await runCli(["claws", "update", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.readClawStatus).toHaveBeenCalledWith(
      "demo-agent",
      expect.objectContaining({ readOnly: true, sourceMcpServers: {} }),
    );
    expect(mocks.closeReadOnlyDatabase).toHaveBeenCalled();
    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "demo-agent",
        targetSource: expect.objectContaining({ name: "@acme/demo-agent", version: "1.2.3" }),
      }),
    );
  });

  it("returns not found for a supported state database without Claws tables", async () => {
    mocks.stateTableGet.mockReturnValue(undefined);

    await runCli(["claws", "update", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.readClawStatus).not.toHaveBeenCalled();
    expect(mocks.closeReadOnlyDatabase).toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "claw_not_found", phase: "plan" })],
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when update is invoked without dry-run", async () => {
    const { root } = await writePackage();

    await runCli(["claws", "update", "demo-agent", "--from", root, "--json"]);

    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("requires exact plan integrity with update consent", async () => {
    const { root } = await writePackage();

    await runCli(["claws", "update", "demo-agent", "--from", root, "--yes", "--json"]);

    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("applies a supported update only after explicit consent", async () => {
    const { root } = await writePackage();

    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--dangerously-force-unsafe-install",
      INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
      "--json",
    ]);

    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "demo-agent" }),
      expect.objectContaining({
        targetManifest: expect.objectContaining({
          agent: { id: "demo-agent", name: "Demo Agent" },
        }),
      }),
      expect.objectContaining({
        config: {},
        sourceMcpServers: {},
        consentPlanIntegrity: "sha256:update-plan",
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
        packagePreflight: expect.any(Function),
        cronGateway: expect.objectContaining({
          add: expect.any(Function),
          get: expect.any(Function),
          remove: expect.any(Function),
        }),
      }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "complete",
      agentId: "demo-agent",
    });
  });

  it("returns the rebuilt plan and exact retry when acknowledgement reveals another warning", async () => {
    const { root } = await writePackage();
    const fixture = createClawUpdatePlanFixture();
    const warning = { reason: "Review", acknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID };
    const plan = {
      ...fixture,
      planIntegrity: "sha256:reviewed-update",
      actions: [{ ...fixture.actions[0]!, installPolicyWarning: warning }],
    };
    const nextWarning = {
      reason: "Review dependency tree",
      acknowledgementId: SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
    };
    const nextPlan = {
      ...plan,
      planIntegrity: "sha256:dependency-tree-update",
      actions: [{ ...fixture.actions[0]!, installPolicyWarning: nextWarning }],
    };
    mocks.buildClawUpdatePlan.mockResolvedValueOnce(plan).mockResolvedValueOnce(nextPlan);
    mocks.applyClawUpdatePlan.mockRejectedValueOnce(
      new ClawUpdateMutationError(
        "install_policy_acknowledgement_required",
        "Install policy warning requires acknowledgement.",
        nextWarning,
        nextPlan.planIntegrity,
      ),
    );

    await expect(
      runClawsUpdateCommand(
        "demo-agent",
        {
          from: root,
          yes: true,
          planIntegrity: plan.planIntegrity,
          dangerouslyForceUnsafeInstall: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
          json: true,
        },
        mocks.runtime,
      ),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledTimes(2);
    const acknowledgedPreflight = mocks.buildClawUpdatePlan.mock.calls[1]?.[0].packagePreflight;
    expect(acknowledgedPreflight).not.toBe(
      mocks.buildClawUpdatePlan.mock.calls[0]?.[0].packagePreflight,
    );
    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledWith(
      nextPlan,
      expect.anything(),
      expect.objectContaining({ consentPlanIntegrity: nextPlan.planIntegrity }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      status: "failed",
      error: {
        code: "install_policy_acknowledgement_required",
        planIntegrity: nextPlan.planIntegrity,
        retryCommand: `openclaw claws update demo-agent --from ${root} --yes --plan-integrity ${nextPlan.planIntegrity} --dangerously-force-unsafe-install ${SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID}`,
      },
    });
  });

  it("preserves every package acknowledgement after consuming a multi-package warning plan", async () => {
    const { root } = await writePackage();
    const fixture = createClawUpdatePlanFixture();
    const action = fixture.actions[0]!;
    const firstPlan = {
      ...fixture,
      planIntegrity: "sha256:first-warning-plan",
      actions: [
        {
          ...action,
          installPolicyWarning: {
            reason: "Review package metadata",
            acknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
          },
        },
      ],
    };
    const secondPlan = {
      ...fixture,
      planIntegrity: "sha256:second-warning-plan",
      actions: [
        {
          ...action,
          installPolicyWarning: {
            reason: "Review dependency tree",
            acknowledgementId: SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
          },
        },
        {
          ...action,
          id: "plugin:@acme/second-package",
          installPolicyWarning: {
            reason: "Review second package dependency tree",
            acknowledgementId: THIRD_INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
          },
        },
      ],
    };
    const finalPlan = {
      ...fixture,
      planIntegrity: "sha256:acknowledged-plan",
      actions: secondPlan.actions.map(
        ({ installPolicyWarning: _warning, ...candidate }) => candidate,
      ),
    };
    const aggregateAcknowledgement = resolveClawInstallPolicyAcknowledgement(
      secondPlan.actions.map((candidate) => ({
        packageId: candidate.id,
        warning: candidate.installPolicyWarning,
      })),
    );
    mocks.buildClawUpdatePlan
      .mockResolvedValueOnce(firstPlan)
      .mockResolvedValueOnce(secondPlan)
      .mockResolvedValueOnce(finalPlan);

    await runClawsUpdateCommand(
      "demo-agent",
      {
        from: root,
        yes: true,
        planIntegrity: secondPlan.planIntegrity,
        dangerouslyForceUnsafeInstall: aggregateAcknowledgement.acknowledgementId,
        json: true,
      },
      mocks.runtime,
    );

    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledTimes(3);
    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledWith(
      finalPlan,
      expect.anything(),
      expect.objectContaining({
        consentPlanIntegrity: finalPlan.planIntegrity,
        installPolicyAcknowledgementId: aggregateAcknowledgement.acknowledgementId,
        installPolicyAcknowledgementIds: new Map([
          [action.id, SECOND_INSTALL_POLICY_ACKNOWLEDGEMENT_ID],
          ["plugin:@acme/second-package", THIRD_INSTALL_POLICY_ACKNOWLEDGEMENT_ID],
        ]),
        packagePreflight: expect.any(Function),
      }),
    );
  });

  it("reports uncertain update mutations as partial JSON", async () => {
    const { root } = await writePackage();
    mocks.applyClawUpdatePlan.mockRejectedValueOnce(
      new ClawUpdateMutationError("update_partial", "artifact outcome requires reconciliation"),
    );

    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "partial",
      error: { code: "update_partial" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves a late update policy warning in JSON", async () => {
    const { root } = await writePackage();
    const warning = {
      reason: "Review the changed package",
      findings: [{ ruleId: "network", severity: "warn" as const, message: "Opens a socket" }],
      acknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
    };
    mocks.applyClawUpdatePlan.mockRejectedValueOnce(
      new ClawUpdateMutationError(
        "install_policy_acknowledgement_required",
        "review required",
        warning,
      ),
    );

    await expect(
      runClawsUpdateCommand(
        "demo-agent",
        {
          from: root,
          yes: true,
          planIntegrity: "sha256:update-plan",
          json: true,
        },
        mocks.runtime,
      ),
    ).rejects.toThrow("__exit__:1");

    expect(JSON.parse(mocks.logs.at(-1) ?? "{}")).toMatchObject({
      status: "failed",
      error: { code: "install_policy_acknowledgement_required", installPolicyWarning: warning },
    });
  });

  it("applies remove only after explicit consent", async () => {
    await runCli([
      "claws",
      "remove",
      "demo-agent",
      "--yes",
      "--plan-integrity",
      "sha256:remove-plan",
      "--json",
    ]);

    expect(mocks.applyClawRemovePlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: "sha256:remove-plan" }),
      expect.objectContaining({
        consentPlanIntegrity: "sha256:remove-plan",
        referencedCleanup: { mode: "retain" },
      }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawRemoveResult.v1",
      status: "complete",
      agentId: "demo-agent",
    });
  });

  it("requires the exact dry-run identity with remove consent", async () => {
    await runCli(["claws", "remove", "demo-agent", "--yes", "--json"]);

    expect(mocks.buildClawRemovePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawRemovePlan.v1",
      error: { code: "plan_integrity_required" },
    });
  });

  it("binds selected referenced cleanup and its conflict override into the plan", async () => {
    await runCli([
      "claws",
      "remove",
      "demo-agent",
      "--dry-run",
      "--remove-referenced",
      "plugin:@acme/audit@1.0.0",
      "--force-referenced",
      "--json",
    ]);

    expect(mocks.buildClawRemovePlan).toHaveBeenCalledWith("demo-agent", {
      referencedCleanup: {
        mode: "remove-selected",
        selected: ["plugin:@acme/audit@1.0.0"],
        allowConflicts: true,
      },
    });
  });

  it("rejects ambiguous referenced cleanup modes", async () => {
    await runCli([
      "claws",
      "remove",
      "demo-agent",
      "--dry-run",
      "--remove-unused",
      "--remove-referenced",
      "plugin:@acme/audit@1.0.0",
      "--json",
    ]);

    expect(mocks.buildClawRemovePlan).not.toHaveBeenCalled();
    expect(mocks.errors).toContain(
      "Choose either --remove-unused or --remove-referenced, not both.",
    );
  });

  it("fails closed when remove has neither preview nor consent", async () => {
    await runCli(["claws", "remove", "demo-agent", "--json"]);

    expect(mocks.buildClawRemovePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "consent_required" },
    });
  });

  it("exports one installed agent to a new package directory", async () => {
    await runCli(["claws", "export", "demo-agent", "--out", "/tmp/exported", "--json"]);

    expect(mocks.exportClawAgent).toHaveBeenCalledWith("demo-agent", "/tmp/exported", {
      config: {},
      sourceMcpServers: {},
    });
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "demo-agent",
    });
  });
});
