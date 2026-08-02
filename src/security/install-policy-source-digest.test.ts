import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestInstallPolicySource } from "./install-policy-source-digest.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function sourceTree(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested", "index.js"), "export const value = 1;\n");
  await fs.symlink("nested/index.js", path.join(root, "entry.js"));
  return root;
}

describe("digestInstallPolicySource", () => {
  it("ignores the staging root name but binds paths, bytes, and symlink targets", async () => {
    const first = await sourceTree("openclaw-policy-first-");
    const repeated = await sourceTree("openclaw-policy-repeated-");

    const firstDigest = await digestInstallPolicySource({
      sourcePath: first,
      sourcePathKind: "directory",
    });
    const repeatedDigest = await digestInstallPolicySource({
      sourcePath: repeated,
      sourcePathKind: "directory",
    });
    expect(repeatedDigest).toBe(firstDigest);

    await fs.writeFile(path.join(repeated, "nested", "index.js"), "export const value = 2;\n");
    await expect(
      digestInstallPolicySource({ sourcePath: repeated, sourcePathKind: "directory" }),
    ).resolves.not.toBe(firstDigest);
  });

  it.runIf(process.platform !== "win32")(
    "normalizes absolute and relative in-tree symlinks to the same source identity",
    async () => {
      const absolute = await sourceTree("openclaw-policy-absolute-link-");
      const relative = await sourceTree("openclaw-policy-relative-link-");
      await fs.rm(path.join(absolute, "entry.js"));
      await fs.symlink(path.join(absolute, "nested", "index.js"), path.join(absolute, "entry.js"));

      await expect(
        digestInstallPolicySource({ sourcePath: absolute, sourcePathKind: "directory" }),
      ).resolves.toBe(
        await digestInstallPolicySource({ sourcePath: relative, sourcePathKind: "directory" }),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "binds the normalized lexical target when two symlinks resolve to the same file",
    async () => {
      const root = await sourceTree("openclaw-policy-link-alias-");
      await fs.symlink("nested/index.js", path.join(root, "alias.js"));
      await fs.symlink("entry.js", path.join(root, "main.js"));
      const initialDigest = await digestInstallPolicySource({
        sourcePath: root,
        sourcePathKind: "directory",
      });

      await fs.rm(path.join(root, "main.js"));
      await fs.symlink("alias.js", path.join(root, "main.js"));

      await expect(
        digestInstallPolicySource({ sourcePath: root, sourcePathKind: "directory" }),
      ).resolves.not.toBe(initialDigest);
    },
  );

  it("can exclude transient Git metadata while binding repository content", async () => {
    const first = await sourceTree("openclaw-policy-git-first-");
    const repeated = await sourceTree("openclaw-policy-git-repeated-");
    await fs.mkdir(path.join(first, ".git"));
    await fs.mkdir(path.join(repeated, ".git"));
    await fs.writeFile(path.join(first, ".git", "index"), "first checkout metadata\n");
    await fs.writeFile(path.join(repeated, ".git", "index"), "repeated checkout metadata\n");
    const excludeGitMetadata = (relativePath: string) => relativePath === ".git";

    const firstDigest = await digestInstallPolicySource({
      sourcePath: first,
      sourcePathKind: "directory",
      excludeRelativePath: excludeGitMetadata,
    });
    await expect(
      digestInstallPolicySource({
        sourcePath: repeated,
        sourcePathKind: "directory",
        excludeRelativePath: excludeGitMetadata,
      }),
    ).resolves.toBe(firstDigest);

    await fs.writeFile(path.join(repeated, "nested", "index.js"), "export const value = 2;\n");
    await expect(
      digestInstallPolicySource({
        sourcePath: repeated,
        sourcePathKind: "directory",
        excludeRelativePath: excludeGitMetadata,
      }),
    ).resolves.not.toBe(firstDigest);
  });

  it.runIf(process.platform !== "win32")(
    "binds executable permissions and rejects symlinks outside the source tree",
    async () => {
      const root = await sourceTree("openclaw-policy-permissions-");
      const file = path.join(root, "nested", "index.js");
      const initialDigest = await digestInstallPolicySource({
        sourcePath: root,
        sourcePathKind: "directory",
      });

      await fs.chmod(file, 0o755);
      await expect(
        digestInstallPolicySource({ sourcePath: root, sourcePathKind: "directory" }),
      ).resolves.not.toBe(initialDigest);

      const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-external-"));
      tempDirs.push(externalRoot);
      const externalFile = path.join(externalRoot, "outside.js");
      await fs.writeFile(externalFile, "export const outside = true;\n");
      await fs.symlink(externalFile, path.join(root, "outside.js"));
      await expect(
        digestInstallPolicySource({ sourcePath: root, sourcePathKind: "directory" }),
      ).rejects.toThrow("out-of-tree symlink");
    },
  );

  it.runIf(process.platform !== "win32")("binds the source directory permissions", async () => {
    const root = await sourceTree("openclaw-policy-root-permissions-");
    const initialDigest = await digestInstallPolicySource({
      sourcePath: root,
      sourcePathKind: "directory",
    });

    await fs.chmod(root, 0o777);

    await expect(
      digestInstallPolicySource({ sourcePath: root, sourcePathKind: "directory" }),
    ).resolves.not.toBe(initialDigest);
  });

  it.runIf(process.platform !== "win32")(
    "binds an explicitly trusted external symlink target without traversing it",
    async () => {
      const root = await sourceTree("openclaw-policy-trusted-link-");
      const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-host-"));
      tempDirs.push(externalRoot);
      const externalRealPath = await fs.realpath(externalRoot);
      await fs.writeFile(path.join(externalRoot, "package.json"), '{"name":"openclaw"}\n');
      const link = path.join(root, "node_modules", "openclaw");
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(externalRoot, link);

      const digest = await digestInstallPolicySource({
        sourcePath: root,
        sourcePathKind: "directory",
        allowOutOfTreeSymlink: ({ relativePath, resolvedTargetPath }) =>
          relativePath === "node_modules/openclaw" && resolvedTargetPath === externalRealPath,
      });
      expect(digest).toMatch(/^sha256:/u);

      await fs.rm(link);
      await fs.symlink(path.join(externalRoot, "package.json"), link);
      await expect(
        digestInstallPolicySource({
          sourcePath: root,
          sourcePathKind: "directory",
          allowOutOfTreeSymlink: ({ relativePath, resolvedTargetPath }) =>
            relativePath === "node_modules/openclaw" && resolvedTargetPath === externalRealPath,
        }),
      ).rejects.toThrow("out-of-tree symlink");
    },
  );
});
