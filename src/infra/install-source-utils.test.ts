// Covers npm install source packing and archive path resolution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  packNpmSpecToArchive,
  resolveArchiveSourcePath,
  resolveNpmPackArchiveMetadata,
  resolveNpmSpecMetadata,
  withInstallSourceSnapshot,
  withTempDir,
} from "./install-source-utils.js";

const execFileSyncMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"));
const runCommandWithTimeoutMock = vi.fn();
const TEMP_DIR_PREFIX = "openclaw-install-source-utils-";
const tempDirs = createTrackedTempDirs();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

async function createTempDir(prefix: string) {
  return await tempDirs.make(prefix);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const statError = error as NodeJS.ErrnoException;
    expect({
      code: statError.code,
      path: statError.path,
      syscall: statError.syscall,
    }).toEqual({
      code: "ENOENT",
      path: targetPath,
      syscall: "stat",
    });
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

async function createFixtureDir() {
  return await createTempDir(TEMP_DIR_PREFIX);
}

async function createFixtureFile(params: {
  fileName: string;
  contents: string;
  dir?: string;
}): Promise<{ dir: string; filePath: string }> {
  const dir = params.dir ?? (await createFixtureDir());
  const filePath = path.join(dir, params.fileName);
  await fs.writeFile(filePath, params.contents, "utf-8");
  return { dir, filePath };
}

function mockPackCommandResult(params: { stdout: string; stderr?: string; code?: number }) {
  runCommandWithTimeoutMock.mockResolvedValue({
    stdout: params.stdout,
    stderr: params.stderr ?? "",
    code: params.code ?? 0,
    signal: null,
    killed: false,
  });
}

async function runPack(spec: string, cwd: string, timeoutMs = 1000) {
  return await packNpmSpecToArchive({
    spec,
    timeoutMs,
    cwd,
  });
}

async function expectPackFallsBackToDetectedArchive(params: {
  stdout: string;
  expectedMetadata?: Record<string, unknown>;
}) {
  const cwd = await createTempDir("openclaw-install-source-utils-");
  const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
  await fs.writeFile(archivePath, "", "utf-8");
  runCommandWithTimeoutMock.mockResolvedValue({
    stdout: params.stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  });

  const result = await packNpmSpecToArchive({
    spec: "openclaw-plugin@1.2.3",
    timeoutMs: 5000,
    cwd,
  });

  expect(result).toEqual({
    ok: true,
    archivePath,
    metadata: params.expectedMetadata ?? {},
  });
}

function expectPackError(result: { ok: boolean; error?: string }, expected: string[]): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  for (const part of expected) {
    expect(result.error ?? "").toContain(part);
  }
}

