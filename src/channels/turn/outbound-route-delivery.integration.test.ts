// Host route decisions are exercised through the real channel-turn delivery entry point.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPendingDeliveries } from "../../infra/outbound/delivery-queue.test-helpers.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createDispatch,
  createDurableSendResult,
  expectDispatched,
  type DurableSendRequest,
} from "./run-channel-turn.delivery.test-helpers.js";

const loadExactSessionEntryReadOnly = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const sendDurableMessageBatch = vi.hoisted(() => vi.fn());
const resolveOutboundDurableFinalDeliverySupport = vi.hoisted(() => vi.fn());
const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/session-accessor.entry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.entry.js")>()),
  loadExactSessionEntryReadOnly,
}));
vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/dispatch.js")>()),
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
}));
vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/deliver.js")>()),
  resolveOutboundDurableFinalDeliverySupport,
}));
vi.mock("../message/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../message/send.js")>()),
  sendDurableMessageBatchCore: sendDurableMessageBatch,
}));
vi.mock("../session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.js")>()),
  recordInboundSession: vi.fn(async () => undefined),
}));
vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner,
}));
vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

const cfg = {} as OpenClawConfig;
const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-outbound-route-" });
function latestDurableSendRequest(): DurableSendRequest {
  const request = sendDurableMessageBatch.mock.lastCall?.[0] as DurableSendRequest | undefined;
  if (!request) {
    throw new Error("expected durable send request");
  }
  return request;
}

