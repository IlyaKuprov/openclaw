import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AiModelTransportEvent } from "../host.js";
import {
  closeOpenAICodexWebSocketSessions,
  streamOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import {
  attemptEvents,
  chatGptModel,
  completedSseEvent,
  completedSseResponse,
  configureAttestedTransportObserver,
  connectionEvents,
  context,
  coverageEvents,
  createJwt,
  fallbackEvents,
  providerFallbackEvents,
  resetOpenAITransportAccountingTestState,
  submissionEvents,
} from "./openai-provider-transport-accounting.test-support.js";

afterEach(resetOpenAITransportAccountingTestState);

async function listen(server: Server | WebSocketServer): Promise<AddressInfo> {
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  return server.address() as AddressInfo;
}

async function closeServer(server: Server | WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("OpenAI native WebSocket authority", () => {
  it("orders handshake and event authority and reuses cached handshake metadata", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await listen(server);
    server.on("headers", (headers) => {
      headers.push("OpenAI-Model: gpt-5.5-handshake");
    });
    let connectionCount = 0;
    let responseCount = 0;
    server.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", () => {
        responseCount += 1;
        socket.send(
          JSON.stringify(
            completedSseEvent(`resp_ws_handshake_${responseCount}`, {
              model: "ignored-raw-response-model",
              ...(responseCount === 1
                ? { responseHeaders: { "openai-model": "gpt-5.5-event" } }
                : {}),
            }),
          ),
        );
      });
    });
    const model = {
      ...chatGptModel,
      baseUrl: `http://127.0.0.1:${address.port}`,
    };
    const sessionId = "ws-handshake-accounting";

    try {
      const first = await streamOpenAICodexResponses(model, context, {
        apiKey: createJwt(),
        transport: "websocket-cached",
        sessionId,
        requestId: "call-ws-handshake-first",
      }).result();
      const second = await streamOpenAICodexResponses(model, context, {
        apiKey: createJwt(),
        transport: "websocket-cached",
        sessionId,
        requestId: "call-ws-handshake-second",
      }).result();

      expect(first.responseModel).toBe("gpt-5.5-event");
      expect(second.responseModel).toBe("gpt-5.5-handshake");
      expect(connectionCount).toBe(1);
      expect(attemptEvents(events)).toHaveLength(2);
      expect(providerFallbackEvents(events)).toMatchObject([
        {
          callId: "call-ws-handshake-first",
          fromModel: chatGptModel.id,
          toModel: "gpt-5.5-handshake",
        },
        {
          callId: "call-ws-handshake-first",
          fromModel: "gpt-5.5-handshake",
          toModel: "gpt-5.5-event",
        },
        {
          callId: "call-ws-handshake-second",
          fromModel: chatGptModel.id,
          toModel: "gpt-5.5-handshake",
        },
      ]);
      expect(coverageEvents(events)).toEqual([]);
    } finally {
      closeOpenAICodexWebSocketSessions(sessionId);
      await closeServer(server);
    }
  });

  it("treats an observed handshake without a model header as complete authority", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await listen(server);
    server.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify(completedSseEvent("resp_ws_no_handshake_model")));
      });
    });
    const sessionId = "ws-handshake-no-model";

    try {
      const result = await streamOpenAICodexResponses(
        { ...chatGptModel, baseUrl: `http://127.0.0.1:${address.port}` },
        context,
        {
          apiKey: createJwt(),
          transport: "websocket-cached",
          sessionId,
          requestId: "call-ws-no-handshake-model",
        },
      ).result();

      expect(result.responseModel).toBeUndefined();
      expect(providerFallbackEvents(events)).toEqual([]);
      expect(coverageEvents(events)).toMatchObject([
        {
          scope: "provider_fallbacks",
          state: "lower_bound",
          reason: "terminal_metadata_unavailable",
        },
      ]);
      expect(
        coverageEvents(events).some(
          (event) => event.reason === "transport_endpoint_authority_partial",
        ),
      ).toBe(false);
    } finally {
      closeOpenAICodexWebSocketSessions(sessionId);
      await closeServer(server);
    }
  });

  it("keeps concurrent handshake authority scoped to its physical socket", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await listen(server);
    server.on("headers", (headers, request) => {
      headers.push(`OpenAI-Model: ${String(request.headers.session_id)}`);
    });
    server.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify(completedSseEvent("resp_ws_concurrent")));
      });
    });
    const model = {
      ...chatGptModel,
      baseUrl: `http://127.0.0.1:${address.port}`,
    };
    const sessionIds = ["ws-authority-a", "ws-authority-b"] as const;

    try {
      const [first, second] = await Promise.all([
        streamOpenAICodexResponses(model, context, {
          apiKey: createJwt(),
          transport: "websocket-cached",
          sessionId: sessionIds[0],
          requestId: `call-${sessionIds[0]}`,
        }).result(),
        streamOpenAICodexResponses(model, context, {
          apiKey: createJwt(),
          transport: "websocket-cached",
          sessionId: sessionIds[1],
          requestId: `call-${sessionIds[1]}`,
        }).result(),
      ]);

      expect(first.responseModel).toBe(sessionIds[0]);
      expect(second.responseModel).toBe(sessionIds[1]);
      expect(providerFallbackEvents(events)).toMatchObject([
        { callId: `call-${sessionIds[0]}`, toModel: sessionIds[0] },
        { callId: `call-${sessionIds[1]}`, toModel: sessionIds[1] },
      ]);
      expect(coverageEvents(events)).toEqual([]);
    } finally {
      for (const sessionId of sessionIds) {
        closeOpenAICodexWebSocketSessions(sessionId);
      }
      await closeServer(server);
    }
  });

  it("accounts real pre-upgrade refusal and caller abort without endpoint authority", async () => {
    const refusalEvents: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(refusalEvents);
    const refusingServer = createServer();
    refusingServer.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    });
    refusingServer.listen(0, "127.0.0.1");
    const refusalAddress = await listen(refusingServer);

    try {
      const refused = await streamOpenAICodexResponses(
        { ...chatGptModel, baseUrl: `http://127.0.0.1:${refusalAddress.port}` },
        context,
        {
          apiKey: createJwt(),
          transport: "websocket",
          requestId: "call-ws-real-refusal",
        },
      ).result();

      expect(refused.stopReason).toBe("error");
      expect(connectionEvents(refusalEvents)).toMatchObject([{ outcome: "failed" }]);
      expect(submissionEvents(refusalEvents)).toMatchObject([
        { transport: "native-codex-websocket", total: 0, outcome: "failed" },
      ]);
      expect(attemptEvents(refusalEvents)).toEqual([]);
      expect(coverageEvents(refusalEvents)).toEqual([]);
    } finally {
      await closeServer(refusingServer);
    }

    const abortEvents: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(abortEvents);
    const hangingSockets = new Set<{ destroy(): void }>();
    let observeUpgrade: (() => void) | undefined;
    const upgradeSeen = new Promise<void>((resolve) => {
      observeUpgrade = resolve;
    });
    const hangingServer = createServer();
    hangingServer.on("upgrade", (_request, socket) => {
      hangingSockets.add(socket);
      observeUpgrade?.();
    });
    hangingServer.listen(0, "127.0.0.1");
    const abortAddress = await listen(hangingServer);
    const controller = new AbortController();

    try {
      const stream = streamOpenAICodexResponses(
        { ...chatGptModel, baseUrl: `http://127.0.0.1:${abortAddress.port}` },
        context,
        {
          apiKey: createJwt(),
          transport: "websocket",
          requestId: "call-ws-real-upgrade-abort",
          signal: controller.signal,
        },
      );
      await upgradeSeen;
      controller.abort();
      const aborted = await stream.result();

      expect(aborted.stopReason).toBe("aborted");
      expect(connectionEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);
      expect(submissionEvents(abortEvents)).toMatchObject([
        { transport: "native-codex-websocket", total: 0, outcome: "aborted" },
      ]);
      expect(attemptEvents(abortEvents)).toEqual([]);
      expect(coverageEvents(abortEvents)).toEqual([]);
    } finally {
      for (const socket of hangingSockets) {
        socket.destroy();
      }
      await closeServer(hangingServer);
    }
  });

  it("buffers a response that arrives before the Node send callback", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await listen(server);
    server.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify(completedSseEvent("resp_ws_before_callback")));
      });
    });
    const originalSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) {
      const onSent =
        typeof optionsOrCallback === "function"
          ? (optionsOrCallback as (error?: Error) => void)
          : callback;
      return (
        originalSend as unknown as (
          this: WebSocket,
          data: unknown,
          callback: (error?: Error) => void,
        ) => void
      ).call(this, data, (error?: Error) => {
        setTimeout(() => onSent?.(error), 20);
      });
    } as WebSocket["send"]);

    try {
      const result = await streamOpenAICodexResponses(
        { ...chatGptModel, baseUrl: `http://127.0.0.1:${address.port}` },
        context,
        {
          apiKey: createJwt(),
          transport: "websocket",
          requestId: "call-ws-response-before-callback",
        },
      ).result();

      expect(result.stopReason).toBe("stop");
      expect(result.responseId).toBe("resp_ws_before_callback");
      expect(attemptEvents(events)).toMatchObject([
        { transport: "native-codex-websocket", outcome: "completed" },
      ]);
      expect(submissionEvents(events)).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("treats a Node ws send callback error as an admitted failed attempt without fallback", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await listen(server);
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) {
      const onSent =
        typeof optionsOrCallback === "function"
          ? (optionsOrCallback as (error?: Error) => void)
          : callback;
      queueMicrotask(() => onSent?.(new Error("private callback send failure")));
    } as WebSocket["send"]);
    const fetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetch);

    try {
      const result = await streamOpenAICodexResponses(
        { ...chatGptModel, baseUrl: `http://127.0.0.1:${address.port}` },
        context,
        {
          apiKey: createJwt(),
          transport: "auto",
          requestId: "call-ws-callback-send-failure",
        },
      ).result();

      expect(result.stopReason).toBe("error");
      expect(send).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
      expect(submissionEvents(events)).toEqual([]);
      expect(fallbackEvents(events)).toEqual([]);
      expect(attemptEvents(events)).toMatchObject([
        {
          transport: "native-codex-websocket",
          ordinal: 1,
          reason: "initial",
          outcome: "failed",
        },
      ]);
      expect(
        events
          .filter((event) => event.type === "connection" || event.type === "attempt")
          .map((event) => event.type),
      ).toEqual(["connection", "attempt"]);
    } finally {
      await closeServer(server);
    }
  });

  it("aborts an admitted Node send while its write callback is pending without fallback", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureAttestedTransportObserver(events);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await listen(server);
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      _data: unknown,
      _optionsOrCallback?: unknown,
      _callback?: (error?: Error) => void,
    ) {
      queueMicrotask(() => controller.abort());
    } as WebSocket["send"]);
    const terminate = vi.spyOn(WebSocket.prototype, "terminate");
    const fetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetch);

    try {
      const result = await streamOpenAICodexResponses(
        { ...chatGptModel, baseUrl: `http://127.0.0.1:${address.port}` },
        context,
        {
          apiKey: createJwt(),
          transport: "auto",
          signal: controller.signal,
          requestId: "call-ws-pending-callback-abort",
        },
      ).result();

      expect(result.stopReason).toBe("aborted");
      expect(send).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect(submissionEvents(events)).toEqual([]);
      expect(fallbackEvents(events)).toEqual([]);
      expect(attemptEvents(events)).toMatchObject([
        {
          transport: "native-codex-websocket",
          ordinal: 1,
          reason: "initial",
          outcome: "aborted",
        },
      ]);
    } finally {
      await closeServer(server);
    }
  });
});
