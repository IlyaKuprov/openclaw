import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunPluginInstallCommandParams } from "../cli/plugins-install-preflight.js";
import { installClawPackages, preflightClawPackage } from "./packages.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan, ResolvedClawPackage } from "./types.js";

const INSTALL_POLICY_ACKNOWLEDGEMENT_ID = `sha256:${"a".repeat(64)}`;

function plan(
  packages: ResolvedClawPackage[],
  ownerAction: "install" | "reuse" = "install",
): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:plan",
    claw: {
      kind: "package",
      name: "incident-claw",
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/claw.json",
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 123,
    },
    agent: {
      requestedId: "incident",
      finalId: "incident-2",
      workspace: "/tmp/incident-2",
      config: { id: "incident-2", workspace: "/tmp/incident-2" },
    },
    summary: {
      totalActions: packages.length,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: packages.length,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    capabilityChanges: [],
    actions: packages.map((pkg) => ({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: {
        ...pkg,
        ownerAction,
        ...(pkg.kind === "plugin" ? { installId: pkg.ref.split("/").at(-1) } : {}),
      },
      blocked: false,
    })),
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pluginPackage = {
  kind: "plugin",
  source: "clawhub",
  ref: "@owner/audit",
  version: "2.0.1",
  integrity,
} as const;

const completePackageRef = vi.fn(
  (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => ({
    ...ref,
    status,
  }),
);
const pluginIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function pluginPackageRef(
  ref: string,
  overrides: Partial<PersistedClawPackageRef> = {},
): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "incident-2",
    clawName: "incident-claw",
    kind: "plugin",
    source: "clawhub",
    ref,
    version: "1.0.0",
    integrity: pluginIntegrity,
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}
const acquirePackageLease = vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() }));
const probePlugin = vi.fn(async ({ spec }: { spec: string }) => {
  const pluginId = spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!;
  const packageName = spec.replace(/^clawhub:/, "").replace(/@[^@]+$/, "");
  return {
    ok: true as const,
    pluginId,
    packageName,
    targetDir: "/tmp/plugin",
    extensions: [],
    clawhub: {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin" as const,
      integrity,
    },
  };
});

