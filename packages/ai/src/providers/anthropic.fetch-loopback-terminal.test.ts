import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  type AiModelFetchOptions,
  type AiModelTransportEvent,
} from "../host.js";
import type { Model } from "../types.js";
import {
  context,
  createStandaloneDoneBody,
  makeModel,
  observeTestFetchDispatch,
  serializeSse,
} from "./anthropic.fetch-loopback.test-support.js";
import { streamAnthropic } from "./anthropic.js";

async function runTerminalCompletenessCase(params: {
  enableBlockingGuard?: boolean;
  endpointClass: "anthropic-public" | "custom";
  events: Record<string, unknown>[];
  modelId?: string;
  onPayload?: NonNullable<Parameters<typeof streamAnthropic>[2]>["onPayload"];
  provider?: string;
  rawBody?: string;
  requestId?: string;
  transportEvents?: AiModelTransportEvent[];
}) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(params.rawBody ?? serializeSse(params.events));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const model = makeModel({
    baseUrl: `http://127.0.0.1:${address.port}`,
    ...(params.modelId ? { id: params.modelId } : {}),
    provider: params.provider ?? "anthropic",
  });
  const buildAttestedFetch = (
    _model: Model,
    _timeout: number | undefined,
    options: AiModelFetchOptions | undefined,
  ) => ({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      observeTestFetchDispatch(options, input, init);
      const response = globalThis.fetch(input, init);
      options?.onPhysicalFetchDispatch?.();
      options?.onFetchDispatch?.();
      return await response;
    },
    provenance: "dispatch_attested" as const,
  });
  configureAiTransportHost({
    buildModelFetchWithDispatchAttestation: buildAttestedFetch,
    ...(params.enableBlockingGuard
      ? { buildModelFetchWithBlockingDispatchGuard: buildAttestedFetch }
      : {}),
    ...(params.transportEvents
      ? {
          observeModelTransportEvent: (event) => params.transportEvents?.push(event),
        }
      : {}),
    resolveProviderEndpointClass: () => params.endpointClass,
  });

  try {
    return await streamAnthropic(model, context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
      ...(params.onPayload ? { onPayload: params.onPayload } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
    }).result();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  configureAiTransportHost({});
});

describe("Anthropic SDK terminal completeness", () => {
  it.each([
    {
      label: "rejects direct EOF after a mapped stop reason",
      endpointClass: "anthropic-public" as const,
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects official-endpoint EOF through a provider alias",
      endpointClass: "anthropic-public" as const,
      provider: "provider-alias",
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts compatible EOF after a mapped stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_mapped_eof",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "stop",
    },
    {
      label: "rejects boundary-aligned compatible EOF without terminal evidence",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_eof",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "complete" },
        },
        { type: "content_block_stop", index: 0 },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects compatible clean EOF for refusal-buffered models",
      endpointClass: "custom" as const,
      modelId: "claude-opus-5",
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_refusal_buffer_eof",
            model: "claude-opus-5",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "must remain buffered" },
        },
        { type: "content_block_stop", index: 0 },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts compatible standalone DONE",
      endpointClass: "custom" as const,
      events: [],
      rawBody: createStandaloneDoneBody(),
      expectedStopReason: "stop",
    },
    {
      label: "rejects official standalone DONE",
      endpointClass: "anthropic-public" as const,
      events: [],
      rawBody: createStandaloneDoneBody(),
      expectedStopReason: "error",
    },
    {
      label: "rejects compatible partial EOF without a stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects message_stop without a terminal message_delta",
      endpointClass: "anthropic-public" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_sdk_without_delta",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "message_stop" },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects a reused content block index on a compatible endpoint",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_sdk_reused_block_index",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects a truncated model payload under an unknown event envelope",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_tail_prefix",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}event: vendor_ping\ndata: {"type":"content_block_delta"`,
      expectedStopReason: "error",
    },
    {
      label: "rejects a complete model payload under an unknown event envelope",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_unknown_envelope",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}event: vendor_ping\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hidden"}}\n\n`,
      expectedStopReason: "error",
    },
    {
      label: "ignores an identifiable truncated unlabelled ping",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_ping_tail",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}data: {"type":"ping"`,
      expectedStopReason: "stop",
    },
    {
      label: "rejects an SSE envelope whose event name disagrees with its payload",
      endpointClass: "anthropic-public" as const,
      events: [],
      rawBody: 'event: message_start\ndata: {"type":"message_stop"}\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects data-only Anthropic message frames",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'data: {"type":"message_start","message":{"id":"msg_data_only","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: [DONE]\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects a final bare event field that clears the event name",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'event: message_start\nevent\ndata: {"type":"message_start","message":{"id":"msg_bare_event","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: [DONE]\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects a double-space event name like the Anthropic SDK",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'event:  message_start\ndata: {"type":"message_start","message":{"id":"msg_double_space","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects a trailing-space event name like the Anthropic SDK",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'event: message_start \ndata: {"type":"message_start","message":{"id":"msg_trailing_space","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      expectedStopReason: "error",
    },
  ])(
    "$label",
    async ({ endpointClass, events, expectedStopReason, modelId, provider, rawBody }) => {
      const result = await runTerminalCompletenessCase({
        endpointClass,
        events,
        modelId,
        provider,
        rawBody,
      });

      expect(result.stopReason).toBe(expectedStopReason);
      if (expectedStopReason === "error") {
        expect(result.errorMessage).toContain("ended before message_stop");
      }
    },
  );

  it("preserves multiline repaired text indentation like the Anthropic SDK", async () => {
    const rawBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_multiline","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"C:\\q\ndata:   second"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    ].join("");

    const result = await runTerminalCompletenessCase({
      endpointClass: "custom",
      events: [],
      rawBody,
    });

    expect(result.content).toEqual([{ type: "text", text: "C:\\q\n  second" }]);
  });

  it.each([
    { label: "truncated JSON", data: '{"type":' },
    {
      label: "a malformed escape that JSON repair could normalize",
      data: '{"type":"vendor_ping","path":"C:\\q"}',
    },
  ])("ignores $label under an unknown vendor envelope", async ({ data }) => {
    const rawBody = `${serializeSse([
      {
        type: "message_start",
        message: {
          id: "msg_sdk_unknown_malformed",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ])}event: vendor_ping\ndata: ${data}\n\n${serializeSse([
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ])}`;

    const result = await runTerminalCompletenessCase({
      endpointClass: "custom",
      events: [],
      rawBody,
    });

    expect(result.stopReason).toBe("stop");
  });
});