beforeEach(() => {
  execFileSyncMock.mockClear();
  runCommandWithTimeoutMock.mockClear();
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("withTempDir", () => {
  it("creates a temp dir and always removes it after callback", async () => {
    let observedDir = "";
    const markerFile = "marker.txt";

    const value = await withTempDir("openclaw-install-source-utils-", async (tmpDir) => {
      observedDir = tmpDir;
      await fs.writeFile(path.join(tmpDir, markerFile), "ok", "utf-8");
      await expect(fs.readFile(path.join(tmpDir, markerFile), "utf8")).resolves.toBe("ok");
      return "done";
    });

    expect(value).toBe("done");
    await expectPathMissing(observedDir);
  });
});

describe("withInstallSourceSnapshot", () => {
  it.runIf(process.platform !== "win32")(
    "copies hardlinked source files into a detached snapshot",
    async () => {
      const sourceDir = await createFixtureDir();
      const sourcePath = path.join(sourceDir, "source.txt");
      const aliasPath = path.join(sourceDir, "alias.txt");
      await fs.writeFile(sourcePath, "reviewed", "utf-8");
      await fs.link(sourcePath, aliasPath);

      await withInstallSourceSnapshot({
        sourceDir,
        prefix: "openclaw-install-source-snapshot-",
        run: async (snapshotDir) => {
          const snapshotSourcePath = path.join(snapshotDir, "source.txt");
          const snapshotAliasPath = path.join(snapshotDir, "alias.txt");
          expect((await fs.lstat(snapshotSourcePath)).nlink).toBe(1);
          expect((await fs.lstat(snapshotAliasPath)).nlink).toBe(1);

          await fs.writeFile(sourcePath, "changed", "utf-8");

          await expect(fs.readFile(snapshotSourcePath, "utf-8")).resolves.toBe("reviewed");
          await expect(fs.readFile(snapshotAliasPath, "utf-8")).resolves.toBe("reviewed");
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "copies a symlinked root and retargets absolute in-tree links into the snapshot",
    async () => {
      const fixtureDir = await createFixtureDir();
      const sourceDir = path.join(fixtureDir, "source");
      const linkedSourceDir = path.join(fixtureDir, "source-link");
      const nestedDir = path.join(sourceDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(nestedDir, "entry.js"), "reviewed", "utf-8");
      await fs.symlink(path.join(nestedDir, "entry.js"), path.join(sourceDir, "entry.js"));
      await fs.symlink(sourceDir, linkedSourceDir);
      await fs.chmod(sourceDir, 0o750);
      await fs.chmod(nestedDir, 0o710);

      await withInstallSourceSnapshot({
        sourceDir: linkedSourceDir,
        prefix: "openclaw-install-source-snapshot-",
        run: async (snapshotDir) => {
          const snapshotEntryPath = path.join(snapshotDir, "entry.js");
          expect((await fs.lstat(snapshotDir)).isDirectory()).toBe(true);
          expect((await fs.stat(snapshotDir)).mode & 0o7777).toBe(0o750);
          expect((await fs.stat(path.join(snapshotDir, "nested"))).mode & 0o7777).toBe(0o710);
          expect(await fs.readlink(snapshotEntryPath)).toBe(path.join("nested", "entry.js"));

          await fs.writeFile(path.join(nestedDir, "entry.js"), "changed", "utf-8");

          await expect(fs.readFile(snapshotEntryPath, "utf-8")).resolves.toBe("reviewed");
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps absolute external links outside the snapshot",
    async () => {
      const fixtureDir = await createFixtureDir();
      const sourceDir = path.join(fixtureDir, "source");
      const externalPath = path.join(fixtureDir, "external.js");
      await fs.mkdir(sourceDir);
      await fs.writeFile(externalPath, "external", "utf-8");
      await fs.symlink(externalPath, path.join(sourceDir, "external.js"));

      await withInstallSourceSnapshot({
        sourceDir,
        prefix: "openclaw-install-source-snapshot-",
        run: async (snapshotDir) => {
          expect(await fs.readlink(path.join(snapshotDir, "external.js"))).toBe(externalPath);
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves the original target of relative external links",
    async () => {
      const fixtureDir = await createFixtureDir();
      const sourceDir = path.join(fixtureDir, "repo", "extensions", "demo");
      const linkPath = path.join(sourceDir, "node_modules", "openclaw");
      const hostRoot = path.join(fixtureDir, "repo");
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.writeFile(path.join(hostRoot, "package.json"), "{}", "utf-8");
      await fs.symlink("../../..", linkPath);
      const canonicalHostRoot = await fs.realpath(hostRoot);

      await withInstallSourceSnapshot({
        sourceDir,
        prefix: "openclaw-install-source-snapshot-",
        run: async (snapshotDir) => {
          const snapshotLink = path.join(snapshotDir, "node_modules", "openclaw");
          expect(await fs.readlink(snapshotLink)).toBe(canonicalHostRoot);
          expect(await fs.realpath(snapshotLink)).toBe(canonicalHostRoot);
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves dangling and cyclic relative symlinks without resolving them",
    async () => {
      const sourceDir = await createFixtureDir();
      await fs.symlink("missing.js", path.join(sourceDir, "dangling.js"));
      await fs.symlink("cycle-b.js", path.join(sourceDir, "cycle-a.js"));
      await fs.symlink("cycle-a.js", path.join(sourceDir, "cycle-b.js"));

      await withInstallSourceSnapshot({
        sourceDir,
        prefix: "openclaw-install-source-snapshot-",
        run: async (snapshotDir) => {
          await expect(fs.readlink(path.join(snapshotDir, "dangling.js"))).resolves.toBe(
            "missing.js",
          );
          await expect(fs.readlink(path.join(snapshotDir, "cycle-a.js"))).resolves.toBe(
            "cycle-b.js",
          );
          await expect(fs.readlink(path.join(snapshotDir, "cycle-b.js"))).resolves.toBe(
            "cycle-a.js",
          );
        },
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "restores owner access before cleaning a read-only source snapshot",
    async () => {
      const sourceDir = await createFixtureDir();
      const nestedDir = path.join(sourceDir, "nested");
      await fs.mkdir(nestedDir);
      await fs.writeFile(path.join(nestedDir, "entry.js"), "reviewed", "utf-8");
      await fs.chmod(nestedDir, 0o555);
      await fs.chmod(sourceDir, 0o555);
      let observedSnapshotDir = "";

      try {
        await withInstallSourceSnapshot({
          sourceDir,
          prefix: "openclaw-install-source-snapshot-",
          run: async (snapshotDir) => {
            observedSnapshotDir = snapshotDir;
            expect((await fs.stat(snapshotDir)).mode & 0o7777).toBe(0o555);
            expect((await fs.stat(path.join(snapshotDir, "nested"))).mode & 0o7777).toBe(0o555);
          },
        });
        await expectPathMissing(observedSnapshotDir);
      } finally {
        await fs.chmod(sourceDir, 0o700);
        await fs.chmod(nestedDir, 0o700);
      }
    },
  );
});

describe("resolveArchiveSourcePath", () => {
  it.each([
    {
      name: "returns not found error for missing archive paths",
      path: async () => "/tmp/does-not-exist-openclaw-archive.tgz",
      expected: "archive not found",
    },
    {
      name: "rejects unsupported archive extensions",
      path: async () =>
        (
          await createFixtureFile({
            fileName: "plugin.txt",
            contents: "not-an-archive",
          })
        ).filePath,
      expected: "unsupported archive",
    },
  ])("$name", async ({ path: resolvePath, expected }) => {
    expectPackError(await resolveArchiveSourcePath(await resolvePath()), [expected]);
  });

  it.each(["plugin.zip", "plugin.tgz", "plugin.tar.gz"])(
    "accepts supported archive extension %s",
    async (fileName) => {
      const { filePath } = await createFixtureFile({
        fileName,
        contents: "",
      });

      const result = await resolveArchiveSourcePath(filePath);
      expect(result).toEqual({ ok: true, path: filePath });
    },
  );
});

describe("resolveNpmSpecMetadata", () => {
  const npmViewMetadata = {
    name: "@openclaw/codex",
    version: "2026.6.11",
    "dist.integrity": "placeholder",
    "dist.shasum": "placeholder",
    openclaw: {
      extensions: ["./index.ts"],
    },
  };

  it.each([
    { npmVersion: "11", stdout: JSON.stringify(npmViewMetadata) },
    { npmVersion: "12", stdout: JSON.stringify([npmViewMetadata]) },
  ])("normalizes npm $npmVersion view JSON", async ({ stdout }) => {
    mockPackCommandResult({ stdout });

    const result = await resolveNpmSpecMetadata({ spec: "@openclaw/codex" });

    expect(result).toEqual({
      ok: true,
      metadata: {
        name: "@openclaw/codex",
        version: "2026.6.11",
        resolvedSpec: "@openclaw/codex@2026.6.11",
        integrity: "placeholder",
        shasum: "placeholder",
        packageOpenClaw: {
          extensions: ["./index.ts"],
        },
      },
    });
  });

  it("selects the newest multi-version entry satisfying the requested range", async () => {
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          ...npmViewMetadata,
          version: "2026.5.9",
          "dist.integrity": "older-placeholder",
        },
        npmViewMetadata,
        {
          ...npmViewMetadata,
          version: "2026.6.12",
          "dist.integrity": "newer-placeholder",
        },
        {
          ...npmViewMetadata,
          version: "2026.7.0-beta.1",
          "dist.integrity": "prerelease-placeholder",
        },
      ]),
    });

    await expect(resolveNpmSpecMetadata({ spec: "@openclaw/codex@^2026.6.0" })).resolves.toEqual({
      ok: true,
      metadata: expect.objectContaining({
        version: "2026.6.12",
        integrity: "newer-placeholder",
      }),
    });
  });

  it("prefers the max satisfying version over publication order", async () => {
    // npm view arrays follow publication order: a backport published after a
    // higher release must not win range resolution.
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          ...npmViewMetadata,
          version: "2026.6.12",
          "dist.integrity": "newer-placeholder",
        },
        {
          ...npmViewMetadata,
          version: "2026.6.9",
          "dist.integrity": "backport-placeholder",
        },
      ]),
    });

    await expect(resolveNpmSpecMetadata({ spec: "@openclaw/codex@^2026.6.0" })).resolves.toEqual({
      ok: true,
      metadata: expect.objectContaining({
        version: "2026.6.12",
        integrity: "newer-placeholder",
      }),
    });
  });

  it("fails when no multi-version entry satisfies the requested range", async () => {
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          ...npmViewMetadata,
          version: "2025.1.0",
          "dist.integrity": "older-placeholder",
        },
      ]),
    });

    await expect(resolveNpmSpecMetadata({ spec: "@openclaw/codex@^2026.6.0" })).resolves.toEqual({
      ok: false,
      error: "npm view produced incomplete package metadata (missing: name, version)",
      category: "metadata-env",
    });
  });

  it("uses the last multi-version entry when the selector is not a semver range", async () => {
    mockPackCommandResult({
      stdout: JSON.stringify([npmViewMetadata, { ...npmViewMetadata, version: "2026.6.12" }]),
    });

    const result = await resolveNpmSpecMetadata({ spec: "@openclaw/codex@latest" });

    expect(result).toEqual({
      ok: true,
      metadata: expect.objectContaining({ version: "2026.6.12" }),
    });
  });

  it("normalizes nested dist metadata", async () => {
    mockPackCommandResult({
      stdout: JSON.stringify({
        name: "@openclaw/codex",
        version: "2026.6.11",
        dist: { integrity: "nested-placeholder", shasum: "nested-placeholder" },
      }),
    });

    const result = await resolveNpmSpecMetadata({ spec: "@openclaw/codex" });

    expect(result).toEqual({
      ok: true,
      metadata: {
        name: "@openclaw/codex",
        version: "2026.6.11",
        resolvedSpec: "@openclaw/codex@2026.6.11",
        integrity: "nested-placeholder",
        shasum: "nested-placeholder",
      },
    });
  });

  it("accepts metadata without an openclaw block", async () => {
    const { openclaw: _openclaw, ...withoutOpenClaw } = npmViewMetadata;
    mockPackCommandResult({ stdout: JSON.stringify(withoutOpenClaw) });

    const result = await resolveNpmSpecMetadata({ spec: "@openclaw/codex" });

    expect(result).toEqual({
      ok: true,
      metadata: {
        name: "@openclaw/codex",
        version: "2026.6.11",
        resolvedSpec: "@openclaw/codex@2026.6.11",
        integrity: "placeholder",
        shasum: "placeholder",
      },
    });
  });

  it("reports which required metadata fields are missing", async () => {
    mockPackCommandResult({ stdout: JSON.stringify({ version: "2026.6.11" }) });

    await expect(resolveNpmSpecMetadata({ spec: "@openclaw/codex" })).resolves.toEqual({
      ok: false,
      error: "npm view produced incomplete package metadata (missing: name)",
      category: "metadata-env",
    });
  });
});

describe("packNpmSpecToArchive", () => {
  it("packs spec and returns archive path using JSON output metadata", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          id: "openclaw-plugin@1.2.3",
          name: "openclaw-plugin",
          version: "1.2.3",
          filename: "openclaw-plugin-1.2.3.tgz",
          integrity: "sha512-test-integrity",
          shasum: "abc123",
        },
      ]),
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath,
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["npm", "pack", "openclaw-plugin@1.2.3", "--ignore-scripts", "--json"],
      {
        cwd,
        timeoutMs: 300_000,
        env: {
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          NPM_CONFIG_BEFORE: "",
          NPM_CONFIG_MIN_RELEASE_AGE: "",
          "NPM_CONFIG_MIN-RELEASE-AGE": "",
          npm_config_before: "",
          "npm_config_min-release-age": "",
          npm_config_min_release_age: "0",
        },
      },
    );
  });

  it("unpacks npm 12 name-keyed pack json output", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: JSON.stringify({
        "openclaw-plugin": {
          id: "openclaw-plugin@1.2.3",
          name: "openclaw-plugin",
          version: "1.2.3",
          filename: "openclaw-plugin-1.2.3.tgz",
          integrity: "sha512-test-integrity",
          shasum: "abc123",
        },
      }),
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath,
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
  });

  it("falls back to parsing final stdout line when npm json output is unavailable", async () => {
    const cwd = await createFixtureDir();
    const expectedArchivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(expectedArchivePath, "", "utf-8");
    mockPackCommandResult({
      stdout: "npm notice created package\nopenclaw-plugin-1.2.3.tgz\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd);

    expect(result).toEqual({
      ok: true,
      archivePath: expectedArchivePath,
      metadata: {},
    });
  });

  it("returns npm pack error details when command fails", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "fallback stdout",
      stderr: "registry timeout",
      code: 1,
    });

    const result = await runPack("bad-spec", cwd, 5000);
    expectPackError(result, ["npm pack failed", "registry timeout"]);
  });

  it.each([
    {
      name: "falls back to archive detected in cwd when npm pack stdout is empty",
      stdout: " \n\n",
    },
    {
      name: "falls back to archive detected in cwd when stdout does not contain a tgz",
      stdout: "npm pack completed successfully\n",
    },
    {
      name: "falls back to cwd archive when logged JSON metadata omits filename",
      stdout:
        'npm notice using cache\n[{"id":"openclaw-plugin@1.2.3","name":"openclaw-plugin","version":"1.2.3","integrity":"sha512-test-integrity","shasum":"abc123"}]\n',
      expectedMetadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    },
  ])("$name", async ({ stdout, expectedMetadata }) => {
    await expectPackFallsBackToDetectedArchive({ stdout, expectedMetadata });
  });

  it("returns friendly error for 404 (package not on npm)", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "",
      stderr: "npm error code E404\nnpm error 404  '@openclaw/whatsapp@*' is not in this registry.",
      code: 1,
    });

    const result = await runPack("@openclaw/whatsapp", cwd);
    expectPackError(result, [
      "Package not found on npm",
      "@openclaw/whatsapp",
      "docs.openclaw.ai/tools/plugin",
    ]);
  });

  it("returns explicit error when npm pack produces no archive name", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: " \n\n",
    });

    const result = await runPack("openclaw-plugin@1.2.3", cwd, 5000);

    expect(result).toEqual({
      ok: false,
      error: "npm pack produced no archive",
    });
  });

  it("parses scoped metadata from id-only json output even with npm notice prefix", async () => {
    const cwd = await createFixtureDir();
    await fs.writeFile(path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"), "", "utf-8");
    mockPackCommandResult({
      stdout:
        "npm notice creating package\n" +
        JSON.stringify([
          {
            id: "@openclaw/plugin-demo@2.0.0",
            filename: "openclaw-plugin-demo-2.0.0.tgz",
          },
        ]),
    });

    const result = await runPack("@openclaw/plugin-demo@2.0.0", cwd);
    expect(result).toEqual({
      ok: true,
      archivePath: path.join(cwd, "openclaw-plugin-demo-2.0.0.tgz"),
      metadata: {
        resolvedSpec: "@openclaw/plugin-demo@2.0.0",
      },
    });
  });

  it("uses stdout fallback error text when stderr is empty", async () => {
    const cwd = await createFixtureDir();
    mockPackCommandResult({
      stdout: "network timeout",
      stderr: " ",
      code: 1,
    });

    const result = await runPack("bad-spec", cwd);
    expect(result).toEqual({
      ok: false,
      error: "npm pack failed: network timeout",
    });
  });
});

