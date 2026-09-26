// Web media tests cover loading media for web UI and browser surfaces.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expectDefined } from "@openclaw/normalization-core";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withEnvAsync } from "../test-utils/env.js";
let LocalMediaAccessError: typeof import("./web-media.js").LocalMediaAccessError;
let loadWebMedia: typeof import("./web-media.js").loadWebMedia;
let loadWebMediaRaw: typeof import("./web-media.js").loadWebMediaRaw;

const TINY_PNG_BUFFER = createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 });
const TINY_PNG_BASE64 = TINY_PNG_BUFFER.toString("base64");
const CANVAS_HOST_PATH = "/__openclaw__/canvas";

let fixtureRoot = "";
let tinyPngFile = "";
let stateDir = "";
let canvasPngFile = "";
let workspaceDir = "";
let workspacePngFile = "";

beforeAll(async () => {
  ({ LocalMediaAccessError, loadWebMedia, loadWebMediaRaw } = await import("./web-media.js"));
  fixtureRoot = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "web-media-core-"));
  tinyPngFile = path.join(fixtureRoot, "tiny.png");
  await fs.writeFile(tinyPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  workspaceDir = path.join(fixtureRoot, "workspace");
  workspacePngFile = path.join(workspaceDir, "chart.png");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(workspacePngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  stateDir = resolveStateDir();
  canvasPngFile = path.join(
    stateDir,
    "canvas",
    "documents",
    "cv_test",
    "collection.media",
    "tiny.png",
  );
  await fs.mkdir(path.dirname(canvasPngFile), { recursive: true });
  await fs.writeFile(canvasPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
});

afterAll(async () => {
  try {
    resetPluginRuntimeStateForTest();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
    if (stateDir) {
      await fs.rm(path.join(stateDir, "canvas", "documents", "cv_test"), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    vi.resetModules();
  }
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

describe("loadWebMedia", () => {
  function makeStallingFetch(firstChunk: Uint8Array) {
    return vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk);
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/pdf" },
          },
        ),
    );
  }

  async function expectWebMediaIdleTimeout(
    createLoadPromise: () => Promise<unknown>,
    idleTimeoutMs: number,
  ) {
    vi.useFakeTimers();
    try {
      const outcome = createLoadPromise().then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await vi.advanceTimersByTimeAsync(idleTimeoutMs + 5);
      await expect(
        Promise.race([outcome, Promise.resolve({ status: "pending" as const })]),
      ).resolves.toMatchObject({ status: "rejected" });
      const result = await outcome;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.error)).toMatch(/stalled|no data received/i);
      }
    } finally {
      vi.useRealTimers();
    }
  }

  function createLocalWebMediaOptions() {
    return {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
    };
  }

  async function expectRejectedWebMedia(
    url: string,
    expectedError: Record<string, unknown> | RegExp,
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined,
  ) {
    const restoreHandle = setup?.();
    try {
      if (expectedError instanceof RegExp) {
        await expect(loadWebMedia(url, createLocalWebMediaOptions())).rejects.toThrow(
          expectedError,
        );
        return;
      }
      await expectLoadWebMediaErrorFields(
        loadWebMedia(url, createLocalWebMediaOptions()),
        expectedError,
      );
    } finally {
      restoreHandle?.mockRestore?.();
      restoreHandle?.restore?.();
    }
  }

  async function expectLoadWebMediaErrorFields(
    promise: Promise<unknown>,
    expectedFields: Record<string, unknown>,
  ) {
    let mediaError: unknown;
    try {
      await promise;
    } catch (error) {
      mediaError = error;
    }
    expect(mediaError).toBeInstanceOf(LocalMediaAccessError);
    if (!(mediaError instanceof LocalMediaAccessError)) {
      throw new Error("expected LocalMediaAccessError");
    }
    for (const [key, value] of Object.entries(expectedFields)) {
      expect(Reflect.get(mediaError, key)).toStrictEqual(value);
    }
  }

  async function expectLoadWebMediaErrorCode(promise: Promise<unknown>, code: string) {
    await expectLoadWebMediaErrorFields(promise, { code });
  }

  async function expectRejectedWebMediaWithoutFilesystemAccess(params: {
    url: string;
    expectedError: Record<string, unknown> | RegExp;
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined;
  }) {
    const realpathSpy = vi.spyOn(fs, "realpath");
    try {
      await expectRejectedWebMedia(params.url, params.expectedError, params.setup);
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  }

  async function expectLoadedWebMediaCase(url: string) {
    const result = await loadWebMedia(url, createLocalWebMediaOptions());
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  }

  it.each(["local", "localhost"])(
    "loads encoded %s file URLs from reply directives",
    async (host) => {
      const fileName = "café 100% image.png";
      const filePath = path.join(fixtureRoot, fileName);
      await fs.writeFile(filePath, TINY_PNG_BUFFER);
      const fileUrl = pathToFileURL(filePath).href.replace(
        /^file:\/\//u,
        host === "localhost" ? "file://localhost" : "FILE:",
      );
      const reply = parseReplyDirectives(`Here is your image.\nMEDIA:${fileUrl}`);

      expect(reply.text).toBe("Here is your image.");
      expect(reply.mediaUrls).toHaveLength(1);
      const mediaUrl = expectDefined(reply.mediaUrls?.[0], "parsed file URL attachment");
      const media = await loadWebMedia(mediaUrl, createLocalWebMediaOptions());
      expect(media.buffer).toEqual(TINY_PNG_BUFFER);
      expect(media.fileName).toBe(fileName);
      expect(media.contentType).toBe("image/png");
    },
  );

  it.each([
    "file://remote.example/share/image.png",
    "file:///tmp/image%2Fname.png",
    "file:///tmp/image%5Cname.png",
    "file:///tmp/image%GG.png",
  ])("keeps native file URL validation after reply parsing: %s", async (fileUrl) => {
    const reply = parseReplyDirectives(`MEDIA:${fileUrl}`);
    const mediaUrl = expectDefined(reply.mediaUrls?.[0], "parsed file URL attachment");
    await expect(loadWebMedia(mediaUrl, createLocalWebMediaOptions())).rejects.toMatchObject({
      code: "invalid-file-url",
    });
  });

  it.each([
    {
      name: "allows localhost file URLs for local files",
      createUrl: () => {
        const fileUrl = pathToFileURL(tinyPngFile);
        fileUrl.hostname = "localhost";
        return fileUrl.href;
      },
    },
  ] as const)("$name", async ({ createUrl }) => {
    await expectLoadedWebMediaCase(createUrl());
  });

  it.each([
    {
      name: "rejects remote-host file URLs before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: { code: "invalid-file-url" },
    },
    {
      name: "rejects remote-host file URLs with the explicit error message before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: /remote hosts are not allowed/i,
    },
    {
      name: "rejects Windows network paths before filesystem checks",
      url: "\\\\attacker\\share\\evil.png",
      expectedError: { code: "network-path-not-allowed" },
      setup: () => vi.spyOn(process, "platform", "get").mockReturnValue("win32"),
    },
  ] as const)("$name", async (testCase) => {
    await expectRejectedWebMediaWithoutFilesystemAccess(testCase);
  });

  it("loads browser-style canvas media paths as managed local files", async () => {
    const result = await loadWebMedia(
      `${CANVAS_HOST_PATH}/documents/cv_test/collection.media/tiny.png`,
      { maxBytes: 1024 * 1024 },
    );
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("keeps trying hosted media resolvers after one throws", async () => {
    const registry = createEmptyPluginRegistry();
    registry.hostedMediaResolvers = [
      {
        pluginId: "broken",
        resolver: () => {
          throw new Error("resolver failed");
        },
        source: "test",
      },
      {
        pluginId: "hosted-media",
        resolver: (mediaUrl) => (mediaUrl === "/__test__/hosted/tiny.png" ? canvasPngFile : null),
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const result = await loadWebMedia("/__test__/hosted/tiny.png", { maxBytes: 1024 * 1024 });

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("resolves hosted media from the request registry, including an empty selection", async () => {
    const mediaUrl = "/__test__/scoped-hosted-media";
    const files = [
      path.join(fixtureRoot, "owner-a.txt"),
      path.join(fixtureRoot, "owner-b.txt"),
    ] as const;
    await Promise.all(files.map((file, index) => fs.writeFile(file, `OWNER_${index}`)));
    const selected = createEmptyPluginRegistry();
    selected.hostedMediaResolvers.push({
      pluginId: "scoped-owner",
      source: "test",
      resolver: (url) => (url === mediaUrl ? files[0] : null),
    });
    const active = createEmptyPluginRegistry();
    const activeResolver = vi.fn((url: string) => (url === mediaUrl ? files[1] : null));
    active.hostedMediaResolvers.push({
      pluginId: "global-owner",
      source: "test",
      resolver: activeResolver,
    });
    setActivePluginRegistry(active);
    try {
      expect((await loadWebMediaRaw(mediaUrl)).buffer.toString()).toBe("OWNER_1");
      const scoped = await withPluginRuntimeRegistryScope(selected, () =>
        loadWebMediaRaw(mediaUrl),
      );
      expect(scoped.buffer.toString()).toBe("OWNER_0");
      await expect(
        withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
          loadWebMediaRaw(mediaUrl),
        ),
      ).rejects.toBeInstanceOf(LocalMediaAccessError);
      expect(activeResolver).toHaveBeenCalledTimes(1);
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("resolves relative local media paths against the provided workspace directory", async () => {
    const result = await loadWebMedia("chart.png", {
      maxBytes: 1024 * 1024,
      localRoots: [workspaceDir],
      workspaceDir,
    });
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it.each([
    { maxBytes: 1024 * 1024, expectedLimit: "1MB" },
    { maxBytes: 256 * 1024, expectedLimit: "256KB" },
    { maxBytes: 1.5 * 1024 * 1024, expectedLimit: "1.50MB" },
  ])(
    "rejects oversized local media before an unbounded file-handle read ($expectedLimit)",
    async ({ maxBytes, expectedLimit }) => {
      const oversizedFile = path.join(fixtureRoot, "oversized.bin");
      await fs.writeFile(oversizedFile, Buffer.alloc(maxBytes + 1));
      let unboundedReadCalled = false;
      __setFsSafeTestHooksForTest({
        afterOpen: (filePath, handle) => {
          if (filePath !== oversizedFile) {
            return;
          }
          vi.spyOn(handle, "readFile").mockImplementation(async () => {
            unboundedReadCalled = true;
            throw new Error("unbounded read invoked");
          });
        },
      });

      await expect(
        loadWebMediaRaw(oversizedFile, {
          maxBytes,
          localRoots: [fixtureRoot],
        }),
      ).rejects.toThrow(`Media exceeds ${expectedLimit} limit`);
      expect(unboundedReadCalled).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local media when an allowed ancestor symlink retargets before open",
    async () => {
      const base = await fs.mkdtemp(path.join(fixtureRoot, "ancestor-race-"));
      const allowedRoot = path.join(base, "allowed");
      const insideDir = path.join(allowedRoot, "inside");
      const outsideDir = path.join(base, "outside");
      const aliasDir = path.join(allowedRoot, "slot");
      const mediaPath = path.join(aliasDir, "image.png");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "image.png"), TINY_PNG_BUFFER);
      await fs.writeFile(
        path.join(outsideDir, "image.png"),
        createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 }),
      );
      await fs.symlink(insideDir, aliasDir);
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (filePath) => {
          if (filePath !== mediaPath) {
            return;
          }
          await fs.rm(aliasDir);
          await fs.symlink(outsideDir, aliasDir);
        },
      });

      try {
        await expect(
          loadWebMediaRaw(mediaPath, {
            maxBytes: 1024 * 1024,
            localRoots: [allowedRoot],
            optimizeImages: false,
          }),
        ).rejects.toMatchObject({ code: "path-not-allowed" });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );

  it("keeps the one-argument contract for custom local readers", async () => {
    const maxBytes = 1024 * 1024;
    const readFile = vi.fn(async (_filePath: string) => Buffer.from(TINY_PNG_BASE64, "base64"));

    await loadWebMediaRaw("/sandbox/image.png", {
      maxBytes,
      sandboxValidated: true,
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith("/sandbox/image.png");
    expect(readFile.mock.calls[0]).toHaveLength(1);
  });

  it("does not treat image-named generic container bytes as local image media", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const fakeImage = path.join(fixtureRoot, "fake.png");
    await fs.writeFile(fakeImage, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await loadWebMedia(fakeImage, createLocalWebMediaOptions());

    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("application/zip");
    expect(result.fileName).toBe("fake.png");
  });

  it("strips internal media-store UUID suffix from outbound fileName", async () => {
    const stagedName = "report---a1b2c3d4-5678-90ab-cdef-1234567890ab.png";
    const mediaDir = path.join(stateDir, "media", "outbound");
    const stagedFile = path.join(mediaDir, stagedName);
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(stagedFile, Buffer.from(TINY_PNG_BASE64, "base64"));

    const result = await loadWebMedia(stagedFile, {
      maxBytes: 1024 * 1024,
      localRoots: [mediaDir],
    });

    expect(result.fileName).toBe("report.png");
  });

  it("preserves non-media-store filenames that match the UUID suffix shape", async () => {
    const fileName = "report---a1b2c3d4-5678-90ab-cdef-1234567890ab.png";
    const filePath = path.join(fixtureRoot, fileName);
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const result = await loadWebMedia(filePath, createLocalWebMediaOptions());

    expect(result.fileName).toBe(fileName);
  });

  it("uses only the leaf filename from Windows-style sandbox-validated media paths", async () => {
    const result = await loadWebMedia(String.raw`C:\workspace\captures\tiny.png`, {
      maxBytes: 1024 * 1024,
      sandboxValidated: true,
      readFile: async () => Buffer.from(TINY_PNG_BASE64, "base64"),
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.fileName).toBe("tiny.png");
  });

  it("resolves home-relative local media paths through allowed local roots", async () => {
    await withEnvAsync({ OPENCLAW_HOME: fixtureRoot }, async () => {
      const result = await loadWebMedia("~/workspace/chart.png", {
        maxBytes: 1024 * 1024,
        localRoots: [workspaceDir],
      });
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    });
  });

  it("rejects traversal-style canvas media paths before filesystem access", async () => {
    await expectLoadWebMediaErrorCode(
      loadWebMedia(`${CANVAS_HOST_PATH}/documents/../collection.media/tiny.png`),
      "path-not-allowed",
    );
  });

  it("hydrates inbound media store URIs before allowed-root checks", async () => {
    const id = `signal-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await loadWebMedia(`media://inbound/${id}`, {
        maxBytes: 1024 * 1024,
      });

      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(id);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  // Swap at open 2 trips the hardlink guard (invalid-path); swap at open 3 trips
  // the fs-safe pre-open identity re-check, an access denial (path-not-allowed).
  it.runIf(process.platform !== "win32").each([
    [2, "invalid-path"],
    [3, "path-not-allowed"],
  ] as const)(
    "rejects an inbound media store URI swapped to a hardlink on guarded open %s",
    async (swapOpen, expectedCode) => {
      const id = `signal-hardlink-race-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
      const filePath = path.join(stateDir, "media", "inbound", id);
      const outsidePath = path.join(stateDir, `${id}.outside`);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "inside");
      await fs.writeFile(outsidePath, "outside-secret");
      let matchingOpens = 0;
      let linkCreated = false;
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (openedPath) => {
          if (path.basename(openedPath) !== id) {
            return;
          }
          matchingOpens += 1;
          if (matchingOpens !== swapOpen) {
            return;
          }
          await fs.rm(filePath);
          await fs.link(outsidePath, filePath);
          linkCreated = true;
        },
      });

      try {
        await expectLoadWebMediaErrorCode(
          loadWebMediaRaw(`media://inbound/${id}`, { maxBytes: 1024 }),
          expectedCode,
        );
        expect(matchingOpens).toBe(swapOpen);
        expect(linkCreated).toBe(true);
      } finally {
        await fs.rm(filePath, { force: true });
        await fs.rm(outsidePath, { force: true });
      }
    },
  );

  it("accepts legacy MEDIA prefixes around inbound media store URIs", async () => {
    const id = `signal-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await loadWebMedia(`  media :  media://inbound/${id}`, {
        maxBytes: 1024 * 1024,
      });

      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(id);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("allows managed inbound absolute paths before allowed-root checks", async () => {
    const id = `signal-path-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await loadWebMedia(filePath, {
        maxBytes: 1024 * 1024,
        localRoots: [],
      });

      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(id);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("bounds explicit-cap image fetches at the optimize headroom, not the document cap", async () => {
    // 30MB declared original: over the 24MB image-optimize headroom but well
    // under the old 100MB document bound. The Content-Length precheck must
    // reject before any body bytes are read.
    const declaredBytes = 30 * 1024 * 1024;
    const fetchImpl = vi.fn(
      async () =>
        new Response(new ReadableStream<Uint8Array>(), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(declaredBytes),
          },
        }),
    );

    await expect(
      loadWebMedia("https://example.test/huge.png", {
        maxBytes: 5 * 1024 * 1024,
        fetchImpl,
        ssrfPolicy: { allowedHostnames: ["example.test"] },
      }),
    ).rejects.toThrow(/exceeds maxBytes/);
  });

  it("keeps compression headroom above an explicit cap for oversized originals", async () => {
    // A 10MB-declared image is over the caller's 5MB cap but inside the
    // optimize headroom: the fetch must proceed so compression can shrink it
    // under the delivery cap.
    const original = createSolidPngBuffer(64, 64, { r: 12, g: 34, b: 56 });
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from(original), {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(10 * 1024 * 1024),
          },
        }),
    );

    const result = await loadWebMedia("https://example.test/photo.png", {
      maxBytes: 5 * 1024 * 1024,
      fetchImpl,
      ssrfPolicy: { allowedHostnames: ["example.test"] },
    });

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it("applies the shared remote read idle timeout for raw web media loads", async () => {
    const readIdleTimeoutMs = 20;
    const fetchImpl = makeStallingFetch(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    await expectWebMediaIdleTimeout(
      () =>
        loadWebMediaRaw("https://example.test/stalled.pdf", {
          maxBytes: 1024 * 1024,
          fetchImpl,
          readIdleTimeoutMs,
          ssrfPolicy: { allowedHostnames: ["example.test"] },
        }),
      readIdleTimeoutMs,
    );
  });

  it("loads a valid remote PDF when the raw web media read stays active", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Buffer.from("%PDF-1.4\n%%EOF"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );

    const result = await loadWebMediaRaw("https://example.test/ok.pdf", {
      maxBytes: 1024 * 1024,
      fetchImpl,
      readIdleTimeoutMs: 20,
      ssrfPolicy: { allowedHostnames: ["example.test"] },
    });

    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("application/pdf");
    expect(result.buffer.toString()).toContain("%PDF-1.4");
  });

  it("rejects unsupported media store URI locations", async () => {
    await expectLoadWebMediaErrorCode(
      loadWebMedia("media://outbound/tiny.png"),
      "path-not-allowed",
    );
  });

  it("rejects media store URI ids with encoded path separators", async () => {
    await expectLoadWebMediaErrorCode(
      loadWebMedia("media://inbound/nested%2Ftiny.png"),
      "invalid-path",
    );
  });

  it("rejects media store URIs without an id", async () => {
    await expectLoadWebMediaErrorCode(loadWebMedia("media://inbound/"), "invalid-path");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
