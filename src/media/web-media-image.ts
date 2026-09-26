// Model image policy and size-bounded image optimization for web media.
import path from "node:path";
import { maxBytesForKind } from "@openclaw/media-core/constants";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { ImageOptimizationLimitError } from "./image-optimization-error.js";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";
import { createImageProcessorWithPixelLimits } from "./image-processor.js";
import {
  readImageMetadataFromHeader,
  readImageProbeFromHeader,
  type ImageMetadata,
} from "./media-services.js";
import { formatMediaSize } from "./store.shared.js";
import type {
  WebMediaResult,
  ImageCompressionPolicy,
  ImageCompressionModelPolicy,
  ImageQualityPreference,
} from "./web-media.js";

export function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMediaSize(cap)} limit (got ${formatMediaSize(size)})`;
}

function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMediaSize(cap)} (got ${formatMediaSize(size)})`;
}

function toImageFileName(fileName: string | undefined, mimeType: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const trimmed = basenameFromAnyPath(fileName.trim());
  if (!trimmed) {
    return fileName;
  }
  const parsed = path.parse(trimmed);
  const ext = extensionForMime(mimeType);
  return mimeType !== "image/jpeg" && parsed.ext.toLowerCase() === ext
    ? fileName
    : path.format({ dir: parsed.dir, name: parsed.name || trimmed, ext });
}

type OptimizedImage = {
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  format: "jpeg" | "png" | "webp";
  mimeType: string;
  quality?: number;
  compressionLevel?: number;
};

const DEFAULT_JPEG_SIDES = [2048, 1536, 1280, 1024, 800] as const;
const DEFAULT_JPEG_QUALITIES = [80, 70, 60, 50, 40] as const;
const DEFAULT_VISION_MAX_SIDE = 2048;
const LOW_IMAGE_SIDE_FALLBACKS = [640, 512, 384, 256, 192, 128] as const;

function normalizeImageQualityPreference(value?: string): ImageQualityPreference {
  switch (value) {
    case "efficient":
    case "balanced":
    case "high":
      return value;
    default:
      return "auto";
  }
}

function squareLongSideForPixelBudget(pixelBudget: number): number {
  return Math.floor(Math.sqrt(pixelBudget));
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function effectiveImageQualityPreference(
  policy?: ImageCompressionPolicy,
): Exclude<ImageQualityPreference, "auto"> {
  const preference = normalizeImageQualityPreference(policy?.quality);
  if (preference !== "auto") {
    return preference;
  }
  const imageCount = Math.max(1, Math.floor(policy?.imageCount ?? 1));
  if (imageCount >= 6) {
    return "efficient";
  }
  return "balanced";
}

function maxSideForModel(model: ImageCompressionModelPolicy | undefined): number {
  const maxSide = positiveInteger(model?.maxSidePx);
  const maxPixels = positiveInteger(model?.maxPixels);
  const hardLimits = [
    maxSide,
    maxPixels ? squareLongSideForPixelBudget(maxPixels) : undefined,
  ].filter((value): value is number => value !== undefined);
  if (hardLimits.length > 0) {
    return Math.min(...hardLimits);
  }
  return positiveInteger(model?.preferredSidePx) ?? DEFAULT_VISION_MAX_SIDE;
}

function preferredSideForModel(model: ImageCompressionModelPolicy | undefined): number {
  return (
    positiveInteger(model?.preferredSidePx) ??
    Math.min(maxSideForModel(model), DEFAULT_VISION_MAX_SIDE)
  );
}

function policyModelSides(policy: ImageCompressionPolicy | undefined): {
  maxSide: number;
  preferredSide: number;
} {
  const models = policy?.models?.length ? policy.models : [undefined];
  const maxSide = Math.min(...models.map((model) => maxSideForModel(model)));
  const preferredSide = Math.min(...models.map((model) => preferredSideForModel(model)));
  return {
    maxSide,
    preferredSide: Math.min(preferredSide, maxSide),
  };
}

function sideForPreference(
  preference: Exclude<ImageQualityPreference, "auto">,
  policy?: ImageCompressionPolicy,
): number {
  const { maxSide, preferredSide } = policyModelSides(policy);
  switch (preference) {
    case "efficient":
      return Math.min(preferredSide, maxSide, 1280);
    case "balanced":
      return Math.min(preferredSide, maxSide);
    case "high":
      return maxSide;
  }
  return Math.min(preferredSide, maxSide);
}

function imageMaxBytesForPolicy(policy?: ImageCompressionPolicy): number | undefined {
  const maxBytes = policy?.models
    ?.map((model) => positiveInteger(model.maxBytes))
    .filter((value): value is number => value !== undefined);
  return maxBytes?.length ? Math.min(...maxBytes) : undefined;
}

function imageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
  metadata?: ImageMetadata,
): boolean {
  const models = policy?.models ?? [];
  const hardMaxSides = models
    .map((model) => positiveInteger(model.maxSidePx))
    .filter((value): value is number => value !== undefined);
  const hardMaxPixels = models
    .map((model) => positiveInteger(model.maxPixels))
    .filter((value): value is number => value !== undefined);
  if (hardMaxSides.length === 0 && hardMaxPixels.length === 0) {
    return true;
  }

  const meta = metadata ?? readImageMetadataFromHeader(buffer);
  if (!meta) {
    return false;
  }
  const maxSide = Math.max(meta.width, meta.height);
  const pixels = meta.width * meta.height;
  return (
    (hardMaxSides.length === 0 || maxSide <= Math.min(...hardMaxSides)) &&
    (hardMaxPixels.length === 0 || pixels <= Math.min(...hardMaxPixels))
  );
}

