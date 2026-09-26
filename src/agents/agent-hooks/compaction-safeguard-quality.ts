/** Quality contract, fallback, and audit helpers for compaction safeguard summaries. */
import { CHARS_PER_TOKEN_ESTIMATE } from "@openclaw/normalization-core/cjk-chars";
import { localeLowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import type { CompactionSummarizationInstructions } from "../compaction.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";

// Compaction summary quality helpers. They define the structured summary contract
// and audit whether summaries preserve pending asks plus exact identifiers.
const MAX_EXTRACTED_IDENTIFIERS = 40;
const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4000;
const MAX_ASK_OVERLAP_TOKENS = 12;
const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Results and evidence",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const LEGACY_SUMMARY_SECTIONS = [
  REQUIRED_SUMMARY_SECTIONS[0],
  ...REQUIRED_SUMMARY_SECTIONS.slice(2),
];
const RESULTS_SECTION_INDEX = 1;
const QUALITY_PROTECTED_SECTION_START = 4;
const PENDING_ASK_SECTION_INDEX = 4;
const EXACT_IDENTIFIERS_SECTION_INDEX = 5;
const PROTECTED_SECTION_INDEXES = new Set([
  RESULTS_SECTION_INDEX,
  PENDING_ASK_SECTION_INDEX,
  EXACT_IDENTIFIERS_SECTION_INDEX,
]);
const MAX_PROTECTED_SECTION_CONTENT_SHARE = 0.25;
const LATEST_USER_REQUEST_CONTEXT_LABEL = "Latest user request context:";
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve important literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";

/** Demotes canonical headings when a summary is embedded as supporting context. */
export function nestRequiredSummaryHeadings(text: string): string {
  return text.replace(/^##[ \t]+\S.*$/gmu, (heading) =>
    REQUIRED_SUMMARY_SECTIONS.some((required) => required === heading.trim())
      ? heading.replace("##", "###")
      : heading,
  );
}

/** Wraps operator-provided compaction instruction text as untrusted prompt data. */
export function wrapUntrustedInstructionBlock(label: string, text: string): string {
  return wrapUntrustedPromptDataBlock({
    label,
    text,
    maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS,
  });
}

function resolveExactIdentifierSectionInstruction(
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const policy = summarizationInstructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
  }
  const custom =
    policy === "custom" ? summarizationInstructions?.identifierInstructions?.trim() : undefined;
  if (custom) {
    // Operator text is runtime data, never prompt authority.
    return (
      wrapUntrustedInstructionBlock(
        "For ## Exact identifiers, apply this operator-defined policy text",
        custom,
      ) || STRICT_EXACT_IDENTIFIERS_INSTRUCTION
    );
  }
  return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}

/** Build the required structured summary instructions for compaction. */
export function buildCompactionStructureInstructions(
  customInstructions?: string,
  summarizationInstructions?: CompactionSummarizationInstructions,
  latestUnresolvedUserRequest?: string,
  maxSummaryOutputTokens?: number,
): string {
  const identifierSectionInstruction =
    resolveExactIdentifierSectionInstruction(summarizationInstructions);
  const strictIdentifiers = (summarizationInstructions?.identifierPolicy ?? "strict") === "strict";
  // Scope the requested length with the compaction owner's token-to-character
  // estimate; actual tokenization can differ from this estimate.
  const maxSummaryChars =
    maxSummaryOutputTokens !== undefined &&
    Number.isFinite(maxSummaryOutputTokens) &&
    maxSummaryOutputTokens > 0
      ? Math.floor(maxSummaryOutputTokens * CHARS_PER_TOKEN_ESTIMATE)
      : undefined;
  const lengthInstruction =
    maxSummaryChars === undefined
      ? ""
      : maxSummaryChars < 6000
        ? `Aim for up to ${maxSummaryChars} characters of summary text; prioritize all required headings and facts.`
        : `Aim for 6000 to ${Math.min(10000, maxSummaryChars)} characters of summary text; spend them on facts, not prose.`;
  const sectionsTemplate = [
    "Produce a complete, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    identifierSectionInstruction,
    lengthInstruction,
    "In ## Results and evidence, record numerical results with units and evidence sources when available; the working hypothesis with evidence for and against it when present; and the next step when known.",
    ...(strictIdentifiers
      ? [
          "Record important artifact paths produced and the file, log, or command behind each result.",
          "Write important PR numbers, commit hashes, job ids, message ids, and file paths in full; do not compress retained identifiers into ranges or counts.",
        ]
      : []),
    "Do not omit unresolved asks from the user.",
    "Record completed requests outside ## Pending user asks; list only unresolved user requests there.",
    "When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail.",
  ]
    .filter(Boolean)
    .join("\n");
  const latestRequestBlock = latestUnresolvedUserRequest
    ? wrapUntrustedInstructionBlock("Latest unresolved user request", latestUnresolvedUserRequest)
    : "";
  const latestRequestInstruction = latestRequestBlock
    ? [
        "Make the exact request below the first item in ## Pending user asks.",
        "Its run owner will resume it after compaction, so summary prose cannot mark it complete.",
        latestRequestBlock,
      ].join("\n")
    : "";
  const custom = customInstructions?.trim();
  const customBlock =
    custom && wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  return [sectionsTemplate, latestRequestInstruction, customBlock].filter(Boolean).join("\n\n");
}

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) {
      return false;
    }
    cursor = index + 1;
  }
  return true;
}

