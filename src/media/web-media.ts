// Web media helpers load local and remote media for web-facing surfaces.
import path from "node:path";
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { basenameFromAnyPath, extnameFromAnyPath } from "@openclaw/media-core/file-name";
import {
  detectMime,
  extensionForMime,
  kindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { resolveCanvasHttpPathToLocalPath } from "../canvas/documents.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import type { PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { isPathInside } from "../infra/path-guards.js";
import { getPluginRegistryForContext } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";
import { readOutboundMediaFile } from "./bounded-read-file.js";
import { readRemoteMediaBuffer } from "./fetch.js";
import type { OutboundMediaReadFile } from "./load-options.js";
import {
  assertLocalMediaAllowed,
  getDefaultLocalRootsCore,
  LocalMediaAccessError,
  readLocalMediaFile,
  type LocalMediaAccessErrorCode,
} from "./local-media-access.js";
import { MediaReferenceError, resolveInboundMediaReference } from "./media-reference.js";
import { createImageProcessor } from "./media-services.js";
import { extractOriginalFilename, getMediaDir } from "./store.js";
import { formatMediaSize } from "./store.shared.js";
import {
  assertHostReadMediaAllowed,
  HOST_READ_DECLARED_TEXT_ERROR,
  resolveTrustedGeneratedHostReadHtml,
} from "./web-media-host-read.js";
import {
  assertImageSatisfiesHardDimensionPolicy,
  effectiveImageBytesCap,
  formatCapLimit,
  optimizeImageBufferForWebMedia,
  resolveImageCompressionGrid,
} from "./web-media-image.js";
export {
  markTrustedGeneratedHtmlPath,
  pruneStaleTrustedGeneratedHtmlMarkers,
} from "./web-media-host-read.js";
export {
  effectiveImageBytesCap,
  optimizeImageBufferForWebMedia,
  resolveImageCompressionGrid,
} from "./web-media-image.js";

export { getDefaultLocalRootsCore, LocalMediaAccessError };
export type { LocalMediaAccessErrorCode };

/** Loaded media bytes plus resolved MIME kind and filename metadata for outbound/plugin callers. */
export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind | undefined;
  fileName?: string;
  /** Source bytes came from a generated-HTML trust boundary. */
  trustedGeneratedHtmlSource?: boolean;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
  imageCompression?: ImageCompressionPolicy;
  ssrfPolicy?: SsrFPolicy;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  readIdleTimeoutMs?: number;
  trustExplicitProxyDns?: boolean;
  workspaceDir?: string;
  /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
  localRoots?: readonly string[] | "any";
  /** Channel inbound attachment root patterns checked with inbound path policy semantics. */
  inboundRoots?: readonly string[];
  /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
  sandboxValidated?: boolean;
  readFile?: OutboundMediaReadFile;
  /** Host-local fs-policy read piggyback; rejects plaintext-like document sends. */
  hostReadCapability?: boolean;
};

/** Compression preference used to tune image size/quality search grids. */
export type ImageQualityPreference = "auto" | "efficient" | "balanced" | "high";

/** Per-model image compression constraints merged into outbound media policy. */
export type ImageCompressionModelPolicy = {
  maxBytes?: number;
  maxPixels?: number;
  maxSidePx?: number;
  preferredSidePx?: number;
};

/** Image compression policy for model/tool callers that need bounded media payloads. */
export type ImageCompressionPolicy = {
  quality?: ImageQualityPreference;
  models?: ImageCompressionModelPolicy[];
  imageCount?: number;
};

async function resolveMediaStoreUriToPath(mediaUrl: string): Promise<string | null> {
  if (!/^media:\/\//i.test(mediaUrl)) {
    return null;
  }
  try {
    return (await resolveInboundMediaReference(mediaUrl))?.physicalPath ?? null;
  } catch (err) {
    if (err instanceof MediaReferenceError) {
      throw new LocalMediaAccessError(err.code, err.message, { cause: err });
    }
    throw err;
  }
}