export function assertImageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
): void {
  if (imageSatisfiesHardDimensionPolicy(buffer, policy)) {
    return;
  }
  const meta = readImageMetadataFromHeader(buffer);
  const detail = meta ? `: ${meta.width}x${meta.height}` : "";
  throw new Error(`Image dimensions exceed model image limits${detail}`);
}

function resolvePreservableOriginalImageContentType(params: {
  buffer: Buffer;
  cap: number;
  contentType?: string;
  policy?: ImageCompressionPolicy;
}): string | null {
  if (params.buffer.length > params.cap) {
    return null;
  }
  const declaredContentType = normalizeMimeType(params.contentType);
  const probe = readImageProbeFromHeader(params.buffer);
  const actualContentType = probe ? `image/${probe.format}` : undefined;
  if (!probe || !isPreservableImageMime(actualContentType)) {
    return null;
  }
  const declaredPreservableContentType = isPreservableImageMime(declaredContentType)
    ? declaredContentType
    : undefined;
  if (declaredPreservableContentType && declaredPreservableContentType !== actualContentType) {
    return null;
  }
  if (declaredContentType?.startsWith("image/") && !declaredPreservableContentType) {
    return null;
  }
  const preferredSide =
    resolveImageCompressionGrid(params.policy).sides[0] ?? DEFAULT_VISION_MAX_SIDE;
  if (
    Math.max(probe.width, probe.height) > preferredSide ||
    !imageSatisfiesHardDimensionPolicy(params.buffer, params.policy, probe)
  ) {
    return null;
  }
  return declaredPreservableContentType ?? actualContentType;
}

function isPreservableImageMime(
  contentType: string | undefined,
): contentType is "image/png" | "image/jpeg" | "image/webp" {
  return (
    contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp"
  );
}

/** Returns the stricter byte cap between caller limits and image compression policy limits. */
export function effectiveImageBytesCap(
  baseCap: number | undefined,
  policy?: ImageCompressionPolicy,
): number | undefined {
  const policyCap = imageMaxBytesForPolicy(policy);
  if (baseCap === undefined) {
    return policyCap;
  }
  return policyCap === undefined ? baseCap : Math.min(baseCap, policyCap);
}

function buildDescendingLadder(maxSide: number, values: readonly number[]): number[] {
  const normalizedMax = Math.max(1, Math.floor(maxSide));
  const ladder = uniqueValues(
    [normalizedMax, ...values, ...LOW_IMAGE_SIDE_FALLBACKS]
      .map((value) => Math.min(normalizedMax, value))
      .filter((value) => value > 0),
  ).toSorted((a, b) => b - a);
  if (ladder.length > 1 || normalizedMax <= 1) {
    return ladder;
  }
  const fallbackLadder = [
    normalizedMax,
    Math.floor(normalizedMax * 0.75),
    Math.floor(normalizedMax * 0.5),
    Math.floor(normalizedMax * 0.25),
  ];
  return uniqueValues(fallbackLadder.filter((value) => value > 0)).toSorted((a, b) => b - a);
}

/** Resolves the ordered max-side and JPEG quality search grid for an image compression policy. */
export function resolveImageCompressionGrid(policy?: ImageCompressionPolicy): {
  sides: number[];
  qualities: number[];
} {
  const preference = effectiveImageQualityPreference(policy);
  const side = sideForPreference(preference, policy);
  switch (preference) {
    case "efficient":
      return {
        sides: buildDescendingLadder(side, [1024, 800]),
        qualities: [70, 60, 50, 40],
      };
    case "high":
      return {
        sides: buildDescendingLadder(side, [3072, 2576, 2048, 1800, 1536, 1280, 1024, 800]),
        qualities: [92, 85, 78, 70, 62, 52, 42],
      };
    case "balanced":
      return {
        sides: buildDescendingLadder(side, [...DEFAULT_JPEG_SIDES]),
        qualities: [...DEFAULT_JPEG_QUALITIES],
      };
  }
  return {
    sides: buildDescendingLadder(side, [...DEFAULT_JPEG_SIDES]),
    qualities: [...DEFAULT_JPEG_QUALITIES],
  };
}

