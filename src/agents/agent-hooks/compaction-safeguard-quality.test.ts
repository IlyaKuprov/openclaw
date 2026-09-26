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