describe("resolveNpmPackArchiveMetadata", () => {
  it("reads archive metadata from npm <=11 array pack output", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "tar-bytes", "utf-8");
    mockPackCommandResult({
      stdout: JSON.stringify([
        {
          id: "openclaw-plugin@1.2.3",
          name: "openclaw-plugin",
          version: "1.2.3",
          filename: "openclaw-plugin-1.2.3.tgz",
          integrity: "sha512-test-integrity",
          shasum: "abc123",
        },
      ]),
    });

    const result = await resolveNpmPackArchiveMetadata({ archivePath, timeoutMs: 1000 });

    expect(result).toEqual({
      ok: true,
      archivePath,
      tarballName: "openclaw-plugin-1.2.3.tgz",
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
  });

  it("reads archive metadata from npm 12 name-keyed pack output", async () => {
    const cwd = await createFixtureDir();
    const archivePath = path.join(cwd, "openclaw-plugin-1.2.3.tgz");
    await fs.writeFile(archivePath, "tar-bytes", "utf-8");
    mockPackCommandResult({
      stdout: JSON.stringify({
        "openclaw-plugin": {
          id: "openclaw-plugin@1.2.3",
          name: "openclaw-plugin",
          version: "1.2.3",
          filename: "openclaw-plugin-1.2.3.tgz",
          integrity: "sha512-test-integrity",
          shasum: "abc123",
        },
      }),
    });

    const result = await resolveNpmPackArchiveMetadata({ archivePath, timeoutMs: 1000 });

    expect(result).toEqual({
      ok: true,
      archivePath,
      tarballName: "openclaw-plugin-1.2.3.tgz",
      metadata: {
        name: "openclaw-plugin",
        version: "1.2.3",
        resolvedSpec: "openclaw-plugin@1.2.3",
        integrity: "sha512-test-integrity",
        shasum: "abc123",
      },
    });
  });
});
