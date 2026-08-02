import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallPolicyAcknowledgementSequence } from "./install-security-scan.types.js";

const runInstallPolicyMock = vi.fn();
const digestInstallPolicySourceMock = vi.fn();
const findBlockedManifestDependenciesMock = vi.fn();
const findBlockedNodeModulesDirectoryMock = vi.fn();
const findBlockedNodeModulesFileAliasMock = vi.fn();
const findBlockedPackageDirectoryInPathMock = vi.fn();
const findBlockedPackageFileAliasInPathMock = vi.fn();
const getGlobalHookRunnerMock = vi.fn();

vi.mock("../security/install-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/install-policy.js")>();
  return {
    ...actual,
    runInstallPolicy: (...args: unknown[]) => runInstallPolicyMock(...args),
  };
});

vi.mock("../security/install-policy-source-digest.js", () => ({
  digestInstallPolicySource: (...args: unknown[]) => digestInstallPolicySourceMock(...args),
}));

vi.mock("./dependency-denylist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dependency-denylist.js")>();
  return {
    ...actual,
    findBlockedManifestDependencies: (...args: unknown[]) =>
      findBlockedManifestDependenciesMock(...args),
    findBlockedNodeModulesDirectory: (...args: unknown[]) =>
      findBlockedNodeModulesDirectoryMock(...args),
    findBlockedNodeModulesFileAlias: (...args: unknown[]) =>
      findBlockedNodeModulesFileAliasMock(...args),
    findBlockedPackageDirectoryInPath: (...args: unknown[]) =>
      findBlockedPackageDirectoryInPathMock(...args),
    findBlockedPackageFileAliasInPath: (...args: unknown[]) =>
      findBlockedPackageFileAliasInPathMock(...args),
  };
});

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

const {
  evaluateSkillInstallPolicyRuntime,
  preflightPluginNpmInstallPolicyRuntime,
  preflightPluginGitInstallPolicyRuntime,
  scanBundleInstallSourceRuntime,
  scanFileInstallSourceRuntime,
  scanInstalledPackageDependencyTreeRuntime,
} = await import("./install-security-scan.runtime.js");
const { createInstallPolicyWarningAcknowledgementId, projectInstallPolicyWarningForExternal } =
  await import("../security/install-policy.js");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

function expectOnlyOperatorPolicyRan() {
  expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  expect(findBlockedManifestDependenciesMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesDirectoryMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesFileAliasMock).not.toHaveBeenCalled();
  expect(findBlockedPackageDirectoryInPathMock).not.toHaveBeenCalled();
  expect(findBlockedPackageFileAliasInPathMock).not.toHaveBeenCalled();
  expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  runInstallPolicyMock.mockReset();
  digestInstallPolicySourceMock.mockReset();
  digestInstallPolicySourceMock.mockResolvedValue("sha256:stable-source");
  findBlockedManifestDependenciesMock.mockReset();
  findBlockedNodeModulesDirectoryMock.mockReset();
  findBlockedNodeModulesFileAliasMock.mockReset();
  findBlockedPackageDirectoryInPathMock.mockReset();
  findBlockedPackageFileAliasInPathMock.mockReset();
  getGlobalHookRunnerMock.mockReset();
});

