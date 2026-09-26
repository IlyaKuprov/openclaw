import { describe, expect, it } from "vitest";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  createSummaryQualityRetentionPlan,
  extractOpaqueIdentifiers,
  selectAuditedIdentifiers,
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

  it.each(["off", "custom"] as const)(
    "anchors a measured value with its units in Results under %s policy",
    (identifierPolicy) => {
      const identifiers = extractOpaqueIdentifiers("Measured 17.3 Hz in the source spectrum.");
      expect(identifiers).toEqual(["17.3 Hz"]);
      expect(extractOpaqueIdentifiers("17.3 widgets; 17.3 Hz-extra")).toEqual([]);
      expect(extractOpaqueIdentifiers("job-17.3 Hz")).not.toContain("17.3 Hz");
      const summary = buildStructuredFallbackSummary("Source measurement: 17.3 Hz.");
      expect(
        auditSummaryQuality({
          summary,
          structuralSummary: summary,
          identifiers,
          latestAsk: null,
          identifierPolicy,
        }).reasons,
      ).toContain("missing_result_evidence:17.3 Hz");
      const wrongUnits = summary.replace(
        "None captured.\n\n## Open TODOs",
        "17.3 kHz\n\n## Open TODOs",
      );
      expect(
        auditSummaryQuality({
          summary: wrongUnits,
          structuralSummary: wrongUnits,
          identifiers,
          latestAsk: null,
          identifierPolicy,
        }).reasons,
      ).toContain("missing_result_evidence:17.3 Hz");
      const rendered = createSummaryQualityRetentionPlan(summary, "[truncated]", {
        identifiers,
        latestAsk: null,
        identifierPolicy,
      })?.render(500)?.text;
      expect(rendered).toMatch(/## Results and evidence[\s\S]*17\.3 Hz[\s\S]*## Open TODOs/u);
      expect(
        auditSummaryQuality({
          summary: rendered ?? "",
          structuralSummary: rendered ?? "",
          identifiers,
          latestAsk: null,
          identifierPolicy,
        }).ok,
      ).toBe(true);
      const oversized = summary.replace(
        "## Results and evidence\nNone captured.",
        `## Results and evidence\n${"e".repeat(12_000)}\n17.3 Hz`,
      );
      const budgeted = createSummaryQualityRetentionPlan(oversized, "[truncated]", {
        identifiers,
        latestAsk: null,
        identifierPolicy,
      })?.render(2_000)?.text;
      expect(budgeted?.length).toBeLessThanOrEqual(2_000);
      expect(budgeted).toMatch(/## Results and evidence[\s\S]*17\.3 Hz[\s\S]*## Open TODOs/u);
    },
  );

  it.each(["strict", "off", "custom"] as const)(
    "audits percent, memory, and temperature measurements in Results under %s policy",
    (identifierPolicy) => {
      const measurements = ["85%", "512 MB", "23 °C"];
      const identifiers = extractOpaqueIdentifiers(
        "Measured 85% utilization, 512 MB allocated, and 23 °C ambient.",
      );
      expect(identifiers).toEqual(measurements);
      expect(
        extractOpaqueIdentifiers("task-85% ID_512 MB path/23 °C; 85%extra 512 MBps 23 °Celsius"),
      ).toEqual([]);
      const summary = buildStructuredFallbackSummary(undefined);
      const misplaced = summary.replace(
        "## Decisions\n",
        `## Decisions\n${measurements.join(", ")}\n`,
      );
      expect(
        auditSummaryQuality({
          summary: misplaced,
          structuralSummary: misplaced,
          identifiers,
          latestAsk: null,
          identifierPolicy,
        }).reasons,
      ).toContain(`missing_result_evidence:${measurements.join(",")}`);
      const restored = createSummaryQualityRetentionPlan(summary, "[truncated]", {
        identifiers,
        latestAsk: null,
        identifierPolicy,
      })?.render(500)?.text;
      expect(restored).toMatch(
        /## Results and evidence[\s\S]*85%[\s\S]*512 MB[\s\S]*23 °C[\s\S]*## Open TODOs/u,
      );
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
    expect(instructions).not.toContain("every artifact path");
    expect(instructions).not.toContain("every numerical result");
  });

  it("audits contextual root artifacts but not domains, prose, or filename near-matches", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Modified package.json; output report.csv; artifact `README.md`. " +
        "Read example.com and some.property; package.json.bak is not the artifact. " +
        "file report.csv.old is a different filename; src/package.json lives in a directory.",
    );
    expect(identifiers).toEqual(["package.json", "report.csv", "README.md", "src/package.json"]);
    expect(
      extractOpaqueIdentifiers("example.com and package.json are mentioned in prose."),
    ).toEqual([]);
    expect(extractOpaqueIdentifiers("`README.md` and `example.com`; File: package.json")).toEqual([
      "README.md",
      "package.json",
    ]);
    const nearMatch = buildStructuredFallbackSummary(
      "package.json.bak, report.csv.old and src/package.json; README.md5",
    );
    const quality = auditSummaryQuality({
      summary: nearMatch,
      structuralSummary: nearMatch,
      identifiers: ["package.json", "report.csv", "README.md"],
      latestAsk: null,
    });
    expect(quality.reasons).toContain("missing_identifiers:package.json,report.csv,README.md");
    for (const identifierPolicy of ["off", "custom"] as const) {
      expect(
        auditSummaryQuality({
          summary: nearMatch,
          structuralSummary: nearMatch,
          identifiers: ["package.json", "report.csv"],
          latestAsk: null,
          identifierPolicy,
        }).ok,
      ).toBe(true);
      expect(
        createSummaryQualityRetentionPlan(nearMatch, "[truncated]", {
          identifiers: ["package.json", "report.csv"],
          latestAsk: null,
          identifierPolicy,
        })?.render(16_000)?.text,
      ).toBe(nearMatch);
    }
  });

  it("prioritizes a late root artifact within forty audited candidates", () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/evidence-${index}.txt`);
    const incidental = Array.from({ length: 40 }, (_, index) => `prose${index}.example`);
    const identifiers = extractOpaqueIdentifiers(
      `${paths.join(" ")} ${incidental.join(" ")} Modified package.json; output report.csv`,
    );
    expect(identifiers).toHaveLength(40);
    expect(identifiers).toContain("package.json");
    expect(identifiers).toContain("report.csv");
    expect(identifiers).not.toContain(paths[38]);
    expect(identifiers).not.toContain("prose0.example");
  });

  it("retains a labeled seven-character commit hash without accepting a longer near-match", () => {
    const identifiers = extractOpaqueIdentifiers("commit abc1234; commit: 1a2b3c4");
    expect(identifiers).toEqual(["ABC1234", "1A2B3C4"]);
    const summary = buildStructuredFallbackSummary("commit abc12345 and 1a2b3c4");
    expect(
      auditSummaryQuality({ summary, structuralSummary: summary, identifiers, latestAsk: null })
        .reasons,
    ).toContain("missing_identifiers:ABC1234");
  });

  it("keeps twelve fitting URLs and selects recent actionable anchors under a shared budget", () => {
    const urls = Array.from(
      { length: 40 },
      (_, index) =>
        `https://example.com/result-${index.toString().padStart(2, "0")}/${"a".repeat(370)}`,
    );
    expect(extractOpaqueIdentifiers(urls.slice(0, 9).join("\n"))).toEqual(urls.slice(0, 9));
    const shorter = urls.map((url) => url.slice(0, -80));
    expect(extractOpaqueIdentifiers(shorter.slice(0, 12).join("\n"))).toEqual(shorter.slice(0, 12));
    const bounded = extractOpaqueIdentifiers(
      `${urls.slice(0, 36).join("\n")}\nPR #47\njob-123\n42 tests passed\nsrc/rollout.log`,
    );
    expect(bounded).toContain("PR #47");
    expect(bounded).toContain("job-123");
    expect(bounded).toContain("42 tests passed");
    expect(bounded).toContain("src/rollout.log");
    expect(bounded).toContain(urls[35]);
    expect(bounded).not.toContain(urls[0]);
    expect(bounded.reduce((total, value) => total + value.length + 1, 0)).toBeLessThanOrEqual(
      Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 4),
    );
  });

  it("does not discard late measured results, commits and PRs behind forty earlier URLs", () => {
    const urls = Array.from(
      { length: 40 },
      (_, index) => `https://example.com/result-${index}/${"a".repeat(370)}`,
    );
    const identifiers = extractOpaqueIdentifiers(
      `${urls.join("\n")}\nPR #47\ncommit abc1234\n42 tests passed\n17.3 Hz`,
    );
    expect(identifiers).toContain("PR #47");
    expect(identifiers).toContain("ABC1234");
    expect(identifiers).toContain("42 tests passed");
    expect(identifiers).toContain("17.3 Hz");
    expect(identifiers).toContain(urls.at(-1));
    expect(identifiers).not.toContain(urls[0]);
  });

  it("keeps one individually fitting recent literal when none fits its preferred share", () => {
    const urls = [
      "https://example.com/" + "a".repeat(700),
      "https://example.com/" + "b".repeat(700),
    ];
    expect(selectAuditedIdentifiers(urls, 500, 2_000)).toEqual([urls[1]]);
    expect(selectAuditedIdentifiers(["PR #47", ...urls], 500, 600)).toEqual(["PR #47", ...urls]);
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

  it("spends the Results tail reservation only once when its measurements survive the prefix", () => {
    const measurements = ["17.3 Hz", "512 MB", "23 °C", "85%"];
    const summary = [
      `## Decisions\n${"d".repeat(1200)}`,
      `## Results and evidence\n${measurements.join("\n")}\n${"r".repeat(1200)}`,
      `## Open TODOs\n${"t".repeat(1200)}`,
      `## Constraints/Rules\n${"c".repeat(1200)}`,
      "## Pending user asks\nNone.",
      "## Exact identifiers\nNone.",
    ].join("\n\n");
    const plan = createSummaryQualityRetentionPlan(summary, "[truncated]", {
      identifiers: measurements,
      latestAsk: null,
      identifierPolicy: "off",
    });
    expect(plan?.render(8_000)).toEqual({ text: summary, trimmed: false });
    const pressured = plan?.render(1_000);
    expect(pressured?.text.length).toBeLessThanOrEqual(1_000);
    expect(pressured?.text).toContain("[truncated]");
    expect(pressured?.text).toContain(`## Results and evidence\n${measurements.join("\n")}`);
    const unprotected = ["d", "t", "c"].reduce(
      (total, char) =>
        total + (pressured?.text.match(new RegExp(`${char}{2,}`, "u"))?.[0].length ?? 0),
      0,
    );
    expect(unprotected).toBeGreaterThanOrEqual(635);
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

  it("does not demand literal identifiers or artifact paths when policy is off or custom", () => {
    for (const identifierPolicy of ["off", "custom"] as const) {
      const instructions = buildCompactionStructureInstructions(undefined, { identifierPolicy });
      expect(instructions).toContain("## Results and evidence");
      expect(instructions).not.toContain("Write every PR number");
      expect(instructions).not.toContain("every artifact path produced");
    }
  });
});
