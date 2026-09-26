// Host-read document and trusted generated HTML boundary tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../test-utils/env.js";

let loadWebMedia: typeof import("./web-media.js").loadWebMedia;
let LocalMediaAccessError: typeof import("./web-media.js").LocalMediaAccessError;
let fixtureRoot = "";
let workspaceDir = "";

beforeAll(async () => {
  ({ loadWebMedia, LocalMediaAccessError } = await import("./web-media.js"));
  fixtureRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "web-media-host-read-"),
  );
  workspaceDir = path.join(fixtureRoot, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe("loadWebMedia host-read", () => {
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
  async function loadDocumentWithHostRead(fileName: string, body: Buffer | string) {
    const textFile = path.join(fixtureRoot, fileName);
    await fs.writeFile(textFile, body);
    return loadWebMedia(textFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
  }

  async function createXlsmMimeFixture() {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
    );
    zip.file(
      "xl/workbook.xml",
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
    );
    return await zip.generateAsync({ type: "nodebuffer" });
  }

  it.each([
    { fileName: "spin.m", body: "function y = spin(x)\ny = x;\nend\n", mime: "text/x-matlab" },
    { fileName: "paper.tex", body: "\\documentclass{article}\n", mime: "text/x-tex" },
    { fileName: "refs.bib", body: "@article{k1, title={T}}\n", mime: "text/x-bibtex" },
    { fileName: "macros.sty", body: "\\ProvidesPackage{macros}\n", mime: "text/x-tex" },
  ])(
    "HF-04: host-read accepts $fileName as a plain-text document",
    async ({ fileName, body, mime }) => {
      const loaded = await loadDocumentWithHostRead(fileName, body);
      expect(loaded.kind).toBe("document");
      expect(loaded.contentType).toBe(mime);
    },
  );
  it("allows validated host-read TXT files", async () => {
    const txtFile = path.join(fixtureRoot, "notes.txt");
    await fs.writeFile(txtFile, "plain text\n", "utf8");
    const result = await loadWebMedia(txtFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/plain");
  });

  it("rejects host-read LOG files even though they map to text/plain", async () => {
    const logFile = path.join(fixtureRoot, "debug.log");
    await fs.writeFile(logFile, "plain text\n", "utf8");
    await expect(
      loadWebMedia(logFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("rejects renamed host-read text files even when the extension looks allowed", async () => {
    const disguisedPdf = path.join(fixtureRoot, "secret.pdf");
    await fs.writeFile(disguisedPdf, "secret", "utf8");
    await expectLoadWebMediaErrorCode(
      loadWebMedia(disguisedPdf, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each(["report.xlsm", "report.XLSM"])(
    "allows byte-verified host-read XLSM without changing %s or its bytes",
    async (fileName) => {
      const body = await createXlsmMimeFixture();
      const result = await loadDocumentWithHostRead(fileName, body);

      expect(result.kind).toBe("document");
      expect(result.contentType).toBe("application/vnd.ms-excel.sheet.macroenabled.12");
      expect(result.fileName).toBe(fileName);
      expect(result.buffer).toEqual(body);
    },
  );

  it("rejects unverified text named as a host-read XLSM file", async () => {
    await expectLoadWebMediaErrorCode(
      loadDocumentWithHostRead("report.xlsm", "not a workbook"),
      "path-not-allowed",
    );
  });

  it("keeps the host-read XLSM root boundary and byte limit", async () => {
    const body = await createXlsmMimeFixture();
    const filePath = path.join(fixtureRoot, "bounded.xlsm");
    await fs.writeFile(filePath, body);
    const readFile = vi.fn((sourcePath: string) => fs.readFile(sourcePath));

    await expectLoadWebMediaErrorCode(
      loadWebMedia(filePath, {
        localRoots: [workspaceDir],
        readFile,
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
    expect(readFile).not.toHaveBeenCalled();
    await expect(
      loadWebMedia(filePath, {
        maxBytes: body.length - 1,
        localRoots: [fixtureRoot],
        readFile,
        hostReadCapability: true,
      }),
    ).rejects.toThrow(/exceeds.*limit/i);
  });

  it("allows host-read CSV files", async () => {
    const csvFile = path.join(fixtureRoot, "data.csv");
    await fs.writeFile(csvFile, "name,value\nfoo,1\nbar,2\n", "utf8");
    const result = await loadWebMedia(csvFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/csv");
  });

  it("allows host-read Markdown files", async () => {
    const mdFile = path.join(fixtureRoot, "notes.md");
    await fs.writeFile(mdFile, "# Title\n\nSome **bold** text.\n", "utf8");
    const result = await loadWebMedia(mdFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/markdown");
  });

  it("allows trusted generated host-read HTML reports under OpenClaw temp root", async () => {
    const htmlFile = path.join(fixtureRoot, "report.html");
    await fs.writeFile(htmlFile, "<!doctype html><title>Report</title><h1>Report</h1>\n", "utf8");
    const result = await loadWebMedia(htmlFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/html");
  });

  it("allows exact marked outbound HTML bytes and rejects same-size replacements", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-state-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
        const { saveMediaBuffer } = await import("./store.js");
        const { markTrustedGeneratedHtmlPath } = await import("./web-media.js");
        const original = Buffer.from("<!doctype html><h1>A</h1>", "utf8");
        const replacement = Buffer.from("<!doctype html><h1>B</h1>", "utf8");
        expect(replacement.length).toBe(original.length);
        const saved = await saveMediaBuffer(
          original,
          "text/html",
          "outbound",
          1024 * 1024,
          "report.html",
        );
        await markTrustedGeneratedHtmlPath(saved.path, original);

        const allowed = await loadWebMedia(saved.path, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        });
        expect(allowed.buffer).toEqual(original);
        expect(allowed.trustedGeneratedHtmlSource).toBe(true);

        await fs.writeFile(saved.path, replacement);
        await expectLoadWebMediaErrorCode(
          loadWebMedia(saved.path, {
            maxBytes: 1024 * 1024,
            localRoots: "any",
            readFile: async (filePath) => await fs.readFile(filePath),
            hostReadCapability: true,
          }),
          "path-not-allowed",
        );
      });
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects unmarked outbound HTML", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-state-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
        const { saveMediaBuffer } = await import("./store.js");
        const saved = await saveMediaBuffer(
          Buffer.from("<!doctype html><h1>untrusted</h1>", "utf8"),
          "text/html",
          "outbound",
          1024 * 1024,
          "report.html",
        );
        await expectLoadWebMediaErrorCode(
          loadWebMedia(saved.path, {
            maxBytes: 1024 * 1024,
            localRoots: "any",
            readFile: async (filePath) => await fs.readFile(filePath),
            hostReadCapability: true,
          }),
          "path-not-allowed",
        );
      });
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("requires a marker when outbound staging is nested under the trusted temp root", async () => {
    const stateRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "web-media-overlap-state-"),
    );
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
        const { saveMediaBuffer } = await import("./store.js");
        const saved = await saveMediaBuffer(
          Buffer.from("<!doctype html><h1>unmarked overlap</h1>", "utf8"),
          "text/html",
          "outbound",
          1024 * 1024,
          "report.html",
        );
        expect(path.resolve(saved.path)).toContain(path.resolve(resolvePreferredOpenClawTmpDir()));
        await expectLoadWebMediaErrorCode(
          loadWebMedia(saved.path, {
            maxBytes: 1024 * 1024,
            localRoots: "any",
            readFile: async (filePath) => await fs.readFile(filePath),
            hostReadCapability: true,
          }),
          "path-not-allowed",
        );
      });
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("prunes markers whose staged file was removed", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-state-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
        const { saveMediaBuffer } = await import("./store.js");
        const { markTrustedGeneratedHtmlPath, pruneStaleTrustedGeneratedHtmlMarkers } =
          await import("./web-media.js");
        const html = Buffer.from("<!doctype html><h1>report</h1>", "utf8");
        const saved = await saveMediaBuffer(
          html,
          "text/html",
          "outbound",
          1024 * 1024,
          "report.html",
        );
        await markTrustedGeneratedHtmlPath(saved.path, html);
        await fs.rm(saved.path);
        await pruneStaleTrustedGeneratedHtmlMarkers();
        await fs.writeFile(saved.path, html);

        await expectLoadWebMediaErrorCode(
          loadWebMedia(saved.path, {
            maxBytes: 1024 * 1024,
            localRoots: "any",
            readFile: async (filePath) => await fs.readFile(filePath),
            hostReadCapability: true,
          }),
          "path-not-allowed",
        );
      });
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("keeps markers when filesystem inspection fails transiently", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-state-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
        const { saveMediaBuffer } = await import("./store.js");
        const { markTrustedGeneratedHtmlPath, pruneStaleTrustedGeneratedHtmlMarkers } =
          await import("./web-media.js");
        const html = Buffer.from("<!doctype html><h1>report</h1>", "utf8");
        const saved = await saveMediaBuffer(
          html,
          "text/html",
          "outbound",
          1024 * 1024,
          "report.html",
        );
        await markTrustedGeneratedHtmlPath(saved.path, html);
        const lstatSpy = vi
          .spyOn(fs, "lstat")
          .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EMFILE" }));
        try {
          await pruneStaleTrustedGeneratedHtmlMarkers();
        } finally {
          lstatSpy.mockRestore();
        }

        const result = await loadWebMedia(saved.path, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        });
        expect(result.buffer).toEqual(html);
      });
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("prunes more stale markers than one SQLite parameter batch", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-state-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
        const { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
          await import("../infra/kysely-sync.js");
        const { openOpenClawStateDatabase, runOpenClawStateWriteTransaction } =
          await import("../state/openclaw-state-db.js");
        const { pruneStaleTrustedGeneratedHtmlMarkers } = await import("./web-media.js");
        type ProvenanceDb = {
          outbound_media_provenance: {
            realpath: string;
            kind: string;
            version: number;
            sha256: string;
            size_bytes: number;
            created_at_ms: number;
          };
        };
        runOpenClawStateWriteTransaction(({ db }) => {
          const kysely = getNodeSqliteKysely<ProvenanceDb>(db);
          for (let index = 0; index < 1_001; index += 1) {
            executeSqliteQuerySync(
              db,
              kysely.insertInto("outbound_media_provenance").values({
                realpath: path.join(stateRoot, `missing-${index}.html`),
                kind: "trusted-generated-html",
                version: 1,
                sha256: "0".repeat(64),
                size_bytes: 1,
                created_at_ms: 1,
              }),
            );
          }
        });

        await pruneStaleTrustedGeneratedHtmlMarkers();

        const { db } = openOpenClawStateDatabase();
        const count = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<ProvenanceDb>(db)
            .selectFrom("outbound_media_provenance")
            .select(({ fn }) => fn.countAll<number>().as("count")),
        );
        expect(Number(count?.count)).toBe(0);
      });
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses to mark paths outside outbound staging", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-marker-outside-"));
    const outsideFile = path.join(outsideRoot, "report.html");
    await fs.writeFile(outsideFile, "<!doctype html><h1>outside</h1>", "utf8");
    try {
      const { markTrustedGeneratedHtmlPath } = await import("./web-media.js");
      await expect(
        markTrustedGeneratedHtmlPath(outsideFile, await fs.readFile(outsideFile)),
      ).rejects.toThrow(/outside outbound staging/i);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects host-read HTML files outside the trusted OpenClaw temp root", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-host-html-"));
    const htmlFile = path.join(outsideRoot, "report.html");
    await fs.writeFile(htmlFile, "<!doctype html><title>Report</title><h1>Report</h1>\n", "utf8");
    try {
      await expectLoadWebMediaErrorCode(
        loadWebMedia(htmlFile, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects trusted host-read HTML symlinks that resolve outside OpenClaw temp root", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-host-html-"));
    const outsideHtml = path.join(outsideRoot, "report.html");
    const htmlLink = path.join(fixtureRoot, "linked-report.html");
    await fs.writeFile(
      outsideHtml,
      "<!doctype html><title>Outside</title><body>secret</body>\n",
      "utf8",
    );
    try {
      await fs.symlink(outsideHtml, htmlLink);
    } catch (error) {
      await fs.rm(outsideRoot, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }
    try {
      await expectLoadWebMediaErrorCode(
        loadWebMedia(htmlLink, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    } finally {
      await fs.rm(htmlLink, { force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects trusted host-read HTML hardlinks to files outside OpenClaw temp root", async () => {
    const outsideRoot = await fs.mkdtemp(
      path.join(path.dirname(resolvePreferredOpenClawTmpDir()), "web-media-host-html-"),
    );
    const outsideHtml = path.join(outsideRoot, "report.html");
    const htmlLink = path.join(fixtureRoot, "hardlinked-report.html");
    await fs.writeFile(
      outsideHtml,
      "<!doctype html><title>Outside</title><body>secret</body>\n",
      "utf8",
    );
    try {
      await fs.link(outsideHtml, htmlLink);
    } catch (error) {
      await fs.rm(outsideRoot, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw error;
    }
    try {
      await expectLoadWebMediaErrorCode(
        loadWebMedia(htmlLink, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    } finally {
      await fs.rm(htmlLink, { force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects trusted host-read HTML paths without HTML document shape", async () => {
    const htmlFile = path.join(fixtureRoot, "report.html");
    await fs.writeFile(htmlFile, "status,value\nok,1\n", "utf8");
    await expectLoadWebMediaErrorCode(
      loadWebMedia(htmlFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    {
      label: "ZIP",
      fileName: "archive.zip",
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      contentType: "application/zip",
    },
    {
      label: "gzip",
      fileName: "archive.gz",
      body: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0x03]),
      contentType: "application/gzip",
    },
    {
      label: "tar",
      fileName: "archive.tar",
      body: (() => {
        const buffer = Buffer.alloc(512);
        buffer.write("ustar", 257, "ascii");
        return buffer;
      })(),
      contentType: "application/x-tar",
    },
    {
      label: "7z",
      fileName: "archive.7z",
      body: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]),
      contentType: "application/x-7z-compressed",
    },
    {
      label: "JSON",
      fileName: "data.json",
      body: '{"ok":true}\n',
      contentType: "application/json",
    },
    {
      label: "YAML",
      fileName: "config.yaml",
      body: "ok: true\n",
      contentType: "application/yaml",
    },
    {
      label: "YML",
      fileName: "config.yml",
      body: "ok: true\n",
      contentType: "application/yaml",
    },
  ])("allows host-read $label files", async ({ fileName, body, contentType }) => {
    const result = await loadDocumentWithHostRead(fileName, body);
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe(contentType);
  });

  it("rejects binary data disguised as a CSV file", async () => {
    const fakeCsv = path.join(fixtureRoot, "evil.csv");
    // Declared plain-text aliases must use the text validator path even when the
    // buffer sniffs as an otherwise allowed archive type.
    await fs.writeFile(fakeCsv, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeCsv, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "opaque.csv" },
    { label: "HTML", fileName: "opaque.html" },
    { label: "Markdown", fileName: "opaque.md" },
    { label: "TXT", fileName: "opaque.txt" },
    { label: "JSON", fileName: "opaque.json" },
    { label: "YAML", fileName: "opaque.yaml" },
    { label: "YML", fileName: "opaque.yml" },
  ])("rejects opaque non-NUL binary data disguised as $label", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    const opaqueBinary = Buffer.alloc(9000);
    for (let i = 0; i < opaqueBinary.length; i += 1) {
      opaqueBinary[i] = (i % 255) + 1;
    }
    await fs.writeFile(fakeTextFile, opaqueBinary);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "prefix-tail.csv" },
    { label: "HTML", fileName: "prefix-tail.html" },
    { label: "Markdown", fileName: "prefix-tail.md" },
  ])(
    "rejects %s files with a text prefix and binary tail after the old sample window",
    async ({ fileName }) => {
      const fakeTextFile = path.join(fixtureRoot, fileName);
      const textPrefix = Buffer.from(`name,value\n${"row,1\n".repeat(1400)}`, "utf8");
      expect(textPrefix.length).toBeGreaterThan(8192);
      const binaryTail = Buffer.from([0x00, 0xff, 0x10, 0x80]);
      await fs.writeFile(fakeTextFile, Buffer.concat([textPrefix, binaryTail]));
      await expectLoadWebMediaErrorCode(
        loadWebMedia(fakeTextFile, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
        "path-not-allowed",
      );
    },
  );

  it.each([
    {
      label: "CSV",
      fileName: "punctuation.csv",
      contentType: "text/csv",
      body: ",,,,,,,,,,\n",
    },
    {
      label: "Markdown",
      fileName: "punctuation.md",
      contentType: "text/markdown",
      body: "---\n***\n> > >\n",
    },
  ])(
    "loads valid punctuation-heavy %s files when host-read capability is enabled",
    async ({ fileName, contentType, body }) => {
      const result = await loadDocumentWithHostRead(fileName, Buffer.from(body, "utf8"));
      expect(result.kind).toBe("document");
      expect(result.contentType).toBe(contentType);
    },
  );

  it.each([
    {
      label: "CSV",
      fileName: "legacy.csv",
      contentType: "text/csv",
      body: Buffer.from("caf\xe9,ni\xf1o\n", "latin1"),
    },
    {
      label: "Markdown",
      fileName: "legacy.md",
      contentType: "text/markdown",
      body: Buffer.from("R\xe9sum\xe9\nni\xf1o\n", "latin1"),
    },
  ])(
    "loads valid single-byte encoded %s files when host-read capability is enabled",
    async ({ fileName, contentType, body }) => {
      const result = await loadDocumentWithHostRead(fileName, body);
      expect(result.kind).toBe("document");
      expect(result.contentType).toBe(contentType);
    },
  );

  it.each([
    { label: "CSV", fileName: "nul-padded.csv" },
    { label: "HTML", fileName: "nul-padded.html" },
    { label: "Markdown", fileName: "nul-padded.md" },
  ])("rejects NUL-padded binary data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // Alternating 0x00/0xFF — UTF-8 decode fails (0xFF is invalid UTF-8), then
    // hasSingleByteTextShape rejects because 0x00 bytes are control chars (< 0x20).
    const nulPadded = Buffer.alloc(9000);
    for (let i = 0; i < nulPadded.length; i += 1) {
      nulPadded[i] = i % 2 === 0 ? 0x00 : 0xff;
    }
    await fs.writeFile(fakeTextFile, nulPadded);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "bom-binary.csv" },
    { label: "HTML", fileName: "bom-binary.html" },
    { label: "Markdown", fileName: "bom-binary.md" },
  ])("rejects UTF-16 BOM-prefixed binary data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // UTF-16LE BOM + repeating 0xFF bytes: if UTF-16 decoding were attempted,
    // every byte pair would produce a printable code point and pass getTextStats.
    // With UTF-16 decoding removed, falls through to UTF-8 strict decode (throws
    // on 0xFF), then hasSingleByteTextShape rejects due to high-byte ratio > 30%.
    const bom = Buffer.from([0xff, 0xfe]);
    const garbage = Buffer.alloc(9000, 0xff);
    await fs.writeFile(fakeTextFile, Buffer.concat([bom, garbage]));
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "alternating-high.csv" },
    { label: "HTML", fileName: "alternating-high.html" },
    { label: "Markdown", fileName: "alternating-high.md" },
  ])("rejects alternating ASCII/high-byte data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // Alternating 0x41 ('A') and 0xFF — exactly 50% ASCII, 50% high bytes.
    // With the old 50% threshold hasSingleByteTextShape would accept this;
    // the tightened 70%/30% thresholds must reject it.
    const mixed = Buffer.alloc(9000);
    for (let i = 0; i < mixed.length; i += 1) {
      mixed[i] = i % 2 === 0 ? 0x41 : 0xff;
    }
    await fs.writeFile(fakeTextFile, mixed);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });

  it.each([
    { label: "CSV", fileName: "high-bytes.csv" },
    { label: "HTML", fileName: "high-bytes.html" },
    { label: "Markdown", fileName: "high-bytes.md" },
  ])("rejects high-byte opaque data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    const opaqueBinary = Buffer.alloc(9000);
    for (let i = 0; i < opaqueBinary.length; i += 1) {
      opaqueBinary[i] = 0xa0 + (i % 96);
    }
    await fs.writeFile(fakeTextFile, opaqueBinary);
    await expectLoadWebMediaErrorCode(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
      "path-not-allowed",
    );
  });
});
