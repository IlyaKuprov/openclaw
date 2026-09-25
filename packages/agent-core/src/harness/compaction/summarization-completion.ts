import {
  resolveClaudeFable5ModelIdentity,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
} from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { resolveAgentReasoningOption } from "../../reasoning.js";
import {
  type AgentCoreCompletionRuntimeDeps,
  consumeAgentCoreStream,
  resolveAgentCoreCompleteFn,
} from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import { convertToLlm } from "../messages.js";
import { CompactionError, err, InvalidSummaryOutputError, ok, type Result } from "../types.js";
import { capCompactionSummary, fitCompactionSummary } from "./compaction.js";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./summarization-prompts.js";
import { extractSummaryText, serializeConversation } from "./utils.js";

function createSummarizationOptions(
  model: Model,
  maxTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
  const fableReasoning =
    (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model) !== undefined;
  if ((model.reasoning || fableReasoning) && thinkingLevel) {
    options.reasoning = resolveAgentReasoningOption(model, thinkingLevel);
  }
  return options;
}

export interface SummarizationCompletionParams {
  messages: AgentMessage[];
  prompt: string;
  customInstructions?: string;
  previousSummary?: string;
  model: Model;
  maxTokens: number;
  apiKey: string | undefined;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  streamFn?: StreamFn;
  runtime?: AgentCoreCompletionRuntimeDeps;
  errorLabel: string;
}

/** Runs one summarization completion and maps abort/error stops to CompactionError. */
export async function runSummarizationCompletion(
  params: SummarizationCompletionParams,
): Promise<Result<string, CompactionError>> {
  const conversationText = serializeConversation(convertToLlm(params.messages));
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  const previousSummaryWrapper = `<previous-summary>\n\n</previous-summary>\n\n`;
  const focus = params.customInstructions
    ? `\n\nAdditional focus: ${params.customInstructions}`
    : "";
  const effectiveContext = Math.min(
    params.model.contextTokens ?? Infinity,
    params.model.contextWindow ?? Infinity,
  );
  const previousSummaryBudget = Math.floor(
    effectiveContext -
      params.maxTokens -
      estimateStringChars(
        SUMMARIZATION_SYSTEM_PROMPT + promptText + params.prompt + focus + previousSummaryWrapper,
      ) /
        CHARS_PER_TOKEN_ESTIMATE,
  );
  if (params.previousSummary) {
    const previousSummary = params.previousSummary;
    const fitted = fitCompactionSummary(
      Number.isFinite(previousSummaryBudget) ? previousSummaryBudget : undefined,
      (maxChars) => ({
        summary: capCompactionSummary(previousSummary, maxChars),
      }),
    );
    if (!fitted.ok) {
      return err(fitted.error);
    }
    promptText += `<previous-summary>\n${fitted.value.summary}\n</previous-summary>\n\n`;
  }
  promptText += params.prompt;
  // SDK callers also pass generated policy here; the host bounds raw operator focus.
  promptText += focus;
  const context = {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: promptText }],
        timestamp: Date.now(),
      },
    ],
  };
  const options = createSummarizationOptions(
    params.model,
    params.maxTokens,
    params.apiKey,
    params.headers,
    params.signal,
    params.thinkingLevel,
  );
  const response = params.streamFn
    ? await consumeAgentCoreStream(params.streamFn(params.model, context, options), params.runtime)
    : await resolveAgentCoreCompleteFn(params.runtime)(params.model, context, options);
  // Usage belongs to the completed provider request even when its summary is invalid.
  params.runtime?.internalUsageSink?.(response.usage);
  if (response.stopReason === "aborted") {
    return err(
      new CompactionError("aborted", response.errorMessage || `${params.errorLabel} aborted`),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `${params.errorLabel} failed: ${response.errorMessage || "Unknown error"}`,
      ),
    );
  }

  const summary = extractSummaryText(response);
  if (summary === undefined) {
    return err(
      new InvalidSummaryOutputError(`${params.errorLabel} failed: model returned no summary text`),
    );
  }
  return ok(summary);
}