async function resolveHostedPluginMediaUrl(mediaUrl: string): Promise<string | null> {
  const registry = getPluginRegistryForContext();
  for (const entry of registry?.hostedMediaResolvers ?? []) {
    try {
      const resolved = await entry.resolver(mediaUrl);
      if (typeof resolved === "string" && resolved.trim()) {
        return resolved;
      }
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Hosted media resolver failed (${entry.pluginId ?? "unknown"}): ${formatErrorMessage(err)}`,
        );
      }
    }
  }
  return null;
}

function resolveWebMediaOptions(params: {
  maxBytesOrOptions?: number | WebMediaOptions;
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" };
  optimizeImages: boolean;
}): WebMediaOptions {
  if (typeof params.maxBytesOrOptions === "number" || params.maxBytesOrOptions === undefined) {
    return {
      maxBytes: params.maxBytesOrOptions,
      optimizeImages: params.optimizeImages,
      ssrfPolicy: params.options?.ssrfPolicy,
      localRoots: params.options?.localRoots,
    };
  }
  return {
    ...params.maxBytesOrOptions,
    optimizeImages: params.optimizeImages
      ? (params.maxBytesOrOptions.optimizeImages ?? true)
      : false,
  };
}

// Pre-compression fetch headroom for callers with an explicit delivery cap:
// enough to pull a large phone photo (~20MB+) and compress it under the cap,
// without letting a tight channel cap buffer up to the 100MB document bound.
const IMAGE_OPTIMIZE_HEADROOM_FACTOR = 4;

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

function stripLegacyMediaDirectivePrefix(mediaUrl: string): string {
  if (/^\s*media:\/\//i.test(mediaUrl)) {
    return mediaUrl;
  }
  return mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
}

function resolveLocalMediaFileName(filePath: string): string | undefined {
  const fileName = basenameFromAnyPath(filePath) || undefined;
  return fileName && isPathInside(getMediaDir(), filePath)
    ? extractOriginalFilename(fileName)
    : fileName;
}

async function loadWebMediaInternal(
  mediaUrlInput: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  let mediaUrl = mediaUrlInput;
  const {
    maxBytes,
    optimizeImages = true,
    ssrfPolicy,
    proxyUrl,
    fetchImpl,
    requestInit,
    readIdleTimeoutMs,
    trustExplicitProxyDns,
    workspaceDir,
    localRoots,
    inboundRoots,
    sandboxValidated = false,
    readFile: readFileOverride,
    hostReadCapability = false,
    imageCompression,
  } = options;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);
  mediaUrl = (await resolveMediaStoreUriToPath(mediaUrl)) ?? mediaUrl;
  // Use fileURLToPath for proper handling of file:// URLs (handles file://localhost/path, etc.)
  if (/^file:/iu.test(mediaUrl)) {
    try {
      mediaUrl = safeFileURLToPath(mediaUrl);
    } catch (err) {
      throw new LocalMediaAccessError("invalid-file-url", (err as Error).message, { cause: err });
    }
  }
  mediaUrl =
    resolveCanvasHttpPathToLocalPath(mediaUrl) ??
    (await resolveHostedPluginMediaUrl(mediaUrl)) ??
    mediaUrl;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);

  const clampAndFinalize = async (params: {
    buffer: Buffer;
    contentType?: string;
    kind: MediaKind | undefined;
    fileName?: string;
    trustedGeneratedHtmlSource?: boolean;
  }): Promise<WebMediaResult> => {
    // If caller explicitly provides maxBytes, trust it (for channels that handle large files).
    // Otherwise fall back to per-kind defaults.
    const cap = maxBytes !== undefined ? maxBytes : maxBytesForKind(params.kind ?? "document");
    if (params.kind === "image") {
      if (optimizeImages) {
        return await optimizeImageBufferForWebMedia({
          buffer: params.buffer,
          contentType: params.contentType,
          fileName: params.fileName,
          maxBytes: cap,
          imageCompression,
        });
      }
      const imageCap = effectiveImageBytesCap(cap, imageCompression) ?? cap;
      const isGif = params.contentType === "image/gif";
      if (params.buffer.length > imageCap) {
        throw new Error(formatCapLimit(isGif ? "GIF" : "Media", imageCap, params.buffer.length));
      }
      assertImageSatisfiesHardDimensionPolicy(params.buffer, imageCompression);
      return {
        buffer: params.buffer,
        contentType: params.contentType,
        kind: params.kind,
        fileName: params.fileName,
      };
    }
    if (params.buffer.length > cap) {
      throw new Error(formatCapLimit("Media", cap, params.buffer.length));
    }
    return {
      buffer: params.buffer,
      contentType: params.contentType ?? undefined,
      kind: params.kind,
      fileName: params.fileName,
      ...(params.trustedGeneratedHtmlSource ? { trustedGeneratedHtmlSource: true } : {}),
    };
  };

  // Bound source reads before buffering. Optimized images may exceed their
  // delivery cap because they are compressed before the final size check, so
  // an explicit caller cap gets image-compression headroom — sized off the
  // image cap, not the 100MB document cap, or a tight channel cap would still
  // permit a 100MB buffer from a hostile URL. Accepted tradeoff: originals
  // above the headroom fail even when they would have compressed under the
  // cap; the error names the fetch bound so the user can shrink the source.
  const defaultSourceReadCap = maxBytesForKind("document");
  const imageOptimizeHeadroom = IMAGE_OPTIMIZE_HEADROOM_FACTOR * maxBytesForKind("image");
  const sourceReadCap =
    maxBytes === undefined
      ? defaultSourceReadCap
      : optimizeImages
        ? Math.max(maxBytes, imageOptimizeHeadroom)
        : maxBytes;

  if (hasHttpUrlPrefix(mediaUrl)) {
    const dispatcherPolicy: PinnedDispatcherPolicy | undefined = proxyUrl
      ? {
          mode: "explicit-proxy",
          proxyUrl,
          allowPrivateProxy: true,
        }
      : undefined;
    const fetched = await readRemoteMediaBuffer({
      url: mediaUrl,
      fetchImpl,
      requestInit,
      readIdleTimeoutMs,
      maxBytes: sourceReadCap,
      ssrfPolicy,
      dispatcherPolicy,
      trustExplicitProxyDns,
    });
    const { buffer, contentType, fileName } = fetched;
    const kind = kindFromMime(contentType);
    return await clampAndFinalize({ buffer, contentType, kind, fileName });
  }

  // Expand tilde paths to absolute paths (e.g., ~/Downloads/photo.jpg)
  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }
  if (workspaceDir && !path.isAbsolute(mediaUrl) && !WINDOWS_DRIVE_RE.test(mediaUrl)) {
    mediaUrl = path.resolve(workspaceDir, mediaUrl);
  }
  try {
    assertNoWindowsNetworkPath(mediaUrl, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }

  if ((sandboxValidated || localRoots === "any") && !readFileOverride) {
    throw new LocalMediaAccessError(
      "unsafe-bypass",
      "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.",
    );
  }

  // Guard local reads against allowed directory roots to prevent file exfiltration.
  if (readFileOverride && !(sandboxValidated || localRoots === "any")) {
    await assertLocalMediaAllowed(mediaUrl, localRoots, { inboundRoots });
  }

  const hostReadDeclaredMime = hostReadCapability
    ? normalizeMimeType(mimeTypeFromFilePath(mediaUrl))
    : undefined;
  const htmlTrust =
    hostReadDeclaredMime === "text/html"
      ? await resolveTrustedGeneratedHostReadHtml(mediaUrl)
      : undefined;
  if (hostReadDeclaredMime === "text/html" && !htmlTrust) {
    throw new LocalMediaAccessError("path-not-allowed", HOST_READ_DECLARED_TEXT_ERROR);
  }

  // Local path
  let data: Buffer;
  if (readFileOverride) {
    data = await readOutboundMediaFile(readFileOverride, mediaUrl, { maxBytes: sourceReadCap });
  } else {
    try {
      data = await readLocalMediaFile(mediaUrl, localRoots, {
        ...(inboundRoots ? { inboundRoots } : {}),
        maxBytes: sourceReadCap,
      });
    } catch (err) {
      if (err instanceof FsSafeError) {
        if (err.code === "too-large") {
          throw new Error(`Media exceeds ${formatMediaSize(sourceReadCap)} limit`, {
            cause: err,
          });
        }
        if (err.code === "not-found") {
          throw new LocalMediaAccessError("not-found", `Local media file not found: ${mediaUrl}`, {
            cause: err,
          });
        }
        if (err.code === "not-file") {
          throw new LocalMediaAccessError(
            "not-file",
            `Local media path is not a file: ${mediaUrl}`,
            { cause: err },
          );
        }
        if (err.code === "path-mismatch") {
          // fs-safe reports pre-open identity drift as path-mismatch; keep the
          // product-facing classification as an access denial, not a bad path.
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaUrl}`,
            { cause: err },
          );
        }
        throw new LocalMediaAccessError(
          "invalid-path",
          `Local media path is not safe to read: ${mediaUrl}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  const sniffedMime = hostReadCapability ? await detectMime({ buffer: data }) : undefined;
  const mime = await detectMime({ buffer: data, filePath: mediaUrl });
  const kind = kindFromMime(mime);
  if (hostReadCapability) {
    assertHostReadMediaAllowed({
      sniffedContentType: sniffedMime,
      contentType: mime,
      filePath: mediaUrl,
      kind,
      buffer: data,
      trustedGeneratedHtmlPath: htmlTrust,
    });
  }
  let fileName = resolveLocalMediaFileName(mediaUrl);
  if (fileName && !extnameFromAnyPath(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) {
      fileName = `${fileName}${ext}`;
    }
  }
  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
    trustedGeneratedHtmlSource: Boolean(htmlTrust && hostReadDeclaredMime === "text/html"),
  });
}

/** Loads local, remote, hosted, or media-store media and optimizes images by default. */
export async function loadWebMedia(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: true }),
  );
}

/** Loads local, remote, hosted, or media-store media without image optimization. */
export async function loadWebMediaRaw(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: false }),
  );
}

/** Optimizes image bytes to JPEG under a target byte cap using the shared compression grid. */
export async function optimizeImageToJpeg(
  buffer: Buffer,
  maxBytes: number,
  opts: {
    contentType?: string;
    fileName?: string;
    imageCompression?: ImageCompressionPolicy;
  } = {},
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  const { sides, qualities } = resolveImageCompressionGrid(opts.imageCompression);
  const optimized = await createImageProcessor().encode(buffer, {
    format: "auto",
    maxBytes,
    opaque: { format: "jpeg" },
    search: {
      maxSide: sides,
      quality: qualities,
    },
    transparency: "flatten",
  });
  return {
    buffer: optimized.data,
    optimizedSize: optimized.bytes,
    resizeSide: optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height),
    quality: optimized.chosen.quality ?? qualities.at(-1) ?? 85,
  };
}

export { optimizeImageToPng } from "./media-services.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
