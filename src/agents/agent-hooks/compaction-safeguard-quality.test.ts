import { describe, expect, it } from "vitest";
import {
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  createSummaryQualityRetentionPlan,
  extractOpaqueIdentifiers,
} from "./compaction-safeguard-quality.js";

describe("compaction summary quality contract", () => {
  it("audits short PR, job, and message references without classifying ordinary counts", () => {
    const identifiers = extractOpaqueIdentifiers(
      "PR #13, #14, job id 42, message id 7; job-8, msg-9. 13 files, 42 tests and 7 retries.",
    );
    expect(identifiers).toEqual(["PR #13", "#14", "job id 42", "message id 7", "job-8", "msg-9"]);
    expect(
      auditSummaryQuality({
        summary: buildStructuredFallbackSummary(undefined),
        structuralSummary: buildStructuredFallbackSummary(undefined),
        identifiers,
        latestAsk: null,
      }).reasons,
    ).toContain("missing_identifiers:PR #13,#14,job id 42");
    const summary = buildStructuredFallbackSummary("PR #130, job-80 and message id 70");
    expect(
      auditSummaryQuality({
        summary,
        structuralSummary: summary,
        identifiers: ["PR #13", "job-8", "message id 7"],
        latestAsk: null,
      }).reasons,
    ).toContain("missing_identifiers:PR #13,job-8,message id 7");
  });

  it("audits capitalized short job and message identifiers", () => {
    const identifiers = extractOpaqueIdentifiers("Job ID 42; Message ID: abc; MSG-9.");
    expect(identifiers).toEqual(["Job ID 42", "Message ID: abc", "MSG-9"]);
    expect(
      auditSummaryQuality({
        summary: buildStructuredFallbackSummary(undefined),
        structuralSummary: buildStructuredFallbackSummary(undefined),
        identifiers,
        latestAsk: null,
      }).reasons,
    ).toContain("missing_identifiers:Job ID 42,Message ID: abc,MSG-9");
  });

  it("keeps an 8,000-character fitting summary with 5,000 characters of evidence intact", () => {
    const evidence = `measurement 17.3 Hz, source /tmp/result.log, next: inspect peak\n${"e".repeat(4940)}`;
    const summary = [
      "## Decisions\nKeep the measurement.",
      `## Results and evidence\n${evidence}`,
      `## Open TODOs\n${"t".repeat(2700)}`,
      "## Constraints/Rules\nRetain source facts.",
      "## Pending user asks\nNone.",
      "## Exact identifiers\n/tmp/result.log",
    ].join("\n\n");
    expect(summary.length).toBeGreaterThan(7_000);
    expect(summary.length).toBeLessThan(8_000);
    expect(evidence.length).toBeGreaterThan(5_000);
    const plan = createSummaryQualityRetentionPlan(summary, "[truncated]", {
      identifiers: ["/tmp/result.log"],
      latestAsk: null,
      identifierPolicy: "strict",
    });
    expect(plan?.needsRebuild(16_000)).toBe(false);
    expect(plan?.render(16_000)).toEqual({ text: summary, trimmed: false });
    const pressured = plan?.render(6_000);
    expect(pressured?.trimmed).toBe(true);
    expect(pressured?.text).toContain("## Results and evidence\nmeasurement 17.3 Hz");
    expect(pressured?.text.length).toBeLessThanOrEqual(6_000);

    const missingIdentifierPlan = createSummaryQualityRetentionPlan(summary, "[truncated]", {
      identifiers: ["/tmp/result.log", "Job ID 42"],
      latestAsk: null,
      identifierPolicy: "strict",
    });
    expect(missingIdentifierPlan?.needsRebuild(16_000)).toBe(true);
    const completed = missingIdentifierPlan?.render(16_000);
    expect(completed?.trimmed).toBe(false);
    expect(completed?.text).toContain(evidence);
    expect(completed?.text).toContain("Job ID 42");
  });

  it("migrates a persisted five-section summary without nesting or losing its evidence", () => {
    const previous = [
      "## Decisions\nKeep the measured result.",
      "## Open TODOs\nInspect the peak next.",
      "## Constraints/Rules\nPreserve units.",
      "## Pending user asks\nReport status.",
      "## Exact identifiers\n/tmp/peak.log",
    ].join("\n\n");
    const summary = buildStructuredFallbackSummary(previous);
    expect(summary).toContain("## Results and evidence\nNone captured.");
    expect(summary).toContain("## Decisions\nKeep the measured result.");
    expect(summary).toContain("## Open TODOs\nInspect the peak next.");
    expect(summary).toContain("## Exact identifiers\n/tmp/peak.log");
    for (const heading of [
      "## Decisions",
      "## Results and evidence",
      "## Open TODOs",
      "## Constraints/Rules",
      "## Pending user asks",
      "## Exact identifiers",
    ]) {
      expect(summary.split("\n").filter((line) => line === heading)).toHaveLength(1);
    }
    expect(
      auditSummaryQuality({
        summary,
        structuralSummary: summary,
        sourceSummaries: [summary],
        identifiers: ["/tmp/peak.log"],
        latestAsk: null,
      }).ok,
    ).toBe(true);
  });

  it("requires Results and evidence in order and reserves its content during budgeting", () => {
    const noResults = [
      "## Decisions",
      "Decided.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Keep history.",
      "## Pending user asks",
      "None.",
      "## Exact identifiers",
      "None.",
    ].join("\n");
    const audit = (summary: string) =>
      auditSummaryQuality({
        summary,
        structuralSummary: summary,
        identifiers: [],
        latestAsk: null,
      });
    expect(audit(noResults).reasons).toContain("missing_section:## Results and evidence");
    const misplaced = noResults.replace(
      "## Open TODOs",
      "## Open TODOs\n## Results and evidence\nmeasured 17.3 Hz",
    );
    expect(audit(misplaced).reasons).toContain("section_order_invalid");

    const valid = noResults.replace(
      "## Open TODOs",
      "## Results and evidence\nmeasured 17.3 Hz from /tmp/result.log\n## Open TODOs",
    );
    expect(audit(valid).ok).toBe(true);
    const plan = createSummaryQualityRetentionPlan(
      valid.replace("Decided.", "x".repeat(4000)),
      "[truncated]",
      { identifiers: [], latestAsk: null, identifierPolicy: "strict" },
    );
    const budgeted = plan?.render(1000);
    expect(budgeted?.text).toContain(
      "## Results and evidence\nmeasured 17.3 Hz from /tmp/result.log",
    );
    expect(budgeted?.text.length).toBeLessThanOrEqual(1000);
  });

  it("does not demand literal identifiers or artefact paths when policy is off or custom", () => {
    for (const identifierPolicy of ["off", "custom"] as const) {
      const instructions = buildCompactionStructureInstructions(undefined, { identifierPolicy });
      expect(instructions).toContain("## Results and evidence");
      expect(instructions).not.toContain("Write every PR number");
      expect(instructions).not.toContain("every artefact path produced");
    }
  });
});