type SummaryQualityRetentionPlan = {
  minimumChars: number;
  /**
   * True when render() must rebuild even a body that fits: a strict source
   * fact is missing.
   */
  needsRebuild: (maxChars: number) => boolean;
  /** Null when even the protected facts cannot fit `maxChars`. */
  render: (maxChars: number) => { text: string; trimmed: boolean } | null;
};

function parseRequiredSummarySectionContents(
  summary: string,
  headings: readonly string[] = REQUIRED_SUMMARY_SECTIONS,
): string[] | null {
  const contents = headings.map(() => new Array<string>());
  const preamble: string[] = [];
  let sectionIndex = -1;

  for (const line of summary.split(/\r?\n/u)) {
    const nextHeading = headings[sectionIndex + 1];
    if (nextHeading && line.trim() === nextHeading) {
      sectionIndex += 1;
      continue;
    }
    if (headings.some((heading) => line.trim() === heading)) {
      return null;
    }
    (sectionIndex < 0 ? preamble : contents[sectionIndex])?.push(line);
  }
  if (sectionIndex !== headings.length - 1) {
    return null;
  }
  contents[0]?.unshift(...preamble);
  return contents.map((lines) => lines.join("\n").trim());
}

function extractPendingAskSection(summary: string): string {
  const section = summary.split(/^## Pending user asks[ \t]*$/mu, 2)[1];
  return section?.split(/^##[ \t]+\S.*$/mu, 1)[0]?.trim() ?? "";
}

function formatLatestUserRequestContext(request: string): string {
  return `${LATEST_USER_REQUEST_CONTEXT_LABEL} ${JSON.stringify(request)}`;
}

function extractLeadingPendingAsk(summary: string): string {
  return normalizedSummaryLines(extractPendingAskSection(summary))[0] ?? "";
}

function isEmptyPendingAsk(value: string): boolean {
  return /^(?:none|none captured|no pending asks)[.!]?$/iu.test(value);
}

/**
 * Plan truncation that keeps the audit facts and lets everything else shrink.
 * Only the headings, the bounded latest-ask context, and the audited source
 * identifiers (including measured values inside Results) are untrimmable.
 * Model-written section text — including the "## Exact identifiers" list —
 * is optional content; protecting it verbatim let
 * a re-distilled identifier dump grow past the whole artifact budget while the
 * real sections were starved to empty headings.
 */
export function createSummaryQualityRetentionPlan(
  summary: string,
  truncatedMarker: string,
  params: {
    auditSummary?: string;
    identifiers: string[];
    latestAsk: string | null;
    latestAskInRetainedTurn?: boolean;
    latestUnresolvedUserRequest?: string;
    requiredAskContext?: string;
    identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
  },
): SummaryQualityRetentionPlan | null {
  const requiredAskContext = params.requiredAskContext?.trim() ?? "";
  const latestUnresolvedUserRequest = params.latestUnresolvedUserRequest?.trim() ?? "";
  const bodyHasLatestAsk = hasAskOverlap(params.auditSummary ?? summary, params.latestAsk);
  const requiredContextBlock =
    !latestUnresolvedUserRequest &&
    (bodyHasLatestAsk || params.latestAskInRetainedTurn) &&
    requiredAskContext
      ? `## Latest user request context\n${JSON.stringify(requiredAskContext)}`
      : "";
  const parsedSummary =
    requiredContextBlock && summary.startsWith(`${requiredContextBlock}\n\n`)
      ? summary.slice(requiredContextBlock.length + 2)
      : summary;
  const contents = parseRequiredSummarySectionContents(parsedSummary);
  if (!contents) {
    return null;
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  const auditedIdentifiers = enforceIdentifiers ? params.identifiers : [];
  const auditedResults = params.identifiers.filter((identifier) =>
    isResultEvidenceAnchor(identifier),
  );
  const marker = truncatedMarker.trim();
  const pendingAsk = contents[PENDING_ASK_SECTION_INDEX] ?? "";
  const protectedAskContext = latestUnresolvedUserRequest
    ? formatLatestUserRequestContext(latestUnresolvedUserRequest)
    : !params.latestAskInRetainedTurn &&
        requiredAskContext &&
        (!bodyHasLatestAsk ||
          (hasAskOverlap(pendingAsk, params.latestAsk) && !pendingAsk.includes(requiredAskContext)))
      ? `${LATEST_USER_REQUEST_CONTEXT_LABEL}\n${JSON.stringify(requiredAskContext)}`
      : "";
  const protectedTails = REQUIRED_SUMMARY_SECTIONS.map((_, index) =>
    index === RESULTS_SECTION_INDEX
      ? auditedResults.join("\n")
      : index === PENDING_ASK_SECTION_INDEX
        ? protectedAskContext
        : index === EXACT_IDENTIFIERS_SECTION_INDEX
          ? auditedIdentifiers.join("\n")
          : "",
  );
  const bodyHasIdentifiers = auditedIdentifiers.every((identifier) =>
    summaryIncludesIdentifier(summary, identifier),
  );
  const bodyHasResults = auditedResults.every((identifier) =>
    summaryIncludesIdentifier(contents[RESULTS_SECTION_INDEX] ?? "", identifier),
  );
  const bodyHasRequiredAskContext = latestUnresolvedUserRequest
    ? extractLeadingPendingAsk(parsedSummary) === protectedAskContext
    : !requiredAskContext
      ? true
      : requiredContextBlock
        ? summary.startsWith(requiredContextBlock)
        : contents[PENDING_ASK_SECTION_INDEX]?.includes(protectedAskContext);
  const renderSections = (sectionContents: string[]) =>
    REQUIRED_SUMMARY_SECTIONS.map((heading, index) => {
      const content = sectionContents[index];
      return content ? `${heading}\n${content}` : heading;
    });
  const joinSectionContent = (index: number, optional: string) => {
    const tail = protectedTails[index] ?? "";
    if (!tail) {
      return optional;
    }
    if (index === RESULTS_SECTION_INDEX) {
      const missing = auditedResults.filter(
        (identifier) => !summaryIncludesIdentifier(optional, identifier),
      );
      return [optional, ...missing].filter(Boolean).join("\n");
    }
    if (index === PENDING_ASK_SECTION_INDEX) {
      const leading = normalizedSummaryLines(optional)[0] ?? "";
      if (leading === tail) {
        return optional;
      }
      if (latestUnresolvedUserRequest) {
        return [tail, isEmptyPendingAsk(leading) ? "" : optional].filter(Boolean).join("\n");
      }
    }
    if (index === EXACT_IDENTIFIERS_SECTION_INDEX) {
      const missing = auditedIdentifiers.filter(
        (identifier) => !summaryIncludesIdentifier(optional, identifier),
      );
      return [optional, ...missing].filter(Boolean).join("\n");
    }
    const retainedOptional =
      index === PENDING_ASK_SECTION_INDEX && protectedAskContext && isEmptyPendingAsk(optional)
        ? ""
        : optional;
    return [retainedOptional, tail].filter(Boolean).join("\n");
  };
  // Reserve every heading/content/tail separator up front so trimmed optional
  // text can never push the rendered artifact past `maxChars`.
  const minimumBlocks = REQUIRED_SUMMARY_SECTIONS.map(
    (heading, index) => `${heading}\n\n${protectedTails[index] ?? ""}`,
  );
  const minimumSummary = [
    ...(requiredContextBlock ? [requiredContextBlock] : []),
    ...minimumBlocks.slice(0, QUALITY_PROTECTED_SECTION_START),
    marker,
    ...minimumBlocks.slice(QUALITY_PROTECTED_SECTION_START),
  ].join("\n\n");
  // Audit-bearing sections (pending asks, exact identifiers) are funded first
  // when trimming is needed so a runaway section cannot starve the others.
  const protectedCapFor = (maxChars: number) =>
    Math.floor(Math.max(0, maxChars - minimumSummary.length) * MAX_PROTECTED_SECTION_CONTENT_SHARE);

  return {
    minimumChars: minimumSummary.length,
    needsRebuild: () =>
      (!latestUnresolvedUserRequest && !bodyHasLatestAsk) ||
      !bodyHasRequiredAskContext ||
      !bodyHasIdentifiers ||
      !bodyHasResults,
    render(maxChars) {
      if (
        summary.length <= maxChars &&
        bodyHasRequiredAskContext &&
        bodyHasIdentifiers &&
        bodyHasResults
      ) {
        return { text: summary, trimmed: false };
      }
      const completeSections = contents.map((content, index) => joinSectionContent(index, content));
      const completeSummary = [
        ...(requiredContextBlock ? [requiredContextBlock] : []),
        ...renderSections(completeSections),
      ].join("\n\n");
      if (completeSummary.length <= maxChars) {
        return { text: completeSummary, trimmed: false };
      }
      if (maxChars < minimumSummary.length) {
        return null;
      }
      const contentBudget = maxChars - minimumSummary.length;
      const protectedCap = protectedCapFor(maxChars);
      const allocations = contents.map((content, index) =>
        PROTECTED_SECTION_INDEXES.has(index) ? Math.min(content.length, protectedCap) : 0,
      );
      const optionalBudget = Math.max(
        0,
        contentBudget - allocations.reduce((total, chars) => total + chars, 0),
      );
      const optionalIndexes = contents.flatMap((_, index) =>
        PROTECTED_SECTION_INDEXES.has(index) ? [] : [index],
      );
      const optionalTotal = optionalIndexes.reduce(
        (total, index) => total + (contents[index]?.length ?? 0),
        0,
      );
      for (const index of optionalIndexes) {
        const content = contents[index] ?? "";
        allocations[index] =
          optionalTotal > 0 ? Math.floor((optionalBudget * content.length) / optionalTotal) : 0;
      }
      // Surplus returns to the optional sections only; the protected caps stay
      // hard so short decisions cannot hand the budget back to the identifier dump.
      let remainder =
        optionalBudget -
        optionalIndexes.reduce((total, index) => total + (allocations[index] ?? 0), 0);
      for (const index of optionalIndexes) {
        const content = contents[index] ?? "";
        const allocation = allocations[index] ?? 0;
        const extra = Math.min(remainder, Math.max(0, content.length - allocation));
        allocations[index] = allocation + extra;
        remainder -= extra;
      }
      const trimmed = contents.some((content, index) => content.length > (allocations[index] ?? 0));
      const sectionContents = contents.map((content, index) =>
        joinSectionContent(index, truncateUtf16Safe(content, allocations[index] ?? 0)),
      );
      const blocks = renderSections(sectionContents);
      return {
        text: [
          ...(requiredContextBlock ? [requiredContextBlock] : []),
          ...blocks.slice(0, QUALITY_PROTECTED_SECTION_START),
          ...(trimmed ? [marker] : []),
          ...blocks.slice(QUALITY_PROTECTED_SECTION_START),
        ].join("\n\n"),
        trimmed,
      };
    },
  };
}

/** Return a structured fallback summary when model output is missing/invalid. */
export function buildStructuredFallbackSummary(previousSummary: string | undefined): string {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) {
    return trimmedPreviousSummary;
  }
  if (
    trimmedPreviousSummary &&
    !normalizedSummaryLines(trimmedPreviousSummary).includes(
      REQUIRED_SUMMARY_SECTIONS[RESULTS_SECTION_INDEX],
    )
  ) {
    const legacyContents = parseRequiredSummarySectionContents(
      trimmedPreviousSummary,
      LEGACY_SUMMARY_SECTIONS,
    );
    if (legacyContents) {
      return LEGACY_SUMMARY_SECTIONS.map((heading, index) => `${heading}\n${legacyContents[index]}`)
        .toSpliced(RESULTS_SECTION_INDEX, 0, "## Results and evidence\nNone captured.")
        .join("\n\n");
    }
  }
  const values = [
    trimmedPreviousSummary || "No prior history.",
    "None captured.",
    "None.",
    "None.",
    "None.",
    "None captured.",
  ];
  return REQUIRED_SUMMARY_SECTIONS.map((heading, index) => `${heading}\n${values[index]}`).join(
    "\n\n",
  );
}

/** Appends a bounded post-compaction section to an existing summary. */
export function appendSummarySection(summary: string, section: string): string {
  if (!section) {
    return summary;
  }
  if (!summary.trim()) {
    return section.trimStart();
  }
  return `${summary}${section}`;
}

function sanitizeExtractedIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)\]"'`,;:.!?<>]+$/, "");
}

