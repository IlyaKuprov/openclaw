import { describe, expect, it } from "vitest";
import {
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  createSummaryQualityRetentionPlan,
  extractOpaqueIdentifiers,
} from "./compaction-safeguard-quality.js";

describe("compaction summary quality contract", () => {
  it("rejects a missing integer test result in Results and evidence", () => {
    const identifiers = extractOpaqueIdentifiers(
      "42 tests passed; next: inspect artifacts/run.log",
    );
    expect(identifiers).toContain("42 tests passed");
    const summary = buildStructuredFallbackSummary(undefined);
    expect(
      auditSummaryQuality({ summary, structuralSummary: summary, identifiers, latestAsk: null })
        .reasons,
    ).toContain("missing_result_evidence:42 tests passed");

    const misplaced = summary.replace("## Decisions\n", "## Decisions\n42 tests passed\n");
    expect(
      auditSummaryQuality({
        summary: misplaced,
        structuralSummary: misplaced,
        identifiers,
        latestAsk: null,
      }).reasons,
    ).toContain("missing_result_evidence:42 tests passed");
    const restored = createSummaryQualityRetentionPlan(summary, "[truncated]", {
      identifiers,
      latestAsk: null,
    })?.render(16_000)?.text;
    expect(restored).toContain("## Exact identifiers\nNone captured.\n42 tests passed");
    expect(restored).toContain("## Results and evidence\nNone captured.\n42 tests passed");
    expect(
      auditSummaryQuality({
        summary: restored ?? "",
        structuralSummary: restored ?? "",
        identifiers,
        latestAsk: null,
      }).ok,
    ).toBe(true);
    const repaired = summary.replace(
      "## Results and evidence\nNone captured.",
      "## Results and evidence\n42 tests passed; evidence: artifacts/run.log; next: inspect failures.",
    );
    expect(
      auditSummaryQuality({
        summary: repaired,
        structuralSummary: repaired,
        identifiers,
        latestAsk: null,
      }).ok,
    ).toBe(true);
  });

  it.each(["off", "custom"] as const)(
    "retains a late audited result under %s identifier policy when trimming",
    (identifierPolicy) => {
      const summary = buildStructuredFallbackSummary(undefined).replace(
        "## Results and evidence\nNone captured.",
        `## Results and evidence\n${"e".repeat(12_000)}\n42 tests passed`,
      );
      const rendered = createSummaryQualityRetentionPlan(summary, "[truncated]", {
        identifiers: ["42 tests passed"],
        latestAsk: null,
        identifierPolicy,
      })?.render(8_000)?.text;
      expect(rendered).toMatch(
        /## Results and evidence[\s\S]*42 tests passed[\s\S]*## Open TODOs/u,
      );
      expect(
        auditSummaryQuality({
          summary: rendered ?? "",
          structuralSummary: rendered ?? "",
          identifiers: ["42 tests passed"],
          identifierPolicy,
          latestAsk: null,
        }).ok,
      ).toBe(true);
    },
  );

  it("extracts repository-relative paths and requires literal preservation", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Modified `src/foo.ts`; output artifacts/run.log; link https://example.com/a/b.",
    );
    expect(identifiers).toContain("src/foo.ts");
    expect(identifiers).toContain("artifacts/run.log");
    expect(extractOpaqueIdentifiers("./src/foo.ts and ../artifacts/run.log")).toEqual([
      "./src/foo.ts",
      "../artifacts/run.log",
    ]);
    const summary = buildStructuredFallbackSummary(undefined);
    expect(
      auditSummaryQuality({ summary, structuralSummary: summary, identifiers, latestAsk: null })
        .reasons,
    ).toContain("missing_identifiers:src/foo.ts,artifacts/run.log,https://example.com/a/b");
    const nearMatch = buildStructuredFallbackSummary("src/foo.ts.bak and artifacts/run.log.old");
    expect(
      auditSummaryQuality({
        summary: nearMatch,
        structuralSummary: nearMatch,
        identifiers: ["src/foo.ts", "artifacts/run.log"],
        latestAsk: null,
      }).reasons,
    ).toContain("missing_identifiers:src/foo.ts,artifacts/run.log");
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).not.toContain("every artefact path");
    expect(instructions).not.toContain("every numerical result");
  });

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

    const longer = buildStructuredFallbackSummary("Job ID 420; Message ID: abcd; MSG-90");
    expect(
      auditSummaryQuality({
        summary: longer,
        structuralSummary: longer,
        identifiers,
        latestAsk: null,
      }).reasons,
    ).toContain("missing_identifiers:Job ID 42,Message ID: abc,MSG-9");
    const plan = createSummaryQualityRetentionPlan(longer, "[truncated]", {
      identifiers,
      latestAsk: null,
    });
    expect(plan?.needsRebuild(16_000)).toBe(true);
    const repaired = plan?.render(16_000)?.text ?? "";
    expect(repaired).toContain("Job ID 42");
    expect(repaired).toContain("Message ID: abc");
    expect(repaired).toContain("MSG-9");
    expect(
      auditSummaryQuality({
        summary: repaired,
        structuralSummary: repaired,
        identifiers,
        latestAsk: null,
      }).ok,
    ).toBe(true);
  });

  it("captures the value after copular ID labels rather than the copula", () => {
    const identifiers = extractOpaqueIdentifiers("Message ID is abc; Job ID was 42.");
    expect(identifiers).toEqual(["Message ID is abc", "Job ID was 42"]);
    expect(extractOpaqueIdentifiers("Message ID is; Job ID was.")).toEqual([]);

    const longer = buildStructuredFallbackSummary("Message ID is abcd; Job ID was 420");
    expect(
      auditSummaryQuality({
        summary: longer,
        structuralSummary: longer,
        identifiers,
        latestAsk: null,
      }).reasons,
    ).toContain("missing_identifiers:Message ID is abc,Job ID was 42");
    const repaired = createSummaryQualityRetentionPlan(longer, "[truncated]", {
      identifiers,
      latestAsk: null,
    })?.render(16_000)?.text;
    expect(repaired).toContain("Message ID is abc");
    expect(repaired).toContain("Job ID was 42");
  });

  it.each(["off", "custom"] as const)(
    "audits numerical results in Results and evidence with identifier policy %s",
    (identifierPolicy) => {
      const identifiers = extractOpaqueIdentifiers("42 tests passed");
      const summary = buildStructuredFallbackSummary("42 tests passed");
      const quality = auditSummaryQuality({
        summary,
        structuralSummary: summary,
        identifiers,
        latestAsk: null,
        identifierPolicy,
      });
      expect(quality.reasons).toContain("missing_result_evidence:42 tests passed");
      expect(quality.reasons).not.toContain("missing_identifiers:42 tests passed");
    },
  );

  it("sets a feasible length target from the generation output budget", () => {
    const low = buildCompactionStructureInstructions(undefined, undefined, undefined, 819);
    expect(low).toContain("## Exact identifiers");
    expect(low).not.toContain("6000 to 10000 characters");
    expect(low).toContain("3276 characters");
    const high = buildCompactionStructureInstructions(undefined, undefined, undefined, 13_107);
    expect(high).toContain("6000 to 10000 characters");
    const unknown = buildCompactionStructureInstructions();
    expect(unknown).not.toContain("6000 to 10000 characters");
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
