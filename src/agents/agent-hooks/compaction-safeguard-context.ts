/** Formats compaction's bounded transcript context and preserves orphan result evidence. */
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  capCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentMessage } from "../runtime/index.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import { extractOpaqueIdentifiers } from "./compaction-safeguard-identifiers.js";

const MAX_UNPAIRED_RESULT_CONTEXT_CHARS = 4_000;
export const SPLIT_TURN_SECTION_HEADING = "**Turn Context (split turn):**";
// Split-turn context supplements the generated summary and must not claim its
// guaranteed half of the final artifact before common finalization runs.
export const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);
const SPLIT_TURN_TRUNCATED_MARKER = "[Earlier split-turn messages truncated]\n";
const PRESERVED_TURNS_TRUNCATED_MARKER = "[Earlier preserved messages truncated]\n";
const MAX_RECENT_TURN_TEXT_CHARS = 1_500;
const MAX_RAW_SPLIT_TURN_TEXT_CHARS = 600;
const MAX_REQUIRED_ASK_CONTEXT_CHARS = 2_000;
const REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER = "\n[... split-turn ask context truncated ...]\n";

export type CompactionLoss =
  | "summary-tail"
  | "suffix-head"
  | "split-turn-head"
  | "split-turn-tail"
  | "preserved-turn-head";

export type ContextSection = {
  text: string;
  segmentStarts: number[];
  // Keep producer loss attached to the bounded artifact so every finalizer path
  // emits the same redacted diagnostic when the section already dropped context.
  truncatedLoss?: CompactionLoss;
};

function nestMarkdownHeadings(text: string): string {
  return text.replace(/^##(?=[ \t]+\S)/gmu, "###");
}

export function extractMessageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") {
    return content.trim();
  }
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const text =
            block && typeof block === "object" && "text" in block ? block.text : undefined;
          return typeof text === "string" && text.trim() ? [text.trim()] : [];
        })
        .join("\n")
    : "";
}

/** Replay needs paired frames, but a result whose call preceded the prepared window is still evidence. */
export function repairSummaryMessages(
  messages: AgentMessage[],
  previouslyDiscarded: AgentMessage[] = [],
): AgentMessage[] {
  const repaired = repairToolUseResultPairing(messages);
  const receipts = [...previouslyDiscarded, ...repaired.discarded]
    .filter(
      (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
        message.role === "toolResult" && !message.isError,
    )
    .map((message) => {
      const text = extractMessageText(message);
      if (!text) {
        return "";
      }
      const name = typeof message.toolName === "string" ? message.toolName : "tool";
      // Reserve space for the marker before selecting anchors, so shrinking
      // the preview cannot also hide an audited fact near its former end.
      const receiptLimit = 900;
      const anchorLimit = 240;
      const omissionPrefix = "\n[tool result content omitted";
      const evidencePrefix = `${omissionPrefix}; selected evidence: `;
      const anchorStart = receiptLimit - evidencePrefix.length - anchorLimit - 1;
      const omittedAnchors =
        text.length > receiptLimit
          ? extractOpaqueIdentifiers(text.slice(anchorStart), anchorLimit).filter(
              (anchor) => anchor.length <= anchorLimit,
            )
          : [];
      const omission =
        text.length > receiptLimit
          ? `${omissionPrefix}${omittedAnchors.length ? `; selected evidence: ${omittedAnchors.join(", ")}` : ""}]`
          : "";
      return `${truncateUtf16Safe(name, 80)}: ${truncateUtf16Safe(text, receiptLimit - omission.length)}${omission}`;
    })
    .filter(Boolean);
  const omissionMarker = "[earlier tool results omitted]";
  const retained: string[] = [];
  // Select newest complete receipts before wrapping: both the count cap and
  // the escaped-character cap can otherwise silently erase the newest result.
  let remaining = MAX_UNPAIRED_RESULT_CONTEXT_CHARS - omissionMarker.length - 1;
  for (const receipt of receipts.toReversed()) {
    if (retained.length >= 8) {
      break;
    }
    const cost =
      receipt.replace(/</gu, "&lt;").replace(/>/gu, "&gt;").length + (retained.length > 0 ? 1 : 0);
    if (cost <= remaining) {
      retained.unshift(receipt);
      remaining -= cost;
    }
  }
  const receiptText = [
    ...(retained.length < receipts.length ? [omissionMarker] : []),
    ...retained,
  ].join("\n");
  if (!receiptText) {
    return repaired.messages;
  }
  const content = wrapUntrustedPromptDataBlock({
    label: "Unpaired tool results from the compaction window",
    text: receiptText,
    maxChars: MAX_UNPAIRED_RESULT_CONTEXT_CHARS,
    maxEscapedChars: MAX_UNPAIRED_RESULT_CONTEXT_CHARS,
    truncationMarker: "\n[more tool output omitted]",
  });
  const lastTimestamp = messages.at(-1)?.timestamp;
  return [
    ...repaired.messages,
    { role: "user", content, timestamp: typeof lastTimestamp === "number" ? lastTimestamp : 0 },
  ];
}

export function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = "type" in block ? block.type : undefined;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") {
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}

