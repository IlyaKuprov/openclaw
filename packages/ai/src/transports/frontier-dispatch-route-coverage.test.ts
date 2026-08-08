import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type FrontierDispatchRoute =
  | "anthropic-messages/builtin"
  | "anthropic-messages/managed"
  | "azure-openai-responses/managed"
  | "openai-chatgpt-responses/managed"
  | "openai-chatgpt-responses/native-sse"
  | "openai-chatgpt-responses/native-websocket"
  | "openai-responses/managed";

type RouteProof = {
  callbackProof: URL;
  callbackMarkers: readonly string[];
  behaviorProof: URL;
  behaviorMarkers: readonly string[];
};

const FRONTIER_DISPATCH_ROUTES = {
  "anthropic-messages/builtin": {
    callbackProof: new URL("../providers/anthropic.fetch-loopback.test.ts", import.meta.url),
    callbackMarkers: ["options?.onPhysicalFetchDispatch?.();", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("../providers/anthropic.fetch-loopback.test.ts", import.meta.url),
    behaviorMarkers: ["counts each SDK retry at guarded fetch dispatch", 'type: "dispatch"'],
  },
  "anthropic-messages/managed": {
    callbackProof: new URL("./anthropic-transport-stream.test.ts", import.meta.url),
    callbackMarkers: ["options?.onPhysicalFetchDispatch?.();", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("./anthropic-transport-stream.test.ts", import.meta.url),
    behaviorMarkers: [
      "records $expectedOutcome accounting for native standalone DONE",
      'type: "dispatch"',
    ],
  },
  "azure-openai-responses/managed": {
    callbackProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    callbackMarkers: [
      "retains Azure dispatch accounting from a legacy-only attested host",
      "options.onFetchDispatch?.();",
    ],
    behaviorProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    behaviorMarkers: ["call-azure-legacy-only", "dispatchEvents(events)"],
  },
  "openai-chatgpt-responses/managed": {
    callbackProof: new URL(
      "./openai-provider-transport-accounting.test-support.ts",
      import.meta.url,
    ),
    callbackMarkers: ["options?.onPhysicalFetchDispatch?.();", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    behaviorMarkers: [
      "executes the managed ChatGPT route with physical dispatch accounting",
      "call-chatgpt-managed",
      "dispatchEvents(events)",
    ],
  },
  "openai-chatgpt-responses/native-sse": {
    callbackProof: new URL(
      "./openai-provider-transport-accounting.native.test.ts",
      import.meta.url,
    ),
    callbackMarkers: ["options.onPhysicalFetchDispatch?.();", "options.onFetchDispatch?.();"],
    behaviorProof: new URL(
      "./openai-provider-transport-accounting.native.test.ts",
      import.meta.url,
    ),
    behaviorMarkers: [
      "uses native SSE header authority and nested event-header precedence",
      "dispatchEvents(events)",
    ],
  },
  "openai-chatgpt-responses/native-websocket": {
    callbackProof: new URL("../providers/openai-chatgpt-responses.ts", import.meta.url),
    callbackMarkers: ["submitWebSocketFrame", "transportAccounting.observeDispatch"],
    behaviorProof: new URL(
      "./openai-provider-transport-accounting.native.test.ts",
      import.meta.url,
    ),
    behaviorMarkers: ["uses nested WebSocket event headers", "dispatchEvents(events)"],
  },
  "openai-responses/managed": {
    callbackProof: new URL(
      "./openai-provider-transport-accounting.test-support.ts",
      import.meta.url,
    ),
    callbackMarkers: ["options?.onPhysicalFetchDispatch?.();", "options?.onFetchDispatch?.();"],
    behaviorProof: new URL("./openai-provider-transport-accounting.test.ts", import.meta.url),
    behaviorMarkers: [
      "records SDK retries from physical fetches, not retry headers",
      "dispatchEvents(events)",
      "attemptEvents(events)",
    ],
  },
} as const satisfies Record<FrontierDispatchRoute, RouteProof>;

describe("frontier physical-dispatch route coverage", () => {
  it("keeps every supported frontier producer variant explicit", () => {
    expect(Object.keys(FRONTIER_DISPATCH_ROUTES)).toEqual([
      "anthropic-messages/builtin",
      "anthropic-messages/managed",
      "azure-openai-responses/managed",
      "openai-chatgpt-responses/managed",
      "openai-chatgpt-responses/native-sse",
      "openai-chatgpt-responses/native-websocket",
      "openai-responses/managed",
    ]);
  });

  it.each(Object.entries(FRONTIER_DISPATCH_ROUTES))(
    "%s exercises the callback and validates emitted dispatch behavior",
    async (_route, proof) => {
      const [callbackSource, behaviorSource] = await Promise.all([
        readFile(fileURLToPath(proof.callbackProof), "utf8"),
        readFile(fileURLToPath(proof.behaviorProof), "utf8"),
      ]);

      for (const marker of proof.callbackMarkers) {
        expect(callbackSource).toContain(marker);
      }
      for (const marker of proof.behaviorMarkers) {
        expect(behaviorSource).toContain(marker);
      }
    },
  );
});
