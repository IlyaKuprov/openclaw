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