function formatContextMessage(message: AgentMessage, textOnly = false): string | null {
  let roleLabel: string;
  if (message.role === "assistant") {
    roleLabel = "Assistant";
  } else if (message.role === "user") {
    roleLabel = "User";
  } else if (message.role === "toolResult") {
    if (textOnly) {
      // Verbatim recent turns carry what was said, not tool receipts.
      return null;
    }
    const toolName = "toolName" in message ? message.toolName : undefined;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [
    extractMessageText(message),
    textOnly ? null : formatNonTextPlaceholder("content" in message ? message.content : undefined),
  ]
    .filter(Boolean)
    .join("\n");
  if (!rendered) {
    return null;
  }
  const maxChars = textOnly ? MAX_RECENT_TURN_TEXT_CHARS : MAX_RAW_SPLIT_TURN_TEXT_CHARS;
  const trimmed =
    rendered.length > maxChars ? `${truncateUtf16Safe(rendered, maxChars)}...` : rendered;
  return `- ${roleLabel}: ${trimmed}`;
}

function formatContextSegments(messages: AgentMessage[], textOnly = false): string[] {
  const pairing = classifyToolUseResultPairing(messages);
  // A call-bearing assistant and all occurrence-matched results are one context
  // atom; keeping remainder messages separate lets later terminal text survive.
  const toolSegments = new Map<AgentMessage, AgentMessage[]>(
    pairing.frames.map((frame) => [
      frame.assistant,
      [
        frame.assistant,
        ...frame.occurrences.flatMap((occurrence) =>
          occurrence.sourceResult ? [occurrence.sourceResult] : [],
        ),
      ],
    ]),
  );
  return messages.flatMap((message) => {
    if (message.role === "toolResult") {
      // Paired results render with their assistant message; unclaimed results
      // are unsafe context because their owning call is absent or ambiguous.
      return [];
    }
    const lines = (toolSegments.get(message) ?? [message])
      .map((segmentMessage) => formatContextMessage(segmentMessage, textOnly))
      .filter((line): line is string => Boolean(line));
    return lines.length > 0 ? [lines.join("\n")] : [];
  });
}

function formatBoundedContextSection(params: {
  messages: AgentMessage[];
  heading: string;
  maxChars: number;
  truncatedMarker: string;
  truncatedLoss: CompactionLoss;
  onTruncated?: () => void;
  /** Render only user and assistant text: no tool results, no non-text placeholders. */
  textOnly?: boolean;
}): ContextSection {
  const segments = formatContextSegments(params.messages, params.textOnly === true);
  if (segments.length === 0) {
    return { text: "", segmentStarts: [] };
  }

  const completePrefix = `${params.heading}\n`;
  const complete = `${completePrefix}${segments.join("\n")}`;
  if (complete.length <= params.maxChars) {
    let offset = completePrefix.length;
    return {
      text: complete,
      segmentStarts: segments.map((segment) => {
        const start = offset;
        offset += segment.length + 1;
        return start;
      }),
    };
  }

  const prefix = `${completePrefix}${params.truncatedMarker}`;
  const retained: string[] = [];
  let usedChars = prefix.length;
  for (const segment of segments.toReversed()) {
    const segmentChars = segment.length + (retained.length > 0 ? 1 : 0);
    if (usedChars + segmentChars > params.maxChars) {
      break;
    }
    retained.unshift(segment);
    usedChars += segmentChars;
  }
  params.onTruncated?.();
  let offset = prefix.length;
  return {
    text: `${prefix}${retained.join("\n")}`,
    segmentStarts: retained.map((segment) => {
      const start = offset;
      offset += segment.length + 1;
      return start;
    }),
    truncatedLoss: params.truncatedLoss,
  };
}

export function buildPreservedTurnsSection(
  messages: AgentMessage[],
): ContextSection & { needsSummarization: boolean } {
  const section = formatBoundedContextSection({
    messages,
    heading: "\n\n## Recent turns preserved verbatim",
    maxChars: MAX_SPLIT_TURN_CONTEXT_CHARS,
    truncatedMarker: PRESERVED_TURNS_TRUNCATED_MARKER,
    truncatedLoss: "preserved-turn-head",
    textOnly: true,
  });
  return {
    ...section,
    // Neither an evicted message nor the clipped tail of a single long turn is
    // present in the verbatim suffix. Feed the full window to the summarizer.
    needsSummarization:
      Boolean(section.truncatedLoss) ||
      messages.some(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          extractMessageText(message).length > MAX_RECENT_TURN_TEXT_CHARS,
      ),
  };
}

export function buildSplitTurnContextSection(
  messages: AgentMessage[],
  onTruncated?: () => void,
): ContextSection {
  return formatBoundedContextSection({
    messages,
    heading: "**Turn Context (split turn):**\n",
    maxChars: MAX_SPLIT_TURN_CONTEXT_CHARS,
    truncatedMarker: SPLIT_TURN_TRUNCATED_MARKER,
    truncatedLoss: "split-turn-head",
    onTruncated,
  });
}

export function formatGeneratedSplitTurnSection(summary: string, onTruncated?: () => void): string {
  const heading = `${SPLIT_TURN_SECTION_HEADING}\n\n`;
  const summaryBudget = MAX_SPLIT_TURN_CONTEXT_CHARS - heading.length;
  const nestedSummary = nestMarkdownHeadings(summary);
  const cappedSummary = capCompactionSummary(nestedSummary, summaryBudget);
  if (cappedSummary.length < nestedSummary.length) {
    onTruncated?.();
  }
  return `${heading}${cappedSummary}`;
}

export function formatRequiredAskContext(rawAsk: string): string {
  const source = rawAsk.trim();
  if (source.length <= MAX_REQUIRED_ASK_CONTEXT_CHARS) {
    return source;
  }
  const contentBudget =
    MAX_REQUIRED_ASK_CONTEXT_CHARS - REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${truncateUtf16Safe(source, headBudget)}${REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(source, -tailBudget)}`;
}

export function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.role === "user") {
      const ask = extractMessageText(message);
      if (ask) {
        return ask;
      }
    }
  }
  return null;
}
