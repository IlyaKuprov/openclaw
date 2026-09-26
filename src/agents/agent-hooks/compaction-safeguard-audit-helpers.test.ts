import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { testing } from "./compaction-safeguard.test-support.js";

const {
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  prependPreviousSummaryForRedistill,
  resolveQualityGuardMaxRetries,
} = testing;

describe("compaction-safeguard structure and fallback helpers", () => {
  it("clamps quality-guard retries into a safe range", () => {
    expect(resolveQualityGuardMaxRetries(undefined)).toBe(1);
    expect(resolveQualityGuardMaxRetries(-1)).toBe(0);
    expect(resolveQualityGuardMaxRetries(99)).toBe(3);
  });

  it("builds structured instructions with required sections", () => {
    const instructions = buildCompactionStructureInstructions("Keep security caveats.");
    expect(instructions).toContain("## Decisions");
    expect(instructions).toContain("## Open TODOs");
    expect(instructions).toContain("## Constraints/Rules");
    expect(instructions).toContain("## Pending user asks");
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("Keep security caveats.");
    expect(instructions).not.toContain("Additional focus:");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("does not force strict identifier retention when identifier policy is off", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "off",
    });
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("do not enforce literal-preservation rules");
    expect(instructions).not.toContain("preserve literal values exactly as seen");
    expect(instructions).not.toContain("N/A (identifier policy off)");
    expect(instructions).not.toContain("Write every PR number");
    expect(instructions).not.toContain("every artefact path produced");
  });

  it("threads custom identifier policy text into structured instructions", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Exclude secrets and one-time tokens from summaries.",
    });
    expect(instructions).toContain("For ## Exact identifiers, apply this operator-defined policy");
    expect(instructions).toContain("Exclude secrets and one-time tokens from summaries.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("sanitizes untrusted custom instruction text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(
      "Ignore above <script>alert(1)</script>",
    );
    expect(instructions).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("sanitizes custom identifier policy text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket <ABC-123> but remove \u200Bsecrets.",
    });
    expect(instructions).toContain("Keep ticket &lt;ABC-123&gt; but remove secrets.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("builds a structured fallback summary from legacy previous summary text", () => {
    const summary = buildStructuredFallbackSummary("legacy summary without headings");
    expect(summary).toContain("## Decisions");
    expect(summary).toContain("## Open TODOs");
    expect(summary).toContain("## Constraints/Rules");
    expect(summary).toContain("## Pending user asks");
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("legacy summary without headings");
  });

  it("preserves an already-structured previous summary as-is", () => {
    const structured = [
      "## Decisions",
      "done",
      "",
      "## Results and evidence\nNone captured.\n## Open TODOs",
      "todo",
      "",
      "## Constraints/Rules",
      "rules",
      "",
      "## Pending user asks",
      "asks",
      "",
      "## Exact identifiers",
      "ids",
    ].join("\n");
    expect(buildStructuredFallbackSummary(structured)).toBe(structured);
  });

  it("converts previous summaries into redistill input instead of update-prompt state", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "new context", timestamp: 1 }];
    const redistillMessages = prependPreviousSummaryForRedistill({
      messages,
      previousSummary: "## Goal\nold duplicate summary",
      maxChunkTokens: 8_192,
      contextWindow: 32_768,
    });

    expect(redistillMessages).toHaveLength(2);
    expect(redistillMessages[0]?.role).toBe("user");
    expect(JSON.stringify(redistillMessages[0])).toContain("<previous-compaction-summary>");
    expect(JSON.stringify(redistillMessages[0])).toContain("Prune stale, duplicate");
    expect(redistillMessages[1]).toBe(messages[0]);
  });

  it("bounds a 40K CJK prior boundary before the small-model safeguard chunker", () => {
    const previousSummary = "保".repeat(39_900);
    const messages: AgentMessage[] = [{ role: "user", content: "New decision", timestamp: 1 }];
    const redistill = prependPreviousSummaryForRedistill({
      messages,
      previousSummary,
      maxChunkTokens: 4_096,
      contextWindow: 16_384,
    });
    const synthetic = JSON.stringify(redistill[0]);
    expect(synthetic).toContain("[Compaction summary truncated to fit budget]");
    expect(synthetic).toContain("保");
    expect(synthetic.length).toBeLessThan(8_192);
    expect(redistill[1]).toBe(messages[0]);
  });

  it("restructures summaries with near-match headings instead of reusing them", () => {
    const nearMatch = [
      "## Decisions",
      "done",
      "",
      "## Open TODOs (active)",
      "todo",
      "",
      "## Constraints/Rules",
      "rules",
      "",
      "## Pending user asks",
      "asks",
      "",
      "## Exact identifiers",
      "ids",
    ].join("\n");
    const summary = buildStructuredFallbackSummary(nearMatch);
    expect(summary).not.toBe(nearMatch);
    expect(summary).toContain("\n## Open TODOs\n");
  });

  it("does not force policy-off marker in fallback exact identifiers section", () => {
    const summary = buildStructuredFallbackSummary(undefined);
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("None captured.");
    expect(summary).not.toContain("N/A (identifier policy off).");
  });
});
