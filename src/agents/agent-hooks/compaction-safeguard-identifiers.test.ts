import { describe, expect, it } from "vitest";
import {
  MAX_AUDITED_IDENTIFIER_CHARS,
  extractOpaqueIdentifiers,
  extractResultEvidenceAnchors,
  isResultEvidenceAnchor,
  summaryIncludesIdentifier,
} from "./compaction-safeguard-identifiers.js";
import {
  auditSummaryQuality,
  buildStructuredFallbackSummary,
  createSummaryQualityRetentionPlan,
} from "./compaction-safeguard-quality.js";

describe("signed measurement evidence", () => {
  it("extracts exact signed percent, storage, temperature, and frequency values", () => {
    const source = "Change -5%; capacity +512 MB; ambient -23 °C; shift +1.5e-3 Hz.";
    const expected = ["-5%", "+512 MB", "-23 °C", "+1.5e-3 Hz"];
    expect(extractResultEvidenceAnchors(source)).toEqual(expected);
    expect(extractOpaqueIdentifiers(source)).toEqual(expected);
    for (const value of expected) {
      expect(isResultEvidenceAnchor(value)).toBe(true);
      expect(summaryIncludesIdentifier(`Measured ${value} in the log.`, value)).toBe(true);
    }
  });

  it("does not extract an unsigned suffix or accept a wrong sign as evidence", () => {
    expect(
      extractResultEvidenceAnchors(
        "task-5% ID_+512 MB path/-23 °C; --5% +-5% -+5% ++5% 85%extra +512 MBps -23 °Celsius",
      ),
    ).toEqual([]);
    expect(extractResultEvidenceAnchors("-5% +5% 5% -23 °C +23 °C 23 °C")).toEqual([
      "-5%",
      "+5%",
      "5%",
      "-23 °C",
      "+23 °C",
      "23 °C",
    ]);
    expect(summaryIncludesIdentifier("Results: +5%", "-5%")).toBe(false);
    expect(summaryIncludesIdentifier("Results: 5%", "-5%")).toBe(false);
    expect(summaryIncludesIdentifier("Results: -5%", "5%")).toBe(false);
    expect(summaryIncludesIdentifier("Results: +512 MB", "512 MB")).toBe(false);
    expect(isResultEvidenceAnchor("5%")).toBe(true);
    expect(isResultEvidenceAnchor("--5%")).toBe(false);
  });

  it.each(["strict", "off", "custom"] as const)(
    "requires a signed result in Results and repairs it under %s policy",
    (identifierPolicy) => {
      const identifiers = extractOpaqueIdentifiers("Observed a -5% change in the source log.");
      expect(identifiers).toEqual(["-5%"]);
      const fallback = buildStructuredFallbackSummary(undefined);
      const misplaced = fallback.replace("## Decisions\n", "## Decisions\n-5%\n");
      const missing = auditSummaryQuality({
        summary: misplaced,
        structuralSummary: misplaced,
        identifiers,
        latestAsk: null,
        identifierPolicy,
      });
      expect(missing.reasons).toContain("missing_result_evidence:-5%");
      const wrongSign = fallback.replace(
        "## Results and evidence\nNone captured.",
        "## Results and evidence\n+5%",
      );
      expect(
        auditSummaryQuality({
          summary: wrongSign,
          structuralSummary: wrongSign,
          identifiers,
          latestAsk: null,
          identifierPolicy,
        }).reasons,
      ).toContain("missing_result_evidence:-5%");
      const restored = createSummaryQualityRetentionPlan(fallback, "[truncated]", {
        identifiers,
        latestAsk: null,
        identifierPolicy,
      })?.render(500)?.text;
      expect(restored).toMatch(/## Results and evidence[\s\S]*-5%[\s\S]*## Open TODOs/u);
      expect(
        auditSummaryQuality({
          summary: restored ?? "",
          structuralSummary: restored ?? "",
          identifiers,
          latestAsk: null,
          identifierPolicy,
        }).ok,
      ).toBe(true);
    },
  );

  it("prioritizes late signed results inside the existing candidate and character budgets", () => {
    const urls = Array.from(
      { length: 40 },
      (_, i) => `https://example.com/${i}/${"a".repeat(370)}`,
    );
    const identifiers = extractOpaqueIdentifiers(`${urls.join("\n")}\n-5%`);
    expect(identifiers).toContain("-5%");
    expect(identifiers.length).toBeLessThanOrEqual(40);
    expect(identifiers).toContain(urls.at(-1));
    expect(identifiers).not.toContain(urls[0]);
    expect(identifiers.reduce((sum, value) => sum + value.length + 1, 0)).toBeLessThanOrEqual(
      MAX_AUDITED_IDENTIFIER_CHARS,
    );
  });
});

describe("strict history literals", () => {
  it("extracts dates, times and localhost ports for the strict quality audit", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Maintenance starts 2026-09-26 at 10:18; dashboard at localhost:8080.",
    );
    expect(identifiers).toEqual(["2026-09-26", "10:18", "localhost:8080"]);
    const summary = buildStructuredFallbackSummary(
      "Maintenance starts 2026-09-27 at 10:19; dashboard at localhost:8081.",
    );
    expect(
      auditSummaryQuality({
        summary,
        structuralSummary: summary,
        identifiers,
        latestAsk: null,
        identifierPolicy: "strict",
      }).reasons,
    ).toContain("missing_identifiers:2026-09-26,10:18,localhost:8080");
    const repaired = createSummaryQualityRetentionPlan(summary, "[truncated]", {
      identifiers,
      latestAsk: null,
      identifierPolicy: "strict",
    })?.render(16_000)?.text;
    expect(repaired).toBeDefined();
    expect(
      auditSummaryQuality({
        summary: repaired ?? "",
        structuralSummary: repaired ?? "",
        identifiers,
        latestAsk: null,
        identifierPolicy: "strict",
      }).ok,
    ).toBe(true);
  });

  it("rejects malformed history literals and adjacent near-matches", () => {
    expect(
      extractOpaqueIdentifiers(
        "2026-13-26 2026-09-260 30:18 10:80 10:18:00 localhost:65536 localhost:80801 " +
          "http://localhost:8080 src/2026-09-26/report.log",
      ),
    ).toEqual(["http://localhost:8080", "src/2026-09-26/report.log"]);
    for (const [source, nearMatch] of [
      ["2026-09-26", "2026-09-260"],
      ["10:18", "10:180"],
      ["localhost:8080", "localhost:80800"],
      ["localhost:8080", "x-localhost:8080"],
    ] as const) {
      expect(summaryIncludesIdentifier(nearMatch, source)).toBe(false);
      expect(summaryIncludesIdentifier(`Recorded (${source}).`, source)).toBe(true);
    }
  });

  it("does not accept a longer URL as the exact source URL", () => {
    const [identifier] = extractOpaqueIdentifiers("See https://example.com/issues/42 for details.");
    expect(identifier).toBe("https://example.com/issues/42");
    if (!identifier) {
      throw new Error("Expected an extracted URL");
    }
    const summary = buildStructuredFallbackSummary(
      "See https://example.com/issues/420 for details.",
    );
    expect(
      auditSummaryQuality({
        summary,
        structuralSummary: summary,
        identifiers: [identifier],
        latestAsk: null,
        identifierPolicy: "strict",
      }).reasons,
    ).toContain(`missing_identifiers:${identifier}`);
    for (const nearMatch of [
      "https://example.com/issues/420",
      "https://example.com/issues/42/extra",
      "https://example.com/issues/42?view=full",
      "https://example.com/issues/42#detail",
      "https://example.com/issues/42.example",
      `https://mirror.test/redirect/${identifier}`,
    ]) {
      expect(summaryIncludesIdentifier(nearMatch, identifier)).toBe(false);
    }
    expect(summaryIncludesIdentifier(`Source [link](${identifier}).`, identifier)).toBe(true);
    expect(summaryIncludesIdentifier(`Source <${identifier}>.`, identifier)).toBe(true);
    expect(summaryIncludesIdentifier(`URL:${identifier}`, identifier)).toBe(true);
    const repaired = createSummaryQualityRetentionPlan(summary, "[truncated]", {
      identifiers: [identifier],
      latestAsk: null,
      identifierPolicy: "strict",
    })?.render(16_000)?.text;
    expect(repaired).toContain(identifier);
    expect(
      auditSummaryQuality({
        summary: repaired ?? "",
        structuralSummary: repaired ?? "",
        identifiers: [identifier],
        latestAsk: null,
        identifierPolicy: "strict",
      }).ok,
    ).toBe(true);
  });

  it("prioritizes late history literals without displacing measured results under source budgets", () => {
    const urls = Array.from(
      { length: 40 },
      (_, index) => `https://example.com/${index}/${"a".repeat(370)}`,
    );
    const identifiers = extractOpaqueIdentifiers(
      `${urls.join("\n")}\n2026-09-26 10:18 localhost:8080 -5%`,
    );
    expect(identifiers).toEqual(
      expect.arrayContaining(["2026-09-26", "10:18", "localhost:8080", "-5%"]),
    );
    expect(identifiers.length).toBeLessThanOrEqual(40);
    expect(identifiers).toContain(urls.at(-1));
    expect(identifiers).not.toContain(urls[0]);
    expect(identifiers.at(-1)).toBe("-5%");
    expect(identifiers.reduce((sum, value) => sum + value.length + 1, 0)).toBeLessThanOrEqual(
      4_000,
    );
  });

  it.each(["strict", "off", "custom"] as const)(
    "preserves a result count across capitalization under %s policy",
    (identifierPolicy) => {
      const source = "42 Tests Passed";
      const summary = buildStructuredFallbackSummary("## Results and evidence\n42 tests passed");
      expect(summaryIncludesIdentifier(summary, source)).toBe(true);
      expect(summaryIncludesIdentifier("420 tests passed", source)).toBe(false);
      expect(summaryIncludesIdentifier("42 tests failed", source)).toBe(false);
      expect(
        auditSummaryQuality({
          summary,
          structuralSummary: summary,
          identifiers: [source],
          latestAsk: null,
          identifierPolicy,
        }).ok,
      ).toBe(true);
    },
  );
});
