import type { AiModelFetchOptions } from "../host.js";
import type { Context, Model } from "../types.js";

export const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

export function makeModel(overrides: Partial<Model<"anthropic-messages">>) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

export function serializeSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

export function createStandaloneDoneBody(done = "[DONE]"): string {
  return `${serializeSse([
    {
      type: "message_start",
      message: {
        id: "msg_standalone_done",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
  ])}data: ${done}\n\n`;
}

export function observeTestFetchDispatch(
  options: AiModelFetchOptions | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): void {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  options?.observeFetchDispatch?.({ url, init: init ?? {} });
}