describe("install security scan official bypass", () => {
  it("bypasses plugin install friction for bundled OpenClaw sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "openclaw/kitchen-sink",
      sourceDir: "/tmp/openclaw-bundled-plugin",
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses plugin install friction for official ClawHub sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses skill install friction for bundled OpenClaw sources", async () => {
    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "openclaw-bundled",
        skillName: "peekaboo",
        installId: "node",
      },
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
      skillName: "peekaboo",
      sourceDir: "/tmp/openclaw-bundled-skill/peekaboo",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("runs only operator policy for official immutable npm sources", async () => {
    const result = await preflightPluginNpmInstallPolicyRuntime({
      logger: {},
      packageName: "@openclaw/matrix",
      requestedSpecifier: "@openclaw/matrix@latest",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourcePath: "/tmp/openclaw-official-npm",
      sourcePathKind: "directory",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("lets operator policy block official sources", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expectOnlyOperatorPolicyRan();
  });

  it("still runs install policy for mutable workspace skill sources", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "workspace",
        skillName: "local-skill",
        installId: "node",
      },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "local-skill",
      sourceDir: "/tmp/local-skill",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });
});

describe("install policy warnings", () => {
  const warningParams = {
    logger: {},
    packageName: "review-me-plugin",
    sourcePath: "/tmp/review-me-plugin.json",
    sourcePathKind: "file" as const,
  };
  const acknowledgementRequest = {
    targetName: warningParams.packageName,
    targetType: "plugin" as const,
    sourcePathKind: warningParams.sourcePathKind,
    source: { kind: "npm", authority: "third-party", mutable: false, network: true } as const,
    origin: { type: "plugin-npm", packageName: warningParams.packageName },
    request: { kind: "plugin-npm" as const, mode: "install" as const },
    plugin: {
      contentType: "package" as const,
      pluginId: warningParams.packageName,
      packageName: warningParams.packageName,
    },
  };

  it("excludes clone bookkeeping from Git acknowledgement digests", async () => {
    runInstallPolicyMock.mockResolvedValue({ warning: { reason: "review git source" } });

    await preflightPluginGitInstallPolicyRuntime({
      logger: {},
      pluginId: "review-me-plugin",
      source: { kind: "git", authority: "third-party", mutable: true, network: true },
      sourcePath: "/tmp/review-me-plugin",
    });

    expect(digestInstallPolicySourceMock).toHaveBeenCalledOnce();
    const digestParams = digestInstallPolicySourceMock.mock.calls[0]?.[0] as {
      excludeRelativePath?: (relativePath: string) => boolean;
    };
    expect(digestParams.excludeRelativePath?.(".git")).toBe(true);
    expect(digestParams.excludeRelativePath?.("src/.git")).toBe(false);
    expect(digestParams.excludeRelativePath?.("package.json")).toBe(false);
  });

  it("requires acknowledgement and a stable re-evaluation", async () => {
    const warnings: string[] = [];
    const warning = {
      warning: { reason: "review \u001b[31melevated\nbehavior" },
      findings: [{ ruleId: "context", severity: "info", message: "Review\nthe source." }],
    } as const;
    runInstallPolicyMock.mockResolvedValue(warning);
    const result = await preflightPluginNpmInstallPolicyRuntime({
      ...warningParams,
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(result?.blocked?.installPolicyWarning?.reason).toContain("\u001b[31m");
    expect(result?.blocked?.reason).toContain("review elevated\\nbehavior");
    expect(result?.blocked?.reason).not.toContain("\u001b[31m");
    expect(result?.blocked?.reason).not.toContain("--dangerously-force-unsafe-install");
    expect(warnings).toContain("Install policy warning: review elevated\\nbehavior");
    expect(warnings).toContain("Install policy: Review\\nthe source.");
    const acknowledgementId = result?.blocked?.installPolicyWarning?.acknowledgementId;
    expect(acknowledgementId).toMatch(/^sha256:/u);
    await expect(
      preflightPluginNpmInstallPolicyRuntime({
        ...warningParams,
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: acknowledgementId,
      }),
    ).resolves.toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(3);
    runInstallPolicyMock
      .mockResolvedValueOnce({
        warning: warning.warning,
        findings: warning.findings,
      })
      .mockResolvedValueOnce({ warning: { reason: "changed behavior" } });
    const changedAttemptAcknowledgementId = createInstallPolicyWarningAcknowledgementId(
      { reason: warning.warning.reason, findings: [...warning.findings] },
      {
        request: acknowledgementRequest,
        sourceDigest: "sha256:stable-source",
        sourcePath: warningParams.sourcePath,
      },
    );
    const changed = await preflightPluginNpmInstallPolicyRuntime({
      ...warningParams,
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: changedAttemptAcknowledgementId,
    });
    expect(changed?.blocked).toMatchObject({
      installPolicyWarning: { reason: "changed behavior" },
      requiresAcknowledgement: true,
    });
  });

  it("rejects an acknowledgement when the reviewed source has changed", async () => {
    const policyResult = { warning: { reason: "review package behavior" } } as const;
    runInstallPolicyMock.mockResolvedValue(policyResult);
    digestInstallPolicySourceMock.mockResolvedValueOnce("sha256:first-source");

    const first = await preflightPluginNpmInstallPolicyRuntime(warningParams);
    const acknowledgementId = first?.blocked?.installPolicyWarning?.acknowledgementId;
    expect(acknowledgementId).toMatch(/^sha256:/u);

    digestInstallPolicySourceMock.mockResolvedValueOnce("sha256:changed-source");
    const retry = await preflightPluginNpmInstallPolicyRuntime({
      ...warningParams,
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: acknowledgementId,
    });

    expect(retry?.blocked).toMatchObject({
      requiresAcknowledgement: true,
      reason:
        "install policy warning or source changed after review; acknowledge the current warning",
    });
    expect(retry?.blocked?.installPolicyWarning?.acknowledgementId).not.toBe(acknowledgementId);
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("rejects changes hidden beyond warning display limits", async () => {
    const displayed = { warning: { reason: `${"r".repeat(1000)}...` } };
    runInstallPolicyMock.mockResolvedValue({
      ...displayed,
      warningIdentity: { reason: `${"r".repeat(1000)}first` },
    });
    const first = await preflightPluginNpmInstallPolicyRuntime(warningParams);
    const acknowledgementId = first?.blocked?.installPolicyWarning?.acknowledgementId;

    runInstallPolicyMock.mockResolvedValue({
      ...displayed,
      warningIdentity: { reason: `${"r".repeat(1000)}changed` },
    });
    const retry = await preflightPluginNpmInstallPolicyRuntime({
      ...warningParams,
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: acknowledgementId,
    });

    expect(retry?.blocked?.requiresAcknowledgement).toBe(true);
    expect(retry?.blocked?.installPolicyWarning?.acknowledgementId).not.toBe(acknowledgementId);
  });

  it("advances a single acknowledgement through ordered npm policy stages", async () => {
    const warning = { warning: { reason: "review package behavior" } } as const;
    runInstallPolicyMock.mockResolvedValue(warning);
    digestInstallPolicySourceMock.mockImplementation(
      async ({ sourcePath }: { sourcePath: string }) =>
        sourcePath.endsWith("metadata.json") ? "sha256:metadata" : "sha256:package",
    );
    const metadataParams = { ...warningParams, sourcePath: "/tmp/metadata.json" };
    const packageParams = { ...warningParams, sourcePath: "/tmp/package" };

    const first = await preflightPluginNpmInstallPolicyRuntime(metadataParams);
    const firstId = first?.blocked?.installPolicyWarning?.acknowledgementId;
    expect(firstId).toMatch(/^sha256:/u);

    const firstRetry: InstallPolicyAcknowledgementSequence = {
      presentedId: firstId!,
      previousAcknowledgementIds: [],
      matched: false,
    };
    await expect(
      preflightPluginNpmInstallPolicyRuntime({
        ...metadataParams,
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: firstId,
        installPolicyAcknowledgementSequence: firstRetry,
      }),
    ).resolves.toBeUndefined();
    const second = await preflightPluginNpmInstallPolicyRuntime({
      ...packageParams,
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: firstId,
      installPolicyAcknowledgementSequence: firstRetry,
    });
    const secondId = second?.blocked?.installPolicyWarning?.acknowledgementId;
    expect(secondId).toMatch(/^sha256:[^,]+,sha256:/u);
    expect(secondId).not.toBe(firstId);

    const secondRetry: InstallPolicyAcknowledgementSequence = {
      presentedId: secondId!,
      previousAcknowledgementIds: [],
      matched: false,
    };
    await expect(
      preflightPluginNpmInstallPolicyRuntime({
        ...metadataParams,
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: secondId,
        installPolicyAcknowledgementSequence: secondRetry,
      }),
    ).resolves.toBeUndefined();
    expect(secondRetry.previousAcknowledgementIds).toEqual([firstId]);
    expect(secondRetry.matched).toBe(false);
    await expect(
      preflightPluginNpmInstallPolicyRuntime({
        ...packageParams,
        dangerouslyForceUnsafeInstall: true,
        installPolicyAcknowledgementId: secondId,
        installPolicyAcknowledgementSequence: secondRetry,
      }),
    ).resolves.toBeUndefined();
    expect(secondRetry.matched).toBe(true);
    expect(secondRetry.matchedWarning?.acknowledgementId).toBe(secondId);
  });

  it("rejects an unrelated acknowledgement before advancing the policy stage", async () => {
    runInstallPolicyMock.mockResolvedValue({ warning: { reason: "review package behavior" } });
    digestInstallPolicySourceMock.mockResolvedValue("sha256:package");
    const unrelatedId = `sha256:${"f".repeat(64)}`;
    const sequence: InstallPolicyAcknowledgementSequence = {
      presentedId: unrelatedId,
      previousAcknowledgementIds: [],
      matched: false,
    };

    const result = await preflightPluginNpmInstallPolicyRuntime({
      ...warningParams,
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: unrelatedId,
      installPolicyAcknowledgementSequence: sequence,
    });

    expect(result?.blocked).toMatchObject({
      code: "security_scan_blocked",
      requiresAcknowledgement: true,
      reason:
        "install policy warning or source changed after review; acknowledge the current warning",
    });
    expect(sequence.previousAcknowledgementIds).toEqual([]);
    expect(sequence.matched).toBe(false);
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown later stages for a single-stage policy caller", async () => {
    runInstallPolicyMock.mockResolvedValue({ warning: { reason: "review package behavior" } });
    digestInstallPolicySourceMock.mockResolvedValue("sha256:package");
    const first = await preflightPluginNpmInstallPolicyRuntime(warningParams);
    const acknowledgementId = first?.blocked?.installPolicyWarning?.acknowledgementId;
    if (!acknowledgementId) {
      throw new Error("expected acknowledgement id");
    }
    const acknowledgementWithUnknownStage = `${acknowledgementId},sha256:${"f".repeat(64)}`;

    const result = await preflightPluginNpmInstallPolicyRuntime({
      ...warningParams,
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: acknowledgementWithUnknownStage,
    });

    expect(result?.blocked).toMatchObject({
      code: "security_scan_blocked",
      requiresAcknowledgement: true,
      reason: "install policy acknowledgement includes an unknown later warning",
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("retains complete warnings internally and caps the external projection", async () => {
    const findings = Array.from({ length: 100 }, (_, index) => ({
      ruleId: `rule-${index}-${"r".repeat(300)}`,
      severity: "warn" as const,
      message: `finding-${index}-${"m".repeat(1_000)}`,
      evidence: "e".repeat(1_000),
    }));
    runInstallPolicyMock.mockResolvedValue({
      warning: { reason: "Review", omittedFindings: 1 },
      findings,
    });

    const result = await preflightPluginNpmInstallPolicyRuntime(warningParams);
    const internalWarning = result?.blocked?.installPolicyWarning;
    if (!internalWarning) {
      throw new Error("expected an install policy warning");
    }
    const externalWarning = projectInstallPolicyWarningForExternal(internalWarning);

    expect(internalWarning?.findings).toHaveLength(100);
    expect(internalWarning?.findings?.[0]?.message).toHaveLength(1_010);
    expect(externalWarning.findings).toHaveLength(11);
    expect(externalWarning.findings?.[0]?.message).toHaveLength(256);
    expect(externalWarning.findings?.[0]?.message.endsWith("… [truncated]")).toBe(true);
    expect(externalWarning.findings?.at(-1)?.ruleId).toBe("openclaw.policy.findings-truncated");
    expect(externalWarning.findings?.at(-1)?.message).toContain("91 additional findings omitted");
    expect(runInstallPolicyMock).toHaveBeenCalledOnce();
  });

  it("keeps externally returned warning text UTF-16 safe", async () => {
    const splitEmoji = `${"r".repeat(255)}😀`;
    runInstallPolicyMock.mockResolvedValue({
      warning: { reason: splitEmoji },
      findings: [
        {
          ruleId: splitEmoji,
          severity: "warn",
          message: splitEmoji,
          file: splitEmoji,
          evidence: splitEmoji,
        },
      ],
    });

    const result = await preflightPluginNpmInstallPolicyRuntime(warningParams);
    const internalWarning = result?.blocked?.installPolicyWarning;
    if (!internalWarning) {
      throw new Error("expected an install policy warning");
    }
    const warning = projectInstallPolicyWarningForExternal(internalWarning);

    const truncated = `${"r".repeat(243)}… [truncated]`;
    expect(warning?.reason).toBe(truncated);
    expect(warning?.findings?.[0]).toMatchObject({
      ruleId: truncated,
      message: truncated,
      file: truncated,
      evidence: truncated,
    });
  });

  it("binds acknowledgement to full warning semantics but not the exact staging root", () => {
    const firstRoot = "/tmp/openclaw-plugin-a1b2c3/package";
    const repeatedRoot = "/tmp/openclaw-plugin-d4e5f6/package";
    const warningAt = (root: string, suffix: string) => ({
      reason: `Review ${root}: ${"r".repeat(300)}${suffix}`,
      findings: [
        {
          ruleId: "review-package",
          severity: "warn" as const,
          message: `Review ${root}/index.js`,
          file: `${root}/index.js`,
        },
      ],
    });

    const first = createInstallPolicyWarningAcknowledgementId(warningAt(firstRoot, "first"), {
      request: acknowledgementRequest,
      sourceDigest: "sha256:first-source",
      sourcePath: firstRoot,
    });
    const repeated = createInstallPolicyWarningAcknowledgementId(warningAt(repeatedRoot, "first"), {
      request: acknowledgementRequest,
      sourceDigest: "sha256:first-source",
      sourcePath: repeatedRoot,
    });
    const changed = createInstallPolicyWarningAcknowledgementId(
      warningAt(repeatedRoot, "changed"),
      {
        request: acknowledgementRequest,
        sourceDigest: "sha256:first-source",
        sourcePath: repeatedRoot,
      },
    );
    const changedSource = createInstallPolicyWarningAcknowledgementId(
      warningAt(repeatedRoot, "first"),
      {
        request: acknowledgementRequest,
        sourceDigest: "sha256:changed-source",
        sourcePath: repeatedRoot,
      },
    );
    const changedRequest = createInstallPolicyWarningAcknowledgementId(
      warningAt(repeatedRoot, "first"),
      {
        request: { ...acknowledgementRequest, targetName: "different-plugin" },
        sourceDigest: "sha256:first-source",
        sourcePath: repeatedRoot,
      },
    );

    expect(repeated).toBe(first);
    expect(changed).not.toBe(first);
    expect(changedSource).not.toBe(first);
    expect(changedRequest).not.toBe(first);
  });

  it("normalizes equivalent Windows staging paths in acknowledgement warnings", () => {
    const firstRoot = String.raw`C:\Users\Demo User\AppData\Local\Temp\openclaw-a1b2\package`;
    const repeatedRoot = String.raw`C:\Users\Demo User\AppData\Local\Temp\openclaw-d4e5\package`;
    const warningAt = (displayRoot: string) => ({
      reason: `Review ${displayRoot}`,
      findings: [
        {
          ruleId: "review-package",
          severity: "warn" as const,
          message: `Review ${displayRoot}/index.js`,
          file: `${displayRoot}/index.js`,
        },
      ],
    });
    const first = createInstallPolicyWarningAcknowledgementId(
      warningAt("file:///c:/Users/Demo%20User/AppData/Local/Temp/openclaw-a1b2/package"),
      {
        request: acknowledgementRequest,
        sourceDigest: "sha256:first-source",
        sourcePath: firstRoot,
      },
    );
    const repeated = createInstallPolicyWarningAcknowledgementId(
      warningAt("C:/Users/Demo User/AppData/Local/Temp/openclaw-d4e5/package"),
      {
        request: acknowledgementRequest,
        sourceDigest: "sha256:first-source",
        sourcePath: repeatedRoot,
      },
    );

    expect(repeated).toBe(first);
  });

  it("normalizes canonical POSIX staging aliases in acknowledgement warnings", () => {
    const firstRoot = "/tmp/openclaw-a1b2/package";
    const repeatedRoot = "/tmp/openclaw-d4e5/package";
    const firstCanonicalRoot = `/private${firstRoot}`;
    const repeatedCanonicalRoot = `/private${repeatedRoot}`;
    const warningAt = (root: string) => ({
      reason: `Review ${root}`,
      findings: [
        {
          ruleId: "review-package",
          severity: "warn" as const,
          message: `Review ${root}/index.js`,
          file: `${root}/index.js`,
        },
      ],
    });
    const first = createInstallPolicyWarningAcknowledgementId(warningAt(firstCanonicalRoot), {
      request: acknowledgementRequest,
      sourceDigest: "sha256:first-source",
      sourcePath: firstRoot,
      sourcePathAliases: [firstCanonicalRoot],
    });
    const repeated = createInstallPolicyWarningAcknowledgementId(warningAt(repeatedCanonicalRoot), {
      request: acknowledgementRequest,
      sourceDigest: "sha256:first-source",
      sourcePath: repeatedRoot,
      sourcePathAliases: [repeatedCanonicalRoot],
    });

    expect(repeated).toBe(first);
  });

  it("normalizes percent-encoded POSIX staging URLs in acknowledgement warnings", () => {
    const firstRoot = "/tmp/openclaw plugin-a1b2/package";
    const repeatedRoot = "/tmp/openclaw plugin-d4e5/package";
    const warningAt = (encodedRoot: string) => ({
      reason: `Review file://${encodedRoot}`,
      findings: [
        {
          ruleId: "review-package",
          severity: "warn" as const,
          message: `Review file://${encodedRoot}/index.js`,
          file: `file://${encodedRoot}/index.js`,
        },
      ],
    });
    const first = createInstallPolicyWarningAcknowledgementId(
      warningAt("/tmp/openclaw%20plugin-a1b2/package"),
      {
        request: acknowledgementRequest,
        sourceDigest: "sha256:first-source",
        sourcePath: firstRoot,
      },
    );
    const repeated = createInstallPolicyWarningAcknowledgementId(
      warningAt("/tmp/openclaw%20plugin-d4e5/package"),
      {
        request: acknowledgementRequest,
        sourceDigest: "sha256:first-source",
        sourcePath: repeatedRoot,
      },
    );

    expect(repeated).toBe(first);
  });
});

describe("installed dependency tree scan", () => {
  it("accepts a managed host link declared as a runtime dependency", async () => {
    findBlockedManifestDependenciesMock.mockReturnValue([]);
    const npmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-scan-"));
    tempDirs.push(npmRoot);
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.symlink(process.cwd(), hostLink, "junction");

    const result = await scanInstalledPackageDependencyTreeRuntime({
      allowManagedNpmRootPackagePeerSymlinks: true,
      dependencyScanRootDir: npmRoot,
      logger: {},
      packageDir,
      pluginId: "runtime-plugin",
    });

    expect(result).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an openclaw dependency symlink that does not target the trusted host", async () => {
    findBlockedManifestDependenciesMock.mockReturnValue([]);
    const npmRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-scan-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-outside-"));
    tempDirs.push(npmRoot, outsideRoot);
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(outsideRoot, "package.json"), '{"name":"openclaw"}', "utf8");
    await fs.symlink(outsideRoot, hostLink, "junction");

    await expect(
      scanInstalledPackageDependencyTreeRuntime({
        allowManagedNpmRootPackagePeerSymlinks: true,
        dependencyScanRootDir: npmRoot,
        logger: {},
        packageDir,
        pluginId: "runtime-plugin",
      }),
    ).rejects.toThrow("installed dependency scan found package outside install root");
  });
});

describe("legacy file install scan compatibility", () => {
  it("preserves policy and hook metadata for published lazy install chunks", async () => {
    const warnings: string[] = [];
    const hasHooks = vi.fn().mockReturnValue(true);
    const runBeforeInstall = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ hasHooks, runBeforeInstall });
    runInstallPolicyMock.mockResolvedValueOnce({
      findings: [
        {
          ruleId: "registry-review",
          severity: "warn",
          message: "Registry requires review.",
        },
      ],
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      mode: "update",
      pluginId: "payload",
      requestedSpecifier: "./payload.js",
    });

    expect(result).toBeUndefined();
    expect(warnings).toEqual(["Install policy: Registry requires review."]);
    expect(runInstallPolicyMock).toHaveBeenCalledWith({
      config: undefined,
      logger: expect.any(Object),
      request: {
        targetName: "payload",
        targetType: "plugin",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        source: { kind: "file", authority: "user", mutable: true, network: false },
        origin: { type: "plugin-file" },
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
    });
    expect(hasHooks).toHaveBeenCalledWith("before_install");
    expect(runBeforeInstall).toHaveBeenCalledWith(
      {
        targetName: "payload",
        targetType: "plugin",
        origin: "plugin-file",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        builtinScan: {
          status: "ok",
          scannedFiles: 0,
          critical: 0,
          warn: 0,
          info: 0,
          findings: [],
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
      {
        origin: "plugin-file",
        targetType: "plugin",
        requestKind: "plugin-file",
      },
    );
  });

  it("returns operator policy blocks before invoking hooks", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
  });
});
