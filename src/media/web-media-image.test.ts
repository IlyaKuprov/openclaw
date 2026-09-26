// Image compression policy and direct/local image optimization tests.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  createImageProcessor,
  readImageMetadataFromHeader,
  resizeToJpeg,
} from "./media-services.js";
import { encodePngRgba, fillPixel } from "./png-encode.js";

let effectiveImageBytesCap: typeof import("./web-media.js").effectiveImageBytesCap;
let loadWebMedia: typeof import("./web-media.js").loadWebMedia;
let loadWebMediaRaw: typeof import("./web-media.js").loadWebMediaRaw;
let optimizeImageToJpeg: typeof import("./web-media.js").optimizeImageToJpeg;
let resolveImageCompressionGrid: typeof import("./web-media.js").resolveImageCompressionGrid;
let fixtureRoot = "";
let tinyPngFile = "";

beforeAll(async () => {
  ({
    effectiveImageBytesCap,
    loadWebMedia,
    loadWebMediaRaw,
    optimizeImageToJpeg,
    resolveImageCompressionGrid,
  } = await import("./web-media.js"));
  fixtureRoot = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "web-media-image-"));
  tinyPngFile = path.join(fixtureRoot, "tiny.png");
  await fs.writeFile(tinyPngFile, createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 }));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe("web media image compression", () => {
  function createLargeColorBlockPng(size: number): Buffer {
    const buf = Buffer.alloc(size * size * 4, 255);
    const centerStart = Math.floor(size * 0.25);
    const centerEnd = Math.floor(size * 0.75);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
        fillPixel(buf, x, y, size, inCenter ? 230 : 30, inCenter ? 40 : 110, inCenter ? 35 : 220);
      }
    }
    return encodePngRgba(buf, size, size);
  }

  function createLargeTransparentColorBlockPng(size: number): Buffer {
    const buf = Buffer.alloc(size * size * 4, 0);
    const centerStart = Math.floor(size * 0.25);
    const centerEnd = Math.floor(size * 0.75);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
        fillPixel(
          buf,
          x,
          y,
          size,
          inCenter ? 230 : 30,
          inCenter ? 40 : 110,
          inCenter ? 35 : 220,
          inCenter ? 255 : 96,
        );
      }
    }
    return encodePngRgba(buf, size, size);
  }

  function readPngDimensions(buffer: Buffer): { width: number; height: number } {
    if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("PNG dimensions not found");
    }
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  function createGifHeader(width: number, height: number): Buffer {
    const buffer = Buffer.alloc(10);
    buffer.write("GIF89a", 0, "ascii");
    buffer.writeUInt16LE(width, 6);
    buffer.writeUInt16LE(height, 8);
    return buffer;
  }

  function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = expectDefined(buffer[offset + 1], "buffer[offset + 1] test invariant");
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
    throw new Error("JPEG dimensions not found");
  }

  it("surfaces Rastermill decode failures when image optimization cannot produce a JPEG", async () => {
    await expect(optimizeImageToJpeg(Buffer.from("not an image"), 8)).rejects.toThrow(
      /Unable to determine image dimensions/,
    );
  });

  it("uses model metadata-aware image compression grids", () => {
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 2576, preferredSidePx: 2576 }],
        quality: "high",
      }).sides[0],
    ).toBe(2576);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 1568, preferredSidePx: 1568 }],
        quality: "high",
      }).sides[0],
    ).toBe(1568);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 6000, preferredSidePx: 2048 }],
        quality: "high",
      }).sides[0],
    ).toBe(6000);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 6000, preferredSidePx: 2048 }],
        quality: "balanced",
      }).sides[0],
    ).toBe(2048);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 6000, maxPixels: 12845056, preferredSidePx: 2048 }],
        quality: "high",
      }).sides[0],
    ).toBe(3584);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxPixels: 33177600, preferredSidePx: 2048 }],
        quality: "high",
      }).sides[0],
    ).toBe(5760);
    expect(
      resolveImageCompressionGrid({
        models: [
          { maxSidePx: 6000, preferredSidePx: 2048 },
          { maxSidePx: 1568, preferredSidePx: 1568 },
        ],
        quality: "high",
      }).sides[0],
    ).toBe(1568);
    expect(
      resolveImageCompressionGrid({
        models: [{ maxSidePx: 512, preferredSidePx: 512, maxBytes: 64 * 1024 }],
        quality: "balanced",
      }).sides,
    ).toEqual([512, 384, 256, 192, 128]);
  });

  it("adapts automatic image compression for many-image turns", () => {
    const single = resolveImageCompressionGrid({
      models: [{ maxSidePx: 2576, preferredSidePx: 2576 }],
      quality: "auto",
      imageCount: 1,
    });
    const many = resolveImageCompressionGrid({
      models: [{ maxSidePx: 2576, preferredSidePx: 2576 }],
      quality: "auto",
      imageCount: 8,
    });

    expect(single.sides[0]).toBe(2576);
    expect(single.qualities).toEqual([80, 70, 60, 50, 40]);
    expect(many.sides[0]).toBe(1280);
    expect(many.qualities).toEqual([70, 60, 50, 40]);
  });

  it.each(
    (["png", "jpeg", "webp"] as const).flatMap((format) =>
      [format, "heic", "heif"].map((extension) => ({ format, extension })),
    ),
  )(
    "preserves original $format bytes with .$extension filename and image limits",
    async ({ format, extension }) => {
      const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
      const sourcePng = createSolidPngBuffer(32, 16, { r: 12, g: 34, b: 56 });
      let buffer =
        format === "png"
          ? sourcePng
          : (await createImageProcessor().encode(sourcePng, { format })).data;
      if (format === "jpeg") {
        const orientation = Buffer.from(
          "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
          "hex",
        );
        buffer = Buffer.concat([buffer.subarray(0, 2), orientation, buffer.subarray(2)]);
        expect(readImageMetadataFromHeader(buffer)).toEqual({ width: 16, height: 32 });
      }
      const original = Buffer.from(buffer);
      const contentType = `image/${format}`;
      const fileName = `portrait.${extension}`;
      const filePath = path.join(fixtureRoot, fileName);
      await fs.writeFile(filePath, buffer);
      for (const imageCompression of [
        undefined,
        { models: [{ maxSidePx: 32, maxPixels: 1024 }] },
      ]) {
        const loaded = await loadWebMedia(filePath, {
          localRoots: [fixtureRoot],
          maxBytes: 1024 * 1024,
          imageCompression,
        });
        expect(loaded.buffer).toEqual(original);
        expect(loaded.contentType).toBe(contentType);
        expect(loaded.fileName).toBe(fileName);

        const result = await optimizeImageBufferForWebMedia({
          buffer,
          contentType,
          fileName,
          maxBytes: 1024 * 1024,
          imageCompression,
        });
        expect(result.buffer).toBe(buffer);
        expect(result.buffer).toEqual(original);
        expect(result.contentType).toBe(contentType);
        expect(result.fileName).toBe(fileName);
      }
    },
  );

  it("preserves in-limit GIF buffers when optimizing direct image buffers", async () => {
    const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
    const buffer = createGifHeader(16, 16);
    const result = await optimizeImageBufferForWebMedia({
      buffer,
      contentType: "image/gif",
      maxBytes: 1024,
      imageCompression: { models: [{ maxSidePx: 64 }] },
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/gif");
    expect(result.buffer.equals(buffer)).toBe(true);
  });

  it("does not bypass model dimensions for GIF buffers", async () => {
    const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
    await expect(
      optimizeImageBufferForWebMedia({
        buffer: createGifHeader(1600, 1600),
        contentType: "image/gif",
        maxBytes: 1024,
        imageCompression: { models: [{ maxSidePx: 512 }] },
      }),
    ).rejects.toThrow(/dimensions exceed model image limits/i);
  });

  it.each(["local", "remote"] as const)(
    "preserves the explicit GIF byte cap for optimized %s media",
    async (source) => {
      const buffer = createGifHeader(16, 16);
      const fileName = `explicit-cap-${source}.gif`;
      const filePath = path.join(fixtureRoot, fileName);
      if (source === "local") {
        await fs.writeFile(filePath, buffer);
      }
      const mediaUrl = source === "local" ? filePath : `https://example.test/${fileName}`;
      const sourceOptions =
        source === "local"
          ? { localRoots: [fixtureRoot] }
          : {
              fetchImpl: vi.fn(
                async () =>
                  new Response(Buffer.from(buffer), {
                    status: 200,
                    headers: { "content-type": "image/gif" },
                  }),
              ),
              ssrfPolicy: { allowedHostnames: ["example.test"] },
            };

      await expect(
        loadWebMedia(mediaUrl, { ...sourceOptions, maxBytes: buffer.length - 1 }),
      ).rejects.toThrow(/^GIF exceeds /);
      const result = await loadWebMedia(mediaUrl, {
        ...sourceOptions,
        maxBytes: buffer.length,
      });
      expect(result.buffer).toEqual(buffer);
      expect(result.contentType).toBe("image/gif");
      expect(result.fileName).toBe(fileName);
    },
  );

  it("rejects raw image dimensions instead of applying optimized image policy", async () => {
    const buffer = createLargeColorBlockPng(64);
    const filePath = path.join(fixtureRoot, "raw-dimensions.png");
    await fs.writeFile(filePath, buffer);
    const options = {
      localRoots: [fixtureRoot],
      maxBytes: 1024 * 1024,
      imageCompression: { models: [{ maxSidePx: 32, preferredSidePx: 32 }] },
    };

    await expect(loadWebMediaRaw(filePath, options)).rejects.toThrow(
      /dimensions exceed model image limits/i,
    );
    const optimized = await loadWebMedia(filePath, options);
    expect(optimized.contentType).toBe("image/jpeg");
    expect(readJpegDimensions(optimized.buffer)).toEqual({ width: 32, height: 32 });
  });

  it("renames opaque PNGs converted to JPEG across direct and local image owners", async () => {
    const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
    const sourcePng = createLargeColorBlockPng(64);
    const imageCompression = { models: [{ maxSidePx: 32, preferredSidePx: 32 }] };

    const direct = await optimizeImageBufferForWebMedia({
      buffer: sourcePng,
      contentType: "image/png",
      fileName: "portrait.png",
      maxBytes: 1024 * 1024,
      imageCompression,
    });
    const convertedPath = path.join(fixtureRoot, "portrait.png");
    await fs.writeFile(convertedPath, sourcePng);
    const loaded = await loadWebMedia(convertedPath, {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
      imageCompression,
    });

    for (const result of [direct, loaded]) {
      expect(result.kind).toBe("image");
      expect(result.contentType).toBe("image/jpeg");
      expect(result.fileName).toBe("portrait.jpg");
      expect(result.buffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(readJpegDimensions(result.buffer)).toEqual({ width: 32, height: 32 });
    }
  });

  it("renames transparent WebP images converted to PNG across direct and local image owners", async () => {
    const { optimizeImageBufferForWebMedia } = await import("./web-media.js");
    const sourcePng = createLargeTransparentColorBlockPng(64);
    const sourceWebp = (await createImageProcessor().encode(sourcePng, { format: "webp" })).data;
    const imageCompression = { models: [{ maxSidePx: 32, preferredSidePx: 32 }] };

    const direct = await optimizeImageBufferForWebMedia({
      buffer: sourceWebp,
      contentType: "image/webp",
      fileName: "portrait.WebP",
      maxBytes: 1024 * 1024,
      imageCompression,
    });
    const convertedPath = path.join(fixtureRoot, "portrait.WebP");
    await fs.writeFile(convertedPath, sourceWebp);
    const loaded = await loadWebMedia(convertedPath, {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
      imageCompression,
    });

    for (const result of [direct, loaded]) {
      expect(result.kind).toBe("image");
      expect(result.contentType).toBe("image/png");
      expect(result.fileName).toBe("portrait.png");
      expect(readPngDimensions(result.buffer)).toEqual({ width: 32, height: 32 });
    }
  });

  it("applies model image maxBytes to the effective image cap", async () => {
    await expect(
      loadWebMediaRaw(tinyPngFile, {
        maxBytes: 1024 * 1024,
        localRoots: [fixtureRoot],
        imageCompression: {
          models: [{ maxBytes: 8 }],
        },
      }),
    ).rejects.toThrow("Media exceeds 8B limit");
  });

  it("reports the configured byte cap when image optimization cannot meet it", async () => {
    await expect(
      loadWebMedia(tinyPngFile, { maxBytes: 8, localRoots: [fixtureRoot] }),
    ).rejects.toThrow(/^Media could not be reduced below 8B \(got /);
  });

  it("uses the strictest model image maxBytes across fallback candidates", () => {
    expect(
      effectiveImageBytesCap(16 * 1024 * 1024, {
        models: [{ maxBytes: 8 * 1024 * 1024 }, {}, { maxBytes: 2 * 1024 * 1024 }],
      }),
    ).toBe(2 * 1024 * 1024);
    expect(effectiveImageBytesCap(undefined, { models: [{ maxBytes: 1024 }] })).toBe(1024);
  });

  it("downscales oversized JPEGs to the resolved model side limit before returning media", async () => {
    const sourcePng = createLargeColorBlockPng(1600);
    const sourceJpeg = await resizeToJpeg({
      buffer: sourcePng,
      maxSide: 1600,
      quality: 92,
      withoutEnlargement: true,
    });
    expect(Math.max(...Object.values(readJpegDimensions(sourceJpeg)))).toBe(1600);

    const largeImage = path.join(fixtureRoot, "large-center-red.jpg");
    await fs.writeFile(largeImage, sourceJpeg);
    const result = await loadWebMedia(largeImage, {
      maxBytes: 16 * 1024 * 1024,
      localRoots: [fixtureRoot],
      imageCompression: {
        quality: "high",
        models: [{ maxSidePx: 512, preferredSidePx: 512 }],
      },
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    const dimensions = readJpegDimensions(result.buffer);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(512);
  });

  it("downscales alpha PNGs to the resolved model side limit before returning media", async () => {
    const sourcePng = createLargeTransparentColorBlockPng(1600);
    expect(Math.max(...Object.values(readPngDimensions(sourcePng)))).toBe(1600);

    const largeImage = path.join(fixtureRoot, "large-transparent.png");
    await fs.writeFile(largeImage, sourcePng);
    const result = await loadWebMedia(largeImage, {
      maxBytes: 16 * 1024 * 1024,
      localRoots: [fixtureRoot],
      imageCompression: {
        quality: "high",
        models: [{ maxSidePx: 512, preferredSidePx: 512 }],
      },
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    const dimensions = readPngDimensions(result.buffer);
    expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(512);
  });

  it("uses low default dimensions when model metadata is unavailable", async () => {
    expect(
      resolveImageCompressionGrid({
        quality: "high",
        models: [{}],
      }).sides[0],
    ).toBe(2048);
  });
});
