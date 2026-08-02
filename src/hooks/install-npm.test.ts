import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectSingleNpmPackIgnoreScriptsCall } from "../test-utils/exec-assertions.js";
import {
  expectIntegrityDriftRejected,
  expectUnsupportedNpmSpec,
  mockNpmPackMetadataResult,
} from "../test-utils/npm-spec-install-test-helpers.js";

const runCommandWithTimeoutMock = vi.fn();
const scanPackageInstallSourceMock = vi.fn();
const scanInstalledPackageDependencyTreeMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../plugins/install-security-scan.js", () => ({
  scanPackageInstallSource: (...args: unknown[]) => scanPackageInstallSourceMock(...args),
  scanInstalledPackageDependencyTree: (...args: unknown[]) =>
    scanInstalledPackageDependencyTreeMock(...args),
}));

vi.resetModules();

const { installHooksFromNpmSpec } = await import("./install.js");
const hookInstallRuntime = await import("./install.runtime.js");

const fixtureRoot = path.join(process.cwd(), ".tmp", `openclaw-hook-npm-${randomUUID()}`);
let tempDirIndex = 0;

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function createNpmPackHooksBuffer(): Promise<Buffer> {
  const workDir = path.join(fixtureRoot, "pack-fixture");
  const packageDir = path.join(workDir, "package");
  const hookDir = path.join(packageDir, "hooks", "one-hook");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/test-hooks",
      version: "0.0.1",
      openclaw: { hooks: ["./hooks/one-hook"] },
    }),
  );
  fs.writeFileSync(
    path.join(hookDir, "HOOK.md"),
    [
      "---",
      "name: one-hook",
      "description: One hook",
      'metadata: {"openclaw":{"events":["command:new"]}}',
      "---",
      "",
      "# One Hook",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(hookDir, "handler.ts"), "export default async () => {};\n");
  const archivePath = path.join(workDir, "pack.tgz");
  await tar.c({ cwd: workDir, file: archivePath, gzip: true }, ["package"]);
  return fs.readFileSync(archivePath);
}

fs.mkdirSync(fixtureRoot, { recursive: true });
const npmPackHooksBuffer = await createNpmPackHooksBuffer();

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  runCommandWithTimeoutMock.mockReset();
  scanPackageInstallSourceMock.mockReset();
  scanPackageInstallSourceMock.mockResolvedValue(undefined);
  scanInstalledPackageDependencyTreeMock.mockReset();
  scanInstalledPackageDependencyTreeMock.mockResolvedValue(undefined);
});

describe("installHooksFromNpmSpec", () => {
  it("forwards npm install policy metadata through extracted archive validation", async () => {
    const installFromValidatedNpmSpecArchiveSpy = vi
      .spyOn(hookInstallRuntime, "installFromValidatedNpmSpecArchive")
      .mockImplementation(
        async (
          params: Parameters<typeof hookInstallRuntime.installFromValidatedNpmSpecArchive>[0],
        ) => {
          expect(
            (params.archiveInstallParams as Record<string, unknown>).dangerouslyForceUnsafeInstall,
          ).toBeUndefined();
          expect(params.archiveInstallParams).toEqual(
            expect.objectContaining({
              installPolicyRequest: {
                kind: "plugin-npm",
                requestedSpecifier: "@openclaw/test-hooks@0.0.1",
                source: {
                  kind: "npm",
                  authority: "third-party",
                  mutable: false,
                  network: true,
                },
              },
            }),
          );
          return {
            ok: true,
            hookPackId: "test-hooks",
            hooks: ["one-hook"],
            targetDir: "/tmp/hooks/test-hooks",
            version: "0.0.1",
          };
        },
      );

    try {
      const result = await installHooksFromNpmSpec({
        spec: "@openclaw/test-hooks@0.0.1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.hookPackId).toBe("test-hooks");
    } finally {
      installFromValidatedNpmSpecArchiveSpy.mockRestore();
    }
  });

  it("uses --ignore-scripts for npm pack and cleans up temp dir", async () => {
    const stateDir = makeTempDir();
    let packTmpDir = "";
    const packedName = "test-hooks-0.0.1.tgz";
    runCommandWithTimeoutMock.mockImplementation(async (argv, opts) => {
      if (argv[0] === "npm" && argv[1] === "pack") {
        packTmpDir = typeof opts === "number" ? "" : (opts.cwd ?? "");
        fs.writeFileSync(path.join(packTmpDir, packedName), npmPackHooksBuffer);
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "@openclaw/test-hooks@0.0.1",
              name: "@openclaw/test-hooks",
              version: "0.0.1",
              filename: packedName,
              integrity: "sha512-hook-test",
              shasum: "hookshasum",
            },
          ]),
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      hooksDir: path.join(stateDir, "hooks"),
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hookPackId).toBe("test-hooks");
    expect(result.packageKind).toBe("hook-only");
    expect(result.npmResolution?.resolvedSpec).toBe("@openclaw/test-hooks@0.0.1");
    expect(result.npmResolution?.integrity).toBe("sha512-hook-test");
    expect(fs.existsSync(path.join(result.targetDir, "hooks", "one-hook", "HOOK.md"))).toBe(true);
    expectSingleNpmPackIgnoreScriptsCall({
      calls: runCommandWithTimeoutMock.mock.calls as Array<[unknown, unknown]>,
      expectedSpec: "@openclaw/test-hooks@0.0.1",
    });
    expect(packTmpDir).not.toBe("");
    expect(fs.existsSync(packTmpDir)).toBe(false);
  });

  it("aborts when integrity drift callback rejects the fetched artifact", async () => {
    mockNpmPackMetadataResult(runCommandWithTimeoutMock, {
      id: "@openclaw/test-hooks@0.0.1",
      name: "@openclaw/test-hooks",
      version: "0.0.1",
      filename: "test-hooks-0.0.1.tgz",
      integrity: "sha512-new",
      shasum: "newshasum",
    });

    const onIntegrityDrift = vi.fn(async () => false);
    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks@0.0.1",
      expectedIntegrity: "sha512-old",
      onIntegrityDrift,
    });
    expectIntegrityDriftRejected({
      onIntegrityDrift,
      result,
      expectedIntegrity: "sha512-old",
      actualIntegrity: "sha512-new",
    });
  });

  it("rejects invalid npm spec shapes", async () => {
    await expectUnsupportedNpmSpec((spec) => installHooksFromNpmSpec({ spec }));

    mockNpmPackMetadataResult(runCommandWithTimeoutMock, {
      id: "@openclaw/test-hooks@0.0.2-beta.1",
      name: "@openclaw/test-hooks",
      version: "0.0.2-beta.1",
      filename: "test-hooks-0.0.2-beta.1.tgz",
      integrity: "sha512-beta",
      shasum: "betashasum",
    });

    const result = await installHooksFromNpmSpec({
      spec: "@openclaw/test-hooks",
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("prerelease version 0.0.2-beta.1");
      expect(result.error).toContain('"@openclaw/test-hooks@beta"');
    }
  });
});