describe("preflightClawPackage", () => {
  it("replays a reviewed warning id when preflighting a skill package", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const preflightSkill = vi.fn().mockResolvedValue({
      ok: true,
      action: "install",
      integrity: skillIntegrity,
    });

    await preflightClawPackage(
      {
        kind: "skill",
        source: "clawhub",
        ref: "@owner/triage",
        version: "1.2.3",
      },
      "/tmp/workspace",
      {
        config: { security: { installPolicy: { enabled: true } } },
        mode: "update",
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
        deps: { preflightSkill },
      },
    );

    expect(preflightSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
      }),
    );
  });

  const setup = {
    providers: [
      {
        id: "evidence",
        authMethods: ["api-key"],
        envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
      },
    ],
  };
  const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });
  const probePluginSetup = vi.fn().mockResolvedValue({
    ok: true,
    pluginId: "evidence",
    setup,
    clawhub: { integrity },
  });

  it("reports plugin setup when no declared environment credential is present", async () => {
    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        requirements: [
          {
            kind: "plugin-setup",
            plugin: "evidence",
            provider: "evidence",
            envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
            authMethods: ["api-key"],
          },
        ],
      }),
    );
  });

  it("accepts any declared environment credential", async () => {
    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: { EVIDENCE_TOKEN: "configured" },
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("accepts credentials for any declared provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          { id: "first", envVars: ["FIRST_API_KEY"] },
          { id: "second", envVars: ["SECOND_API_KEY"] },
        ],
      },
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: { SECOND_API_KEY: "configured" },
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("does not gate readiness on an auth-method-only provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [{ id: "oauth-only", authMethods: ["oauth"] }],
      },
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: { preflightPlugin, probePlugin: probePluginSetup },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("accepts declared local auth evidence", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "claw-auth-evidence-"));
    const credentialsPath = join(credentialsDir, "credentials.json");
    await writeFile(credentialsPath, "{}", "utf8");
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          {
            ...setup.providers[0],
            authEvidence: [
              {
                type: "local-file-with-env",
                fileEnvVar: "EVIDENCE_CREDENTIALS",
                requiresAllEnv: ["EVIDENCE_PROJECT"],
                credentialMarker: "evidence-local-credentials",
              },
            ],
          },
        ],
      },
      clawhub: { integrity },
    });

    try {
      await expect(
        preflightClawPackage(pluginPackage, "/tmp/workspace", {
          env: {
            EVIDENCE_CREDENTIALS: credentialsPath,
            EVIDENCE_PROJECT: "project",
          },
          deps: { preflightPlugin, probePlugin: probePluginSetup },
        }),
      ).resolves.not.toHaveProperty("requirements");
    } finally {
      await rm(credentialsDir, { recursive: true, force: true });
    }
  });

  it("preflights dependency-tree policy in disposable storage and carries its warning", async () => {
    const warning = {
      reason: "Review dependency behavior",
      findings: [
        {
          ruleId: "dependency-shell",
          severity: "warn" as const,
          message: "Dependency runs a shell command",
        },
      ],
    };
    let disposableExtensionsDir: string | undefined;
    const policyProbe = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        pluginId: "audit",
        setup: undefined,
        clawhub: { integrity },
      })
      .mockImplementationOnce(async (params) => {
        disposableExtensionsDir = params.extensionsDir;
        expect(params).toMatchObject({
          mode: "update",
          expectedPluginId: "audit",
          expectedIntegrity: expect.stringMatching(/^sha256-/u),
          dangerouslyForceUnsafeInstall: true,
          installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
          emitSuccessSecurityEvent: false,
        });
        expect(params).not.toHaveProperty("dryRun");
        await expect(access(join(params.extensionsDir!, "audit"))).resolves.toBeUndefined();
        return {
          ok: false as const,
          code: "security_scan_blocked" as const,
          error: "dependency-tree warning requires acknowledgement",
          installPolicyWarning: warning,
        };
      });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        config: {
          security: {
            installPolicy: {
              enabled: true,
              exec: { source: "exec", command: "/tmp/policy" },
            },
          },
        },
        mode: "update",
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
        deps: {
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          probePlugin: policyProbe,
        },
      }),
    ).resolves.toMatchObject({ ok: true, installPolicyWarning: warning });
    expect(policyProbe).toHaveBeenCalledTimes(2);
    expect(policyProbe.mock.calls[0]?.[0]).toMatchObject({ config: {} });
    expect(policyProbe.mock.calls[1]?.[0]).toHaveProperty("config.security.installPolicy");
    expect(disposableExtensionsDir).toBeDefined();
    await expect(access(disposableExtensionsDir!)).rejects.toThrow();
  });

  it.each([
    { enabled: false, targets: undefined },
    { enabled: true, targets: ["skill" as const] },
  ])("skips the policy probe when plugin policy is inactive", async (installPolicy) => {
    const inactivePolicyProbe = vi.fn().mockResolvedValue({
      ok: true,
      pluginId: "audit",
      setup: undefined,
      clawhub: { integrity },
    });

    await preflightClawPackage(pluginPackage, "/tmp/workspace", {
      config: {
        security: {
          installPolicy: {
            ...installPolicy,
            exec: { source: "exec", command: "/tmp/policy" },
          },
        },
      },
      deps: {
        preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
        probePlugin: inactivePolicyProbe,
      },
    });

    expect(inactivePolicyProbe).toHaveBeenCalledTimes(1);
  });

  it("retains an acknowledged warning in the rebuilt consent plan", async () => {
    const warning = {
      reason: "Review package behavior",
      acknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
    };
    const policyProbe = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        pluginId: "audit",
        setup: undefined,
        clawhub: { integrity },
      })
      .mockImplementationOnce(async (params) => {
        expect(params.installPolicyAcknowledgementSequence?.presentedId).toBe(
          INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
        );
        params.installPolicyAcknowledgementSequence!.matched = true;
        params.installPolicyAcknowledgementSequence!.matchedWarning = warning;
        return {
          ok: true as const,
          pluginId: "audit",
          targetDir: params.extensionsDir!,
          extensions: [],
          clawhub: { integrity },
        };
      });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        config: {
          security: {
            installPolicy: {
              enabled: true,
              exec: { source: "exec", command: "/tmp/policy" },
            },
          },
        },
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
        deps: {
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          probePlugin: policyProbe,
        },
      }),
    ).resolves.toMatchObject({ ok: true, installPolicyWarning: warning });
  });
});

