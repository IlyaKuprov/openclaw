import {
  prepareCompaction,
  type CompactionPreparation,
  type CompactionSettings,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { buildSessionContext, type AgentMessage } from "../runtime/index.js";
import type { CompactionRequestBudget } from "./compaction/request-budget.js";
import {
  estimateCompactionHistoryTokens,
  resolveCompactionRetentionBudget,
} from "./compaction/request-budget.js";
import type { SessionEntry } from "./session-manager.js";

type ManualCompactionPreflight =
  | { compactable: true; preparation: CompactionPreparation }
  | { compactable: false; reason: "Already compacted" | "Nothing to compact (session too small)" };

/** Plans manual compaction without aborting or otherwise mutating the active session. */
export function preflightManualSessionCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionSettings,
  requestBudget?: CompactionRequestBudget,
): ManualCompactionPreflight {
  const retention = requestBudget
    ? resolveCompactionRetentionBudget(requestBudget, buildSessionContext(pathEntries).messages)
    : undefined;
  const constraints =
    retention && requestBudget
      ? {
          budget: {
            ...retention,
            estimateTokens: (message: AgentMessage) =>
              estimateCompactionHistoryTokens([message], requestBudget),
          },
        }
      : undefined;
  const initial = prepareCompaction(pathEntries, settings, undefined, constraints);
  if (!initial.ok) {
    throw initial.error;
  }
  let preparation = initial.value;
  if (!preparation) {
    // Explicit manual compaction uses the smallest valid history rather than
    // treating a session that fits the configured keep budget as a no-op.
    const smallest = prepareCompaction(
      pathEntries,
      { ...settings, keepRecentTokens: 0 },
      undefined,
      constraints,
    );
    if (!smallest.ok) {
      throw smallest.error;
    }
    preparation = smallest.value;
  }
  if (preparation) {
    return { compactable: true, preparation };
  }
  return {
    compactable: false,
    reason:
      pathEntries.at(-1)?.type === "compaction"
        ? "Already compacted"
        : "Nothing to compact (session too small)",
  };
}
