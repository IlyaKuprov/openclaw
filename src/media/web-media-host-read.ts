// Host-local reads validate declared text and exact-byte generated HTML provenance.
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { MediaKind } from "@openclaw/media-core/constants";
import {
  getFileExtension,
  kindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { chunkItems } from "../utils/chunk-items.js";
import { HostReadMediaTypeError } from "./local-media-access.js";
import { getMediaDir } from "./store.js";

const HOST_READ_ALLOWED_DOCUMENT_MIMES = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/zip",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/x-matlab",
  "text/x-tex",
  "text/x-bibtex",
  "application/json",
  "application/yaml",
]);
// file-type returns undefined (no magic bytes) for plain-text formats like CSV,
// Markdown, TXT, JSON, and YAML, so host-read needs an explicit "this really
// decodes as text" fallback.
const HOST_READ_TEXT_PLAIN_ALIASES = new Set([
  "text/csv",
  "text/markdown",
  "text/plain",
  // HF-04: MATLAB, LaTeX and BibTeX sources decode as plain text
  "text/x-matlab",
  "text/x-tex",
  "text/x-bibtex",
  "application/json",
  "application/yaml",
]);
// HTML remains deliberately outside the host-read allowlist pending a separate
// security-boundary review, but extension-declared .html files still need to
// fail closed instead of falling through to binary/media sniffing.
const HOST_READ_DECLARED_TEXT_MIMES = new Set([...HOST_READ_TEXT_PLAIN_ALIASES, "text/html"]);
export const HOST_READ_DECLARED_TEXT_ERROR =
  "hostReadCapability permits only validated plain-text documents " +
  "and trusted generated HTML reports for local reads";
const HOST_READ_TEXT_PLAIN_EXTENSION_BY_MIME: Record<string, readonly string[]> = {
  "text/plain": [".txt"],
};
function getTextStats(text: string): { printableRatio: number } {
  if (!text) {
    return { printableRatio: 0 };
  }
  let printable = 0;
  let control = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      printable += 1;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      control += 1;
      continue;
    }
    printable += 1;
  }
  const total = printable + control;
  if (total === 0) {
    return { printableRatio: 0 };
  }
  return { printableRatio: printable / total };
}

function hasSingleByteTextShape(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  let asciiText = 0;
  let control = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte <= 0x7e)) {
      asciiText += 1;
      continue;
    }
    if (byte < 0x20 || byte === 0x7f) {
      control += 1;
    }
  }
  const total = buffer.length;
  const highBytes = total - asciiText - control;
  return control === 0 && asciiText / total >= 0.7 && highBytes / total <= 0.3;
}

function decodeHostReadText(buffer: Buffer): string | undefined {
  if (buffer.length === 0) {
    return "";
  }
  // UTF-16 decoding is intentionally omitted: TextDecoder("utf-16le/be") never throws on
  // arbitrary byte pairs, so every byte pair is a valid (if meaningless) Unicode scalar —
  // an attacker can prepend a BOM and pass getTextStats with printableRatio≈1.0 on pure
  // binary garbage. The Latin-1 path below already covers the most common non-UTF-8
  // real-world case (Excel CSV exports with accented chars like é, ñ) while remaining
  // safe because hasSingleByteTextShape gates on byte shape *before* any decode.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    if (!hasSingleByteTextShape(buffer)) {
      return undefined;
    }
    // WHATWG latin1 decodes common Excel-style single-byte exports via Windows-1252 mapping.
    return new TextDecoder("latin1").decode(buffer);
  }
}

function isValidatedHostReadText(buffer?: Buffer): boolean {
  return getValidatedHostReadText(buffer) !== undefined;
}

function getValidatedHostReadText(buffer?: Buffer): string | undefined {
  if (!buffer) {
    return undefined;
  }
  if (buffer.length === 0) {
    return "";
  }
  const text = decodeHostReadText(buffer);
  if (text === undefined) {
    return undefined;
  }
  const { printableRatio } = getTextStats(text);
  return printableRatio > 0.95 ? text : undefined;
}

function hasHtmlDocumentShape(text: string): boolean {
  const sample = text.trimStart().slice(0, 8192);
  return /^(?:<!doctype\s+html\b|<html\b)/iu.test(sample) || /<\/(?:html|body)>/iu.test(sample);
}

export type HostReadHtmlTrust =
  | { source: "temp-root" }
  | { source: "outbound"; expectedSha256: string; expectedSize: number };

const TRUSTED_GENERATED_HTML_MARKER_VERSION = 1;
const TRUSTED_GENERATED_HTML_MARKER_KIND = "trusted-generated-html";
type OutboundProvenanceDatabase = Pick<OpenClawStateKyselyDatabase, "outbound_media_provenance">;