function logOptimizedImage(params: { originalSize: number; optimized: OptimizedImage }): void {
  if (!shouldLogVerbose()) {
    return;
  }
  if (params.optimized.optimizedSize >= params.originalSize) {
    return;
  }
  if (params.optimized.format === "png") {
    logVerbose(
      `Optimized PNG (preserving alpha) from ${formatMediaSize(params.originalSize)} to ${formatMediaSize(params.optimized.optimizedSize)} (side<=${params.optimized.resizeSide}px)`,
    );
    return;
  }
  logVerbose(
    `Optimized media from ${formatMediaSize(params.originalSize)} to ${formatMediaSize(params.optimized.optimizedSize)} (side<=${params.optimized.resizeSide}px, q=${params.optimized.quality})`,
  );
}

async function optimizeImageWithFallback(params: {
  buffer: Buffer;
  cap: number;
  imageCompression?: ImageCompressionPolicy;
  maxInputPixels?: number;
}): Promise<OptimizedImage> {
  const { buffer, cap } = params;
  const grid = resolveImageCompressionGrid(params.imageCompression);
  // Generic callers keep the shared decode limit. An owner with a bounded downscale path may
  // widen source admission explicitly, while every encoded result remains under the output cap.
  const processor = createImageProcessorWithPixelLimits({
    inputPixels: params.maxInputPixels ?? MAX_IMAGE_INPUT_PIXELS,
    outputPixels: MAX_IMAGE_INPUT_PIXELS,
  });
  const optimized = await processor.encode(buffer, {
    format: "auto",
    maxBytes: cap,
    opaque: { format: "jpeg" },
    transparent: { format: "png" },
    search: {
      maxSide: grid.sides,
      quality: grid.qualities,
    },
    transparency: "auto",
  });
  if (optimized.chosen.transparency === "flattened" && shouldLogVerbose()) {
    logVerbose(`Image transparency flattened to fit ${formatMediaSize(cap)} optimization budget`);
  }
  return {
    buffer: optimized.data,
    optimizedSize: optimized.bytes,
    resizeSide: optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height),
    format: optimized.format,
    mimeType: optimized.mimeType,
    ...(optimized.chosen.quality === undefined ? {} : { quality: optimized.chosen.quality }),
    ...(optimized.chosen.compressionLevel === undefined
      ? {}
      : { compressionLevel: optimized.chosen.compressionLevel }),
  };
}

/** Optimizes image bytes for web-media delivery while preserving accepted original formats when possible. */
export async function optimizeImageBufferForWebMedia(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  maxBytes?: number;
  imageCompression?: ImageCompressionPolicy;
  maxInputPixels?: number;
}): Promise<WebMediaResult> {
  const baseCap = params.maxBytes ?? maxBytesForKind("image");
  const cap = effectiveImageBytesCap(baseCap, params.imageCompression) ?? baseCap;
  if (params.contentType === "image/gif") {
    if (params.buffer.length > cap) {
      throw new ImageOptimizationLimitError(formatCapLimit("GIF", cap, params.buffer.length), cap);
    }
    assertImageSatisfiesHardDimensionPolicy(params.buffer, params.imageCompression);
    return {
      buffer: params.buffer,
      contentType: params.contentType,
      kind: "image",
      fileName: params.fileName,
    };
  }
  const originalContentType = resolvePreservableOriginalImageContentType({
    buffer: params.buffer,
    cap,
    contentType: params.contentType,
    policy: params.imageCompression,
  });
  if (originalContentType) {
    return {
      buffer: params.buffer,
      contentType: originalContentType,
      kind: "image",
      fileName: params.fileName,
    };
  }
  const optimized = await optimizeImageWithFallback({
    buffer: params.buffer,
    cap,
    imageCompression: params.imageCompression,
    ...(params.maxInputPixels === undefined ? {} : { maxInputPixels: params.maxInputPixels }),
  });
  logOptimizedImage({ originalSize: params.buffer.length, optimized });
  if (optimized.buffer.length > cap) {
    throw new ImageOptimizationLimitError(
      formatCapReduce("Media", cap, optimized.buffer.length),
      cap,
    );
  }
  return {
    buffer: optimized.buffer,
    contentType: optimized.mimeType,
    kind: "image",
    fileName: toImageFileName(params.fileName, optimized.mimeType),
  };
}
