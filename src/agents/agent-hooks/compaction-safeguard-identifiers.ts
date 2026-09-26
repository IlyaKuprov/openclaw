/** Extracts and budgets exact source literals for compaction summary audits. */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction.js";

const MAX_EXTRACTED_IDENTIFIERS = 40;
export const AUDITED_IDENTIFIER_CONTENT_SHARE = 0.25;
// Source literals cannot consume the whole persisted artifact: leave the other
// sections, pending ask and separately audited Results room to survive trimming.
export const MAX_AUDITED_IDENTIFIER_CHARS = Math.floor(
  MAX_COMPACTION_SUMMARY_CHARS * AUDITED_IDENTIFIER_CONTENT_SHARE,
);

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
const MEASURED_VALUE_SOURCE = String.raw`(?<![A-Za-z0-9._/\\-])(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?[ \t]*(?:Hz|kHz|MHz|GHz|mT|T|G|ppm|ms|[µμu]s|ns|s|K|%|[KMGT]i?B|B|°[CF])(?![A-Za-z0-9_-])`;
const MEASURED_VALUE_ANCHOR = new RegExp(`^${MEASURED_VALUE_SOURCE}$`, "u");

export function isResultEvidenceAnchor(identifier: string): boolean {
  return NUMERIC_RESULT_ANCHOR.test(identifier) || MEASURED_VALUE_ANCHOR.test(identifier);
}

// A dotted word alone is not a repository artifact (and may be a domain).
// Recognized file extensions plus file context or inline-code syntax keep
// ordinary prose out of the bounded source-literal audit.
const ROOT_FILENAME =
  /^[A-Za-z0-9_-]+(?:[.-][A-Za-z0-9_-]+)*\.(?:c|cc|cpp|css|csv|dat|go|h|html|java|jpeg|jpg|js|json|jsonl|jsx|lock|log|m|md|mjs|pdf|png|py|rs|sh|svg|toml|ts|tsx|txt|xml|yaml|yml|zip)$/iu;
const ROOT_FILENAME_CONTEXT =
  /(?:^|[\s;:,.])(?:modified|edited|wrote|created|generated|saved|produced|output|artifact|file|log|report)(?:\s+(?:file|artifact|as|to|at|in|is))?[\s:]+[`'"]?$/iu;

function isRootFilename(identifier: string): boolean {
  return ROOT_FILENAME.test(identifier);
}

/** Reuse the source-literal budget and unit rules for persisted result migration. */
export function extractResultEvidenceAnchors(text: string): string[] {
  return extractOpaqueIdentifiers(text).filter(isResultEvidenceAnchor);
}

function auditedIdentifierPriority(identifier: string): number {
  return isResultEvidenceAnchor(identifier)
    ? 0
    : /^(?:#\d+|PR\s+#\d+|(?:job|message|msg)(?:[-_#]|\s+id\b))/iu.test(identifier) ||
        isPureHexIdentifier(identifier)
      ? 1
      : isRootFilename(identifier)
        ? 1.5
        : identifier.startsWith("http://") || identifier.startsWith("https://")
          ? 3
          : 2;
}

export function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
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
  if ((identifier.includes("/") && !identifier.includes("://")) || isRootFilename(identifier)) {
    const literal = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_#./\\-])${literal}(?![A-Za-z0-9_./\\-])`, "u").test(summary);
  }
  return summary.includes(identifier);
}