function isPureHexIdentifier(value: string): boolean {
  return /^[A-Fa-f0-9]{7,}$/.test(value);
}

function normalizeOpaqueIdentifier(value: string): string {
  return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}

const NUMERIC_RESULT_ANCHOR =
  /^\d+\s+(?:tests?|checks?|assertions?|cases?)\s+(?:passed|failed|succeeded)$/iu;
// Only numerical values paired with recognizable measurement units are source
// results; a decimal in prose or inside an ID is not evidence by itself.
const MEASURED_VALUE_SOURCE = String.raw`(?<![A-Za-z0-9._/\\-])(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?[ \t]*(?:Hz|kHz|MHz|GHz|mT|T|G|ppm|ms|[µμu]s|ns|s|K)(?![A-Za-z0-9_-])`;
const MEASURED_VALUE_ANCHOR = new RegExp(`^${MEASURED_VALUE_SOURCE}$`, "u");

function isResultEvidenceAnchor(identifier: string): boolean {
  return NUMERIC_RESULT_ANCHOR.test(identifier) || MEASURED_VALUE_ANCHOR.test(identifier);
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (isPureHexIdentifier(identifier)) {
    return new RegExp(`(?<![A-Fa-f0-9])${identifier}(?![A-Fa-f0-9])`, "iu").test(summary);
  }
  if (
    /^(?:#\d+|PR\s+#\d+|(?:job|message|msg)(?:[-_#]|\s+id\b))/iu.test(identifier) ||
    isResultEvidenceAnchor(identifier)
  ) {
    const literal = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_#])${literal}(?![A-Za-z0-9_-])`, "u").test(summary);
  }
  if (identifier.includes("/") && !identifier.includes("://")) {
    const literal = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_#./-])${literal}(?![A-Za-z0-9_./-])`, "u").test(summary);
  }
  return summary.includes(identifier);
}

/** Extracts bounded literal anchors: IDs, paths, test outcomes, and measured values. */
export function extractOpaqueIdentifiers(text: string): string[] {
  // Plain counts are not IDs; capture only integer test outcomes with a result verb.
  const measuredValues = Array.from(
    text.matchAll(new RegExp(MEASURED_VALUE_SOURCE, "gu")),
    (match) => ({ index: match.index, value: match[0] }),
  );
  const pathsAndResults = Array.from(
    text.matchAll(
      /(?<![A-Za-z0-9._/\\-])(?:\.\.\/|\.\/)*(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?![A-Za-z0-9._/-])|(?<![A-Za-z0-9_])\d+\s+(?:tests?|checks?|assertions?|cases?)\s+(?:passed|failed|succeeded)\b/giu,
    ),
    (match) => ({ index: match.index, value: match[0] }),
  );
  const labeledCommits = Array.from(
    text.matchAll(/\bcommit(?:\s+(?:hash|sha))?(?:\s*[:#]\s*|\s+)([a-f0-9]{7,40})\b/giu),
    (match) => ({ index: match.index, value: match[1] ?? "" }),
  );
  return uniqueStrings(
    [
      ...Array.from(
        text.matchAll(
          /((?<![A-Za-z0-9_])#\d+\b|\b(?:PR\s+#\d+|(?:job|message|msg)(?:[-_#][A-Za-z0-9_-]+|\s+id(?:\s+(?:is|was)\s+|\s*[:#]?\s*)(?!(?:is|was)\b)[A-Za-z0-9_-]+))\b)|(https?:\/\/\S+|(?<![A-Za-z0-9._-])\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5})|(?:(?:(?:\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?|\d+\.[eE][+-]?\d+|\d+\.?[eE][+-]\d+|(?![A-Fa-f0-9]{8,}(?![A-Fa-f0-9]))\d+\.?[eE]\d+)(?:(?=[A-Za-z]+(?![A-Za-z0-9]))(?=[A-Za-z]*[G-Zg-z])[A-Za-z]+)?(?![A-Za-z0-9])|(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:[A-Fa-f0-9]{8,}|\d{6,}))([A-Za-z0-9_-]+))/gi,
        ),
        (match) => ({ index: match.index, value: match[1] ?? match[2] ?? match[3] ?? "" }),
      ),
      ...pathsAndResults,
      ...labeledCommits,
      ...measuredValues,
    ]
      .filter(
        (match) =>
          !measuredValues.some(
            (value) =>
              match.value !== value.value &&
              match.index >= value.index &&
              match.index + match.value.length <= value.index + value.value.length,
          ),
      )
      .toSorted((left, right) => left.index - right.index)
      .map((match) => normalizeOpaqueIdentifier(sanitizeExtractedIdentifier(match.value)))
      .filter(
        (value) => value.length >= 4 || /^#\d+$/u.test(value) || MEASURED_VALUE_ANCHOR.test(value),
      ),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

function tokenizeAskOverlapText(text: string): string[] {
  const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC")).trim();
  if (!normalized) {
    return [];
  }
  const keywords = extractKeywords(normalized);
  if (keywords.length > 0) {
    return keywords;
  }
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function resolveAskOverlapRequirement(latestAsk: string | null): {
  tokens: string[];
  requiredMatches: number;
} | null {
  if (!latestAsk) {
    return null;
  }
  const askTokens = uniqueStrings(tokenizeAskOverlapText(latestAsk)).slice(
    0,
    MAX_ASK_OVERLAP_TOKENS,
  );
  if (askTokens.length === 0) {
    return null;
  }
  const meaningfulAskTokens = askTokens.filter(
    (token) => token.length > 1 && !isQueryStopWordToken(token),
  );
  const tokensToCheck = meaningfulAskTokens.length > 0 ? meaningfulAskTokens : askTokens;
  const requiredMatches = tokensToCheck.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
  return { tokens: tokensToCheck, requiredMatches };
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  const requirement = resolveAskOverlapRequirement(latestAsk);
  if (!requirement) {
    return true;
  }
  const summaryTokens = new Set(tokenizeAskOverlapText(summary));
  const overlapCount = requirement.tokens.filter((token) => summaryTokens.has(token)).length;
  return overlapCount >= requirement.requiredMatches;
}

/** Audits a candidate summary for required sections, pending asks, and identifier preservation. */
export function auditSummaryQuality(params: {
  summary: string;
  structuralSummary: string;
  sourceSummaries?: string[];
  identifiers: string[];
  latestAsk: string | null;
  latestUnresolvedUserRequest?: string;
  retainedTurnSummary?: string;
  identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.structuralSummary));
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
    }
    if (
      params.sourceSummaries?.some(
        (source) => normalizedSummaryLines(source).filter((line) => line === section).length > 1,
      )
    ) {
      reasons.push(`duplicate_section:${section}`);
    }
  }
  if (
    reasons.every((reason) => !reason.startsWith("missing_section:")) &&
    !hasRequiredSummarySections(params.structuralSummary)
  ) {
    reasons.push("section_order_invalid");
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  if (enforceIdentifiers) {
    const missingIdentifiers = params.identifiers.filter(
      (identifier) => !summaryIncludesIdentifier(params.summary, identifier),
    );
    if (missingIdentifiers.length > 0) {
      reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
    }
  }
  // Result placement is required by ## Results and evidence regardless of the
  // configured literal-identifier policy.
  const resultsSection = parseRequiredSummarySectionContents(params.structuralSummary)?.[
    RESULTS_SECTION_INDEX
  ];
  if (resultsSection !== undefined) {
    const missingResults = params.identifiers
      .filter((identifier) => isResultEvidenceAnchor(identifier))
      .filter((identifier) => !summaryIncludesIdentifier(resultsSection, identifier));
    if (missingResults.length > 0) {
      reasons.push(`missing_result_evidence:${missingResults.slice(0, 3).join(",")}`);
    }
  }
  const leadingPendingAsk = extractLeadingPendingAsk(params.structuralSummary);
  if (
    params.latestUnresolvedUserRequest &&
    leadingPendingAsk !== formatLatestUserRequestContext(params.latestUnresolvedUserRequest)
  ) {
    reasons.push("latest_user_ask_not_foregrounded");
  } else if (
    !params.latestUnresolvedUserRequest &&
    !hasAskOverlap(params.summary, params.latestAsk)
  ) {
    reasons.push("latest_user_ask_not_reflected");
  }
  const retainedPendingAsk = extractLeadingPendingAsk(params.retainedTurnSummary ?? "");
  if (
    params.latestUnresolvedUserRequest
      ? retainedPendingAsk && !isEmptyPendingAsk(retainedPendingAsk)
      : params.retainedTurnSummary !== undefined &&
        resolveAskOverlapRequirement(params.latestAsk) &&
        hasAskOverlap(extractPendingAskSection(params.retainedTurnSummary), params.latestAsk)
  ) {
    reasons.push("retained_turn_ask_marked_pending");
  }
  return { ok: reasons.length === 0, reasons };
}