async function getTrustedGeneratedHtmlMarker(
  resolvedFilePath: string,
): Promise<{ sha256: string; size: number } | undefined> {
  try {
    const { db } = openOpenClawStateDatabase();
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<OutboundProvenanceDatabase>(db)
        .selectFrom("outbound_media_provenance")
        .select(["kind", "version", "sha256", "size_bytes"])
        .where("realpath", "=", resolvedFilePath),
    );
    return row?.kind === TRUSTED_GENERATED_HTML_MARKER_KIND &&
      row.version === TRUSTED_GENERATED_HTML_MARKER_VERSION
      ? { sha256: row.sha256, size: row.size_bytes }
      : undefined;
  } catch (error) {
    // State failures must narrow trust, never turn into a permissive fallback.
    logVerbose(
      `trusted-html marker lookup failed (${resolvedFilePath}): ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

export async function resolveTrustedGeneratedHostReadHtml(
  filePath: string | undefined,
): Promise<HostReadHtmlTrust | undefined> {
  if (!filePath) {
    return undefined;
  }
  const info = await lstat(filePath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return undefined;
  }
  const [resolvedFilePath, tmpRoot, outboundRoot] = await Promise.all([
    realpath(filePath).catch(() => undefined),
    realpath(resolvePreferredOpenClawTmpDir()).catch(() => undefined),
    realpath(path.join(getMediaDir(), "outbound")).catch(() => undefined),
  ]);
  if (!resolvedFilePath) {
    return undefined;
  }
  // Outbound staging always requires provenance, even when a custom state dir
  // places media/outbound underneath the otherwise trusted temp root.
  if (outboundRoot && isPathInside(outboundRoot, resolvedFilePath)) {
    const marker = await getTrustedGeneratedHtmlMarker(resolvedFilePath);
    return marker
      ? { source: "outbound", expectedSha256: marker.sha256, expectedSize: marker.size }
      : undefined;
  }
  return tmpRoot && isPathInside(tmpRoot, resolvedFilePath) ? { source: "temp-root" } : undefined;
}

/** Records exact-byte provenance for a trusted generated HTML staged outbound. */
export async function markTrustedGeneratedHtmlPath(
  filePath: string,
  contents: Buffer,
): Promise<void> {
  const resolvedFilePath = await realpath(filePath);
  const outboundRoot = await realpath(path.join(getMediaDir(), "outbound")).catch(() => undefined);
  if (!outboundRoot || !isPathInside(outboundRoot, resolvedFilePath)) {
    throw new Error(
      `markTrustedGeneratedHtmlPath: refusing path outside outbound staging: ${resolvedFilePath}`,
    );
  }
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const sizeBytes = contents.length;
  const createdAtMs = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<OutboundProvenanceDatabase>(db)
        .insertInto("outbound_media_provenance")
        .values({
          realpath: resolvedFilePath,
          kind: TRUSTED_GENERATED_HTML_MARKER_KIND,
          version: TRUSTED_GENERATED_HTML_MARKER_VERSION,
          sha256,
          size_bytes: sizeBytes,
          created_at_ms: createdAtMs,
        })
        .onConflict((conflict) =>
          conflict.column("realpath").doUpdateSet({
            kind: TRUSTED_GENERATED_HTML_MARKER_KIND,
            version: TRUSTED_GENERATED_HTML_MARKER_VERSION,
            sha256,
            size_bytes: sizeBytes,
            created_at_ms: createdAtMs,
          }),
        ),
    );
  });
}

/** Removes provenance whose staged regular file no longer exists. */
export async function pruneStaleTrustedGeneratedHtmlMarkers(): Promise<void> {
  const { db } = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<OutboundProvenanceDatabase>(db)
      .selectFrom("outbound_media_provenance")
      .select("realpath"),
  ).rows;
  const stale: string[] = [];
  for (const row of rows) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(row.realpath);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        stale.push(row.realpath);
      } else {
        logVerbose(
          `trusted-html prune kept uninspectable marker (${row.realpath}): ${formatErrorMessage(error)}`,
        );
      }
      continue;
    }
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      stale.push(row.realpath);
    }
  }
  if (stale.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db: writeDb }) => {
    for (const batch of chunkItems(stale, 500)) {
      executeSqliteQuerySync(
        writeDb,
        getNodeSqliteKysely<OutboundProvenanceDatabase>(writeDb)
          .deleteFrom("outbound_media_provenance")
          .where("realpath", "in", batch),
      );
    }
  });
  logVerbose(`trusted-html prune removed ${stale.length} stale marker(s)`);
}

function isTrustedGeneratedHostReadHtml(params: {
  filePath?: string;
  sniffedContentType?: string;
  buffer?: Buffer;
  trustedGeneratedHtmlPath?: HostReadHtmlTrust;
}): boolean {
  const sniffedMime = normalizeMimeType(params.sniffedContentType);
  if (sniffedMime && sniffedMime !== "text/html") {
    return false;
  }
  if (!params.trustedGeneratedHtmlPath) {
    return false;
  }
  const text = getValidatedHostReadText(params.buffer);
  if (text === undefined || !hasHtmlDocumentShape(text)) {
    return false;
  }
  if (params.trustedGeneratedHtmlPath.source === "temp-root") {
    return true;
  }
  return (
    params.buffer?.length === params.trustedGeneratedHtmlPath.expectedSize &&
    createHash("sha256").update(params.buffer).digest("hex") ===
      params.trustedGeneratedHtmlPath.expectedSha256
  );
}

function isAllowedHostReadTextAlias(mime: string | undefined, filePath?: string): boolean {
  if (!mime || !HOST_READ_TEXT_PLAIN_ALIASES.has(mime)) {
    return false;
  }
  const allowedExtensions = HOST_READ_TEXT_PLAIN_EXTENSION_BY_MIME[mime];
  if (!allowedExtensions) {
    return true;
  }
  const ext = getFileExtension(filePath);
  return ext !== undefined && allowedExtensions.includes(ext);
}

export function assertHostReadMediaAllowed(params: {
  sniffedContentType?: string;
  contentType?: string;
  filePath?: string;
  kind: MediaKind | undefined;
  buffer?: Buffer;
  trustedGeneratedHtmlPath?: HostReadHtmlTrust;
}): void {
  const declaredMime = normalizeMimeType(mimeTypeFromFilePath(params.filePath));
  const normalizedMime = normalizeMimeType(params.contentType);
  // For extension-declared plain-text aliases such as .csv/.html/.md, trust only the
  // text validator path. Some opaque blobs can still produce bogus binary MIME
  // hits (for example BOM-prefixed 0xFF data sniffing as audio/mpeg), and
  // host-read should reject those instead of returning early on the sniff.
  if (declaredMime && HOST_READ_DECLARED_TEXT_MIMES.has(declaredMime)) {
    if (
      declaredMime === "text/html" &&
      isTrustedGeneratedHostReadHtml({
        filePath: params.filePath,
        sniffedContentType: params.sniffedContentType,
        buffer: params.buffer,
        trustedGeneratedHtmlPath: params.trustedGeneratedHtmlPath,
      })
    ) {
      return;
    }
    if (
      isAllowedHostReadTextAlias(declaredMime, params.filePath) &&
      !params.sniffedContentType &&
      params.buffer &&
      isValidatedHostReadText(params.buffer)
    ) {
      return;
    }
    throw new HostReadMediaTypeError(HOST_READ_DECLARED_TEXT_ERROR);
  }
  const sniffedKind = kindFromMime(params.sniffedContentType);
  if (sniffedKind === "image" || sniffedKind === "audio" || sniffedKind === "video") {
    return;
  }
  const sniffedMime = normalizeMimeType(params.sniffedContentType);
  if (
    sniffedKind === "document" &&
    sniffedMime &&
    HOST_READ_ALLOWED_DOCUMENT_MIMES.has(sniffedMime)
  ) {
    return;
  }
  if (
    sniffedMime === "application/x-cfb" &&
    [".doc", ".ppt", ".xls"].includes(getFileExtension(params.filePath) ?? "")
  ) {
    return;
  }
  // Plain-text document exception: file-type v22 returns undefined (not "text/plain")
  // for text buffers that have no binary magic bytes. Allow these formats when:
  // - sniffedMime is undefined (no binary signature detected by file-type)
  // - The extension-derived MIME is an allowed text/document MIME (operator intent)
  // - The buffer decodes as actual text instead of opaque binary bytes
  if (
    !sniffedMime &&
    normalizedMime &&
    isAllowedHostReadTextAlias(normalizedMime, params.filePath) &&
    params.buffer &&
    isValidatedHostReadText(params.buffer)
  ) {
    return;
  }
  if (
    params.kind === "document" &&
    normalizedMime &&
    HOST_READ_ALLOWED_DOCUMENT_MIMES.has(normalizedMime)
  ) {
    throw new HostReadMediaTypeError(
      `Host-local media sends require buffer-verified media/document types (got fallback ${normalizedMime}).`,
    );
  }
  throw new HostReadMediaTypeError(
    `Host-local media sends only allow buffer-verified images, audio, video, PDF, Office documents, archives, and validated plain-text documents (got ${sniffedMime ?? normalizedMime ?? "unknown"}).`,
  );
}
