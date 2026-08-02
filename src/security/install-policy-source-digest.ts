import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../infra/crypto-digest.js";
import { isPathInside } from "./scan-paths.js";

type SourceEntry = {
  path: string;
  type: "directory" | "file" | "symlink";
  mode?: number;
  sha256?: string;
  target?: string;
};

function securityMode(mode: number): number {
  return mode & 0o7777;
}

async function collectSourceEntries(
  root: string,
  rootRealPath: string,
  allowOutOfTreeSymlink?: (params: { relativePath: string; resolvedTargetPath: string }) => boolean,
  excludeRelativePath?: (relativePath: string) => boolean,
  relativeDir = "",
): Promise<SourceEntry[]> {
  const names = (await fs.readdir(path.join(root, relativeDir))).toSorted();
  const entries: SourceEntry[] = [];
  for (const name of names) {
    const relativePath = path.join(relativeDir, name);
    const absolutePath = path.join(root, relativePath);
    const portablePath = relativePath.split(path.sep).join("/");
    if (excludeRelativePath?.(portablePath)) {
      continue;
    }
    const stat = await fs.lstat(absolutePath);
    if (stat.isDirectory()) {
      entries.push({ path: portablePath, type: "directory", mode: securityMode(stat.mode) });
      entries.push(
        ...(await collectSourceEntries(
          root,
          rootRealPath,
          allowOutOfTreeSymlink,
          excludeRelativePath,
          relativePath,
        )),
      );
      continue;
    }
    if (stat.isFile()) {
      entries.push({
        path: portablePath,
        type: "file",
        mode: securityMode(stat.mode),
        sha256: await sha256File(absolutePath),
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      const lexicalTarget = await fs.readlink(absolutePath);
      let resolvedTargetPath: string;
      try {
        resolvedTargetPath = await fs.realpath(absolutePath);
      } catch {
        throw new Error(
          `Install source contains an unresolved symlink ${JSON.stringify(portablePath)}.`,
        );
      }
      if (
        !isPathInside(rootRealPath, resolvedTargetPath) &&
        !allowOutOfTreeSymlink?.({ relativePath: portablePath, resolvedTargetPath })
      ) {
        throw new Error(
          `Install source contains an out-of-tree symlink ${JSON.stringify(portablePath)}.`,
        );
      }
      const target = path.isAbsolute(lexicalTarget)
        ? path.relative(path.dirname(absolutePath), lexicalTarget) || "."
        : path.normalize(lexicalTarget);
      entries.push({
        path: portablePath,
        type: "symlink",
        target: target.split(path.sep).join("/"),
      });
      continue;
    }
    throw new Error(`Install source contains unsupported entry ${JSON.stringify(portablePath)}.`);
  }
  return entries;
}

export async function digestInstallPolicySource(params: {
  sourcePath: string;
  sourcePathKind: "file" | "directory";
  allowOutOfTreeSymlink?: (params: { relativePath: string; resolvedTargetPath: string }) => boolean;
  excludeRelativePath?: (relativePath: string) => boolean;
}): Promise<string> {
  let entries: SourceEntry[];
  if (params.sourcePathKind === "file") {
    const stat = await fs.lstat(params.sourcePath);
    if (!stat.isFile()) {
      throw new Error("Install policy file source is not a regular file.");
    }
    entries = [
      {
        path: "<source>",
        type: "file",
        mode: securityMode(stat.mode),
        sha256: await sha256File(params.sourcePath),
      },
    ];
  } else {
    const stat = await fs.stat(params.sourcePath);
    if (!stat.isDirectory()) {
      throw new Error("Install policy directory source is not a directory.");
    }
    entries = [
      { path: "<source>", type: "directory", mode: securityMode(stat.mode) },
      ...(await collectSourceEntries(
        params.sourcePath,
        await fs.realpath(params.sourcePath),
        params.allowOutOfTreeSymlink,
        params.excludeRelativePath,
      )),
    ];
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}