describe("channel lifecycle outbound route decision", () => {
  beforeAll(() => tempDirs.setup());
  afterAll(() => tempDirs.cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    loadExactSessionEntryReadOnly.mockReset();
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch());
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
    getGlobalHookRunner.mockReturnValue(null);
  });
  afterEach(() => vi.useRealTimers());

  const slackSessionKey = "agent:main:slack:channel:c123:thread:1712345678.123456";
  const slackRoute = {
    channel: "slack",
    to: "channel:C123",
    accountId: "work",
    threadPolicy: "root",
  } as const;

  function enableSlackRootDecision() {
    const runOutboundRouteDecision = vi.fn(async () => slackRoute);
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "outbound_route_decision",
      runOutboundRouteDecision,
    });
    loadExactSessionEntryReadOnly.mockReturnValue({
      sessionKey: slackSessionKey,
      entry: {
        delivery: {
          kind: "external",
          context: {
            channel: "slack",
            to: "channel:C123",
            accountId: "work",
            threadId: "1712345678.123456",
          },
        },
      },
    });
    return runOutboundRouteDecision;
  }

  it("routes a webchat-origin final into its persisted Slack channel, never webchat direct", async () => {
    const routeHook = enableSlackRootDecision();
    const direct = vi.fn(async () => ({ messageIds: ["wrong-surface"] }));
    sendDurableMessageBatch.mockResolvedValue(createDurableSendResult(["slack-root"]));
    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "webchat",
      accountId: "web",
      route: { agentId: "main", sessionKey: slackSessionKey },
      ctxPayload: createCtx({
        SessionKey: slackSessionKey,
        Surface: "webchat",
        OriginatingTo: "webchat-client",
        MessageThreadId: "1712345678.123456",
      }),
      delivery: { deliver: direct },
    });
    expectDispatched(result);
    expect(routeHook).toHaveBeenCalledWith(
      {
        sessionKey: slackSessionKey,
        original: {
          channel: "webchat",
          to: "webchat-client",
          accountId: "web",
          threadId: "1712345678.123456",
        },
      },
      { channelId: "slack" },
      expect.objectContaining({ to: "channel:C123", accountId: "work" }),
    );
    expect(direct).not.toHaveBeenCalled();
    expect(latestDurableSendRequest()).toMatchObject({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      session: { key: slackSessionKey },
      threadId: null,
      replyToId: null,
      routeAuthority: {
        agentId: "main",
        sessionKey: slackSessionKey,
        channel: "slack",
        to: "channel:C123",
        accountId: "work",
      },
    });
    expect(latestDurableSendRequest().payloads?.[0]?.replyToId).toBeUndefined();
    expect(latestDurableSendRequest().assertBeforeQueueAdmission).toEqual(expect.any(Function));
  });

  it("selects the root before source preparation can flush deferred provider media", async () => {
    enableSlackRootDecision();
    const sourceVisibleSend = vi.fn();
    const preparePayload = vi.fn(async (payload: { text?: string }) => {
      // WhatsApp's preparer flushes previously deferred media before returning a payload.
      sourceVisibleSend("deferred-media");
      return { ...payload, text: `${payload.text} (source prepared)` };
    });
    const sourceDurable = vi.fn(() => ({ to: "source-conversation" }));
    const sourceDirect = vi.fn();
    const onDelivered = vi.fn();
    sendDurableMessageBatch.mockResolvedValue(createDurableSendResult(["slack-root"]));

    await dispatchRoutedChannelTurn({
      cfg,
      channel: "whatsapp",
      route: { agentId: "main", sessionKey: slackSessionKey },
      ctxPayload: createCtx({ SessionKey: slackSessionKey, Surface: "whatsapp" }),
      delivery: {
        preparePayload,
        durable: sourceDurable,
        deliver: sourceDirect,
        onDelivered,
      },
    });

    expect(sourceVisibleSend).not.toHaveBeenCalled();
    expect(preparePayload).not.toHaveBeenCalled();
    expect(sourceDurable).not.toHaveBeenCalled();
    expect(sourceDirect).not.toHaveBeenCalled();
    expect(latestDurableSendRequest()).toMatchObject({
      channel: "slack",
      to: "channel:C123",
      payloads: [{ text: "reply" }],
      threadId: null,
      rootReplyOnly: true,
    });
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "reply" },
      { kind: "final" },
      expect.objectContaining({ messageIds: ["slack-root"], visibleReplySent: true }),
    );
  });

  it.each(["block", "tool"] as const)(
    "does not leak a visible %s through the source provider before the chosen owner settles",
    async (kind) => {
      const routeHook = enableSlackRootDecision();
      const sourceVisibleSend = vi.fn();
      const preparePayload = vi.fn(async (payload: { text?: string }) => {
        sourceVisibleSend("deferred-media");
        return payload;
      });
      const sourceDurable = vi.fn(() => ({ to: "source-conversation" }));
      const sourceDirect = vi.fn(async () => {
        sourceVisibleSend("direct");
        return { visibleReplySent: true };
      });
      const onDelivered = vi.fn();
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
        const dispatcher = createReplyDispatcher(params.dispatcherOptions);
        if (kind === "block") {
          dispatcher.sendBlockReply({ text: "progress" });
        } else {
          dispatcher.sendToolResult({ text: "progress" });
        }
        dispatcher.markComplete();
        const settledReceipt = await dispatcher.waitForIdle();
        return {
          queuedFinal: false,
          counts: { tool: Number(kind === "tool"), block: Number(kind === "block"), final: 0 },
          settledReceipt,
        };
      });

      const result = await dispatchRoutedChannelTurn({
        cfg,
        channel: "whatsapp",
        route: { agentId: "main", sessionKey: slackSessionKey },
        ctxPayload: createCtx({ SessionKey: slackSessionKey, Surface: "whatsapp" }),
        delivery: {
          preparePayload,
          durable: sourceDurable,
          deliver: sourceDirect,
          observeMessageSent: true,
          onDelivered,
        },
      });

      expectDispatched(result);
      expect(routeHook).toHaveBeenCalledOnce();
      expect(sourceVisibleSend).not.toHaveBeenCalled();
      expect(preparePayload).not.toHaveBeenCalled();
      expect(sourceDurable).not.toHaveBeenCalled();
      expect(sourceDirect).not.toHaveBeenCalled();
      expect(sendDurableMessageBatch).not.toHaveBeenCalled();
      expect(onDelivered).toHaveBeenCalledWith(
        { text: "progress" },
        expect.objectContaining({ kind }),
        expect.objectContaining({ visibleReplySent: false, suppression: expect.anything() }),
      );
      expect(result.dispatchResult.settledReceipt).toMatchObject({
        anyVisibleDelivered: false,
        counts: { [kind]: { deliveredNotVisible: 1 } },
      });
    },
  );

  it("forces a direct Slack final with local media to the durable channel root", async () => {
    enableSlackRootDecision();
    const direct = vi.fn(async () => ({ messageIds: ["wrong-thread"] }));
    sendDurableMessageBatch.mockResolvedValue(createDurableSendResult(["slack-root"]));
    const mediaPath = path.join(await tempDirs.make(), "report.png");
    await fs.writeFile(mediaPath, "local image bytes");
    const mediaPayload = {
      text: "report",
      mediaUrl: mediaPath,
      replyToId: "old-thread",
    };
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
      createDispatch([], mediaPayload),
    );
    await dispatchRoutedChannelTurn({
      cfg: { tools: { profile: "full" } },
      channel: "slack",
      accountId: "work",
      route: { agentId: "main", sessionKey: slackSessionKey },
      ctxPayload: createCtx({
        SessionKey: slackSessionKey,
        Surface: "slack",
        OriginatingTo: "channel:C123",
        MessageThreadId: "1712345678.123456",
        ReplyToId: "old-thread",
      }),
      delivery: { deliver: direct },
    });
    expect(direct).not.toHaveBeenCalled();
    expect(latestDurableSendRequest()).toMatchObject({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: null,
      payloads: [{ mediaUrl: mediaPath }],
      replyToId: null,
      session: { key: slackSessionKey, agentId: "main" },
    });
    expect(latestDurableSendRequest().replyToMode).toBe("off");
    expect(latestDurableSendRequest().rootReplyOnly).toBe(true);
    expect(latestDurableSendRequest().payloads?.[0]?.replyToId).toBeUndefined();
    const access = sendDurableMessageBatch.mock.calls[0]?.[0]?.mediaAccess as
      | OutboundMediaAccess
      | undefined;
    expect(access?.localRoots).toContain(path.dirname(mediaPath));
    expect(await access?.readFile?.(mediaPath)).toEqual(Buffer.from("local image bytes"));
  });

  it("passes the chosen root to durable send and relays its queued intent", async () => {
    enableSlackRootDecision();
    sendDurableMessageBatch.mockResolvedValue({
      ...createDurableSendResult(["queued-slack"]),
      deliveryIntent: {
        id: "queued-1",
        channel: "slack",
        to: "channel:C123",
        queuePolicy: "best_effort",
      },
    });
    const direct = vi.fn();
    let observed: unknown;
    await dispatchRoutedChannelTurn({
      cfg,
      channel: "webchat",
      route: { agentId: "main", sessionKey: slackSessionKey },
      ctxPayload: createCtx({ SessionKey: slackSessionKey, Surface: "webchat" }),
      delivery: {
        durable: { to: "wrong-webchat-target", threadId: "inherited-thread" },
        deliver: direct,
        onDelivered: (_payload, _info, result) => {
          observed = result;
        },
      },
    });
    expect(direct).not.toHaveBeenCalled();
    expect(latestDurableSendRequest()).toMatchObject({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: null,
    });
    expect(observed).toMatchObject({
      deliveryIntent: { id: "queued-1", kind: "outbound_queue" },
    });
  });

  it("rejects unsupported redirected delivery rather than falling through to provider direct", async () => {
    enableSlackRootDecision();
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValueOnce({
      ok: false,
      reason: "missing_outbound_handler",
    });
    const direct = vi.fn();
    await expect(
      dispatchRoutedChannelTurn({
        cfg,
        channel: "webchat",
        route: { agentId: "main", sessionKey: slackSessionKey },
        ctxPayload: createCtx({ SessionKey: slackSessionKey, Surface: "webchat" }),
        delivery: { deliver: direct },
      }),
    ).rejects.toThrow(/cannot deliver via Slack: missing_outbound_handler/);
    expect(direct).not.toHaveBeenCalled();
  });

  it("rejects a changed persisted route after async support preflight, before enqueue", async () => {
    enableSlackRootDecision();
    resolveOutboundDurableFinalDeliverySupport.mockImplementationOnce(async () => {
      loadExactSessionEntryReadOnly.mockReturnValue(undefined);
      return { ok: true };
    });
    const direct = vi.fn();
    await expect(
      dispatchRoutedChannelTurn({
        cfg,
        channel: "webchat",
        route: { agentId: "main", sessionKey: slackSessionKey },
        ctxPayload: createCtx({ SessionKey: slackSessionKey, Surface: "webchat" }),
        delivery: { deliver: direct },
      }),
    ).rejects.toThrow(/lacks matching persisted Slack route authority/);
    expect(direct).not.toHaveBeenCalled();
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  });

  it.each(["modifier", "presentation"] as const)(
    "rejects route drift during awaited %s before direct adapter handoff",
    async (stage) => {
      enableSlackRootDecision();
      const stateDir = await tempDirs.make("route-drift");
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const adapterSend = vi.fn(async () => ({ channel: "slack", messageId: "forbidden-send" }));
      const direct = vi.fn(async () => ({ messageIds: ["forbidden-webchat-send"] }));
      const renderPresentation = vi.fn(async () => {
        await Promise.resolve();
        loadExactSessionEntryReadOnly.mockReturnValue(undefined);
        return { text: "rendered final" };
      });
      if (stage === "presentation") {
        dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
          createDispatch([], {
            text: "reply",
            presentation: { blocks: [{ type: "text", text: "card" }] },
          }),
        );
      }
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "slack",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "slack",
              outbound: {
                deliveryMode: "direct",
                sendText: adapterSend,
                sendMedia: adapterSend,
                ...(stage === "presentation"
                  ? { presentationCapabilities: { supported: true }, renderPresentation }
                  : {}),
              },
            }),
          },
        ]),
      );
      const actualSend =
        await vi.importActual<typeof import("../message/send.js")>("../message/send.js");
      sendDurableMessageBatch.mockImplementation(actualSend.sendDurableMessageBatchCore);
      const runMessageSending = vi.fn(async () => {
        await Promise.resolve();
        loadExactSessionEntryReadOnly.mockReturnValue(undefined);
        return { content: "modified final" };
      });
      getGlobalHookRunner.mockReturnValue({
        hasHooks: (name: string) =>
          name === "outbound_route_decision" ||
          (stage === "modifier" && name === "message_sending"),
        runOutboundRouteDecision: async () => slackRoute,
        runMessageSending,
      });
      try {
        await expect(
          dispatchRoutedChannelTurn({
            cfg,
            channel: "webchat",
            route: { agentId: "main", sessionKey: slackSessionKey },
            ctxPayload: createCtx({ SessionKey: slackSessionKey, Surface: "webchat" }),
            delivery: { deliver: direct },
          }),
        ).rejects.toThrow(/lacks matching persisted Slack route authority/);
        if (stage === "modifier") {
          expect(runMessageSending).toHaveBeenCalledOnce();
        } else {
          expect(renderPresentation).toHaveBeenCalledOnce();
        }
        expect(adapterSend).not.toHaveBeenCalled();
        expect(direct).not.toHaveBeenCalled();
        expect(await loadPendingDeliveries(stateDir)).toEqual([]);
      } finally {
        resetPluginRuntimeStateForTest();
        setActivePluginRegistry(createEmptyPluginRegistry());
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
      }
    },
  );

  it("rejects a timed-out route decision before either durable or provider delivery", async () => {
    enableSlackRootDecision();
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "outbound_route_decision",
      runOutboundRouteDecision: async () => {
        throw new Error("outbound_route_decision timed out");
      },
    });
    const direct = vi.fn(async () => ({ messageIds: ["wrong"] }));
    await expect(
      dispatchRoutedChannelTurn({
        cfg,
        channel: "webchat",
        route: { agentId: "main", sessionKey: slackSessionKey },
        ctxPayload: createCtx({ SessionKey: slackSessionKey, Surface: "webchat" }),
        delivery: { deliver: direct },
      }),
    ).rejects.toThrow(/timed out/);
    expect(direct).not.toHaveBeenCalled();
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  });
});