describe("installClawPackages", () => {
  it("uses each package's reviewed warning id after aggregate acknowledgement", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const installSkill = vi.fn().mockImplementation(async (params: { slug: string }) => ({
      ok: true,
      slug: params.slug,
      version: "1.2.3",
      targetDir: `/tmp/incident-2/skills/${params.slug}`,
    }));
    const packages = [
      {
        kind: "skill" as const,
        source: "clawhub" as const,
        ref: "@owner/first",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
      {
        kind: "skill" as const,
        source: "clawhub" as const,
        ref: "@owner/second",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
    ];

    await installClawPackages(plan(packages), {
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementIds: new Map([
        ["skill:@owner/first", INSTALL_POLICY_ACKNOWLEDGEMENT_ID],
        ["skill:@owner/second", `sha256:${"b".repeat(64)}`],
      ]),
      deps: {
        installSkill,
        preflightSkill: vi
          .fn()
          .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
        persistPackageRef: vi.fn((_plan, pkg) => ({ ...pkg, status: "pending" })),
        completePackageRef,
        acquirePackageLease,
      },
    });

    expect(installSkill.mock.calls.map((call) => call[0].installPolicyAcknowledgementId)).toEqual([
      INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
      `sha256:${"b".repeat(64)}`,
    ]);
  });

  it("preserves a replacement skill warning returned by the final installer", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const replacementWarning = {
      reason: "Review replacement warning",
      acknowledgementId: `sha256:${"b".repeat(64)}`,
    };
    const pending = {
      kind: "skill",
      ref: "@owner/triage",
      status: "pending",
      integrity: skillIntegrity,
    } as PersistedClawPackageRef;

    await expect(
      installClawPackages(
        plan([
          {
            kind: "skill",
            source: "clawhub",
            ref: "@owner/triage",
            version: "1.2.3",
            integrity: skillIntegrity,
          },
        ]),
        {
          deps: {
            preflightSkill: vi
              .fn()
              .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
            installSkill: vi.fn().mockResolvedValue({
              ok: false,
              error: "replacement acknowledgement required",
              installPolicyWarning: replacementWarning,
            }),
            persistPackageRef: vi.fn().mockReturnValue(pending),
            completePackageRef,
            acquirePackageLease,
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "install_policy_acknowledgement_required",
      message: "replacement acknowledgement required",
      installPolicyWarning: replacementWarning,
    });
  });

  it("installs skill packages into the planned workspace with the resolved digest", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const pending = {
      kind: "skill",
      ref: "@owner/triage",
      status: "pending",
      integrity: skillIntegrity,
    };
    const installSkill = vi.fn().mockResolvedValue({
      ok: true,
      slug: "triage",
      version: "1.2.3",
      targetDir: "/tmp/incident-2/skills/triage",
    });
    const persistPackageRef = vi.fn().mockReturnValue(pending);
    const onExternalMutation = vi.fn();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await installClawPackages(
      plan([
        {
          kind: "skill",
          source: "clawhub",
          ref: "@owner/triage",
          version: "1.2.3",
          integrity: skillIntegrity,
        },
      ]),
      {
        config: {
          security: {
            installPolicy: { exec: { source: "exec", command: "/tmp/policy" } },
          },
        },
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
        deps: {
          installSkill,
          preflightSkill: vi
            .fn()
            .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
        onExternalMutation,
        runtime,
      },
    );

    expect(installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/incident-2",
        slug: "@owner/triage",
        version: "1.2.3",
        expectedIntegrity: skillIntegrity,
        clawManaged: true,
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: INSTALL_POLICY_ACKNOWLEDGEMENT_ID,
        logger: { info: runtime.log, warn: runtime.error },
      }),
    );
    installSkill.mock.calls[0]?.[0].logger?.warn?.("Install policy: inspect shell execution");
    expect(runtime.error).toHaveBeenCalledWith("Install policy: inspect shell execution");
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ integrity: skillIntegrity }),
      expect.objectContaining({
        status: "pending",
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
    expect(onExternalMutation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "skill", ref: "@owner/triage" }),
    );
  });

  it("keeps the identity probe policy-free before the shared installer consumes every warning stage", async () => {
    const secondAcknowledgementId = `sha256:${"b".repeat(64)}`;
    const cumulativeAcknowledgementId = `${INSTALL_POLICY_ACKNOWLEDGEMENT_ID},${secondAcknowledgementId}`;
    const installPlugin = vi.fn().mockResolvedValue(undefined);
    const persistPackageRef = vi.fn().mockReturnValue({
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    });
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });

    await installClawPackages(plan([pluginPackage]), {
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementIds: new Map([
        [`plugin:${pluginPackage.ref}`, cumulativeAcknowledgementId],
      ]),
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        acquirePackageLease,
      },
    });

    expect(probePlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        dryRun: true,
      }),
    );
    expect(probePlugin.mock.calls[0]?.[0]).not.toHaveProperty("installPolicyAcknowledgementId");
    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "clawhub:@owner/audit@2.0.1",
        opts: {
          acknowledgeClawHubRisk: true,
          dangerouslyForceUnsafeInstall: true,
          installPolicyAcknowledgementId: cumulativeAcknowledgementId,
          expectedIntegrity:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expectedPluginId: "audit",
        },
        invalidateRuntimeCache: false,
        clawManaged: true,
      }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      expect.objectContaining({
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("preserves a replacement plugin warning returned by the final installer", async () => {
    const replacementWarning = {
      reason: "Review replacement plugin warning",
      acknowledgementId: `sha256:${"b".repeat(64)}`,
    };
    const installPlugin = vi.fn(async (params: RunPluginInstallCommandParams) => {
      params.onInstallPolicyWarning?.(replacementWarning);
    });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef: vi.fn().mockReturnValue({
            kind: "plugin",
            ref: "@owner/audit",
            status: "pending",
            integrity,
          }),
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "install_policy_acknowledgement_required",
      message: "Review replacement plugin warning",
      installPolicyWarning: replacementWarning,
    });
  });

  it("records a dependency ref without reinstalling an exact reused plugin", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const preflightPlugin = vi.fn().mockResolvedValue({
      ok: true,
      action: "reuse",
      installedId: "audit",
      installedIntegrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([]),
        acquirePackageLease,
      },
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      expect.objectContaining({
        status: "complete",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("inherits Claw-introduced origin when another Claw already owns the plugin", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("preserves a newer independent plugin reinstall when another Claw reuses it", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
      updatedAtMs: 10,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
          installedAt: new Date(20).toISOString(),
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("marks the pending ref failed when a plugin install fails", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const persistPackageRef = vi.fn().mockReturnValue(pending);

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [expect.objectContaining({ ref: "@owner/audit", status: "failed" })],
    });
  });

  it("removes a newly installed plugin when a later package fails", async () => {
    const rollbackIntegrity =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];
    const persistPackageRef = vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]);
    const readPackageRefs = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([pluginPackageRef("@owner/first")]);

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef,
            completePackageRef,
            readPackageRefs,
            acquirePackageLease,
            resolvePlugin: vi.fn().mockResolvedValue({
              status: "found",
              pluginId: "first",
              installedVersion: "1.0.0",
              record: {
                source: "clawhub",
                integrity: rollbackIntegrity,
                installedAt: new Date(1_500).toISOString(),
              },
            }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "package_install_failed", message: "second install failed" });

    expect(uninstallPlugin).toHaveBeenCalledWith(
      "first",
      { force: true, invalidateRuntimeCache: false, clawManaged: true },
      expect.anything(),
    );
    expect(completePackageRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "@owner/first" }),
      "rolled_back",
      expect.anything(),
    );
  });

  it("keeps a newly installed plugin when a direct owner claims it before rollback", async () => {
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef: vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]),
            completePackageRef,
            readPackageRefs: vi
              .fn()
              .mockReturnValueOnce([])
              .mockReturnValueOnce([pluginPackageRef("@owner/first", { independentOwner: true })]),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "package_rollback_failed",
      message: expect.stringContaining("now has a direct owner"),
    });

    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("preserves the installer error when failure provenance cannot be updated", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const failingCompletePackageRef = vi.fn(() => {
      throw new Error("state database unavailable");
    });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef: vi.fn().mockReturnValue(pending),
          completePackageRef: failingCompletePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [pending],
    });
    expect(failingCompletePackageRef).toHaveBeenCalledWith(pending, "failed", expect.anything());
  });

  it("invalidates consent when plugin owner state changes after planning", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn();
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "reuse" });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin,
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("invalidates consent when a skill trust warning changes after planning", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const planned = plan([
      {
        kind: "skill",
        source: "clawhub",
        ref: "@owner/triage",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
    ]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity: skillIntegrity,
            warning: "review warning two",
          }),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });

  it("invalidates consent when a plugin trust warning changes after planning", async () => {
    const planned = plan([pluginPackage]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          probePlugin: vi.fn().mockResolvedValue({
            ok: true,
            pluginId: "audit",
            warning: "review warning two",
            clawhub: { integrity },
          }),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });
});