/** Extracts bounded literal anchors: IDs, paths, test outcomes, and measured values. */
export function extractOpaqueIdentifiers(
  text: string,
  maxAuditedChars = MAX_AUDITED_IDENTIFIER_CHARS,
): string[] {
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
  const rootFiles = Array.from(
    text.matchAll(
      /(?<![A-Za-z0-9._/\\-])[A-Za-z0-9_-]+(?:[.-][A-Za-z0-9_-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_-])/gu,
    ),
    (match) => ({ index: match.index, value: match[0] }),
  ).filter(
    ({ index, value }) =>
      isRootFilename(value) &&
      ((text[index - 1] === "`" && text[index + value.length] === "`") ||
        ROOT_FILENAME_CONTEXT.test(text.slice(Math.max(0, index - 80), index))),
  );
  const labeledCommits = Array.from(
    text.matchAll(/\bcommit(?:\s+(?:hash|sha))?(?:\s*[:#]\s*|\s+)([a-f0-9]{7,40})\b/giu),
    (match) => ({ index: match.index, value: match[1] ?? "" }),
  );
  let identifiers = uniqueStrings(
    [
      ...Array.from(
        text.matchAll(
          /((?<![A-Za-z0-9_])#\d+\b|\b(?:PR\s+#\d+|(?:job|message|msg)(?:[-_#][A-Za-z0-9_-]+|\s+id(?:\s+(?:is|was)\s+|\s*[:#]?\s*)(?!(?:is|was)\b)[A-Za-z0-9_-]+))\b)|(https?:\/\/\S+|(?<![A-Za-z0-9._-])\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5})|(?:(?:(?:\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?|\d+\.[eE][+-]?\d+|\d+\.?[eE][+-]\d+|(?![A-Fa-f0-9]{8,}(?![A-Fa-f0-9]))\d+\.?[eE]\d+)(?:(?=[A-Za-z]+(?![A-Za-z0-9]))(?=[A-Za-z]*[G-Zg-z])[A-Za-z]+)?(?![A-Za-z0-9])|(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:[A-Fa-f0-9]{8,}|\d{6,}))([A-Za-z0-9_-]+))/gi,
        ),
        (match) => ({ index: match.index, value: match[1] ?? match[2] ?? match[3] ?? "" }),
      ),
      ...pathsAndResults,
      ...rootFiles,
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
  );
  // Preserve short, actionable anchors and measured outcomes before expensive
  // URLs; prioritize before either limit so late results survive an early URL flood.
  if (identifiers.length > MAX_EXTRACTED_IDENTIFIERS) {
    const retainedPositions = new Set(
      identifiers
        .map((_, position) => position)
        .toSorted((left, right) => {
          const leftPriority = auditedIdentifierPriority(identifiers[left] ?? "");
          const rightPriority = auditedIdentifierPriority(identifiers[right] ?? "");
          return leftPriority - rightPriority || (leftPriority === 3 ? right - left : left - right);
        })
        .slice(0, MAX_EXTRACTED_IDENTIFIERS),
    );
    identifiers = identifiers.filter((_, position) => retainedPositions.has(position));
  }
  return selectAuditedIdentifiers(identifiers, maxAuditedChars);
}

/** Select source facts against the actual body slot left by the compaction fit. */
export function selectAuditedIdentifiers(
  identifiers: string[],
  maxAuditedChars: number,
  availableBodyChars = Number.POSITIVE_INFINITY,
): string[] {
  if (
    identifiers.reduce((chars, identifier) => chars + identifier.length + 1, 0) <= maxAuditedChars
  ) {
    return identifiers;
  }
  const selected = new Set<number>();
  let usedChars = 0;
  const rankedIndexes = identifiers
    .map((_, position) => position)
    .toSorted(
      (left, right) =>
        auditedIdentifierPriority(identifiers[left] ?? "") -
          auditedIdentifierPriority(identifiers[right] ?? "") || right - left,
    );
  for (const index of rankedIndexes) {
    const identifier = identifiers[index] ?? "";
    const cost = identifier.length + (selected.size > 0 ? 1 : 0);
    if (usedChars + cost <= maxAuditedChars) {
      selected.add(index);
      usedChars += cost;
    }
  }
  // A single impossible literal is not a license to erase every audited fact:
  // leave it required so the retention plan fails closed as before, even
  // when shorter source facts fit beside it.
  const impossible = identifiers.some((identifier) => identifier.length > availableBodyChars);
  if (selected.size === 0 && !impossible && Number.isFinite(availableBodyChars)) {
    // A source literal can exceed its preferred share yet still fit alone.
    // Retain the best candidate rather than cancelling with the entire list.
    const firstFitting = rankedIndexes.find(
      (index) => (identifiers[index]?.length ?? 0) <= availableBodyChars,
    );
    if (firstFitting !== undefined) {
      selected.add(firstFitting);
    }
  }
  return selected.size === 0 && !impossible
    ? identifiers
    : identifiers.filter(
        (identifier, index) => selected.has(index) || identifier.length > availableBodyChars,
      );
}
