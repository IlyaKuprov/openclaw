import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSlackSessionRoutePeer } from "../../../extensions/slack/src/outbound-route-peer.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import {
  createCtx,
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

const cfg = { session: { store: "/tmp/unused-sessions.json" } } as OpenClawConfig;
const slackSessionKey = "agent:main:slack:channel:c123";
const slackRoute = { channel: "slack", to: "channel:C123", accountId: "work" } as const;

function latestDurableSendRequest(): DurableSendRequest {
  const request = sendDurableMessageBatch.mock.lastCall?.[0] as DurableSendRequest | undefined;
  if (!request) {
    throw new Error("expected durable send request");
  }
  return request;
}

/** Drive block, tool, and final deliveries the way the routed dispatcher does. */
function createMultiStageDispatch(kinds: Array<"block" | "tool" | "final">) {
  return vi.fn(async (params) => {
    const deliveries: unknown[] = [];
    for (const kind of kinds) {
      deliveries.push(await params.dispatcherOptions.deliver({ text: `${kind} text` }, { kind }));
    }
    return {
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      settledReceipt: { final: { delivered: 1 } },
      deliveries,
    };
  });
}

describe("channel lifecycle outbound route decision", () => {
  let decide: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              validateSessionRoutePeer: validateSlackSessionRoutePeer,
            },
          }),
        },
      ]),
    );
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
    sendDurableMessageBatch.mockResolvedValue(createDurableSendResult(["slack-root"]));
    loadExactSessionEntryReadOnly.mockReturnValue({
      sessionKey: slackSessionKey,
      entry: {
        delivery: {
          kind: "external",
          route: { channel: "slack", accountId: "work", target: { to: "channel:C123" } },
          context: { ...slackRoute, threadId: "1712345678.123456" },
        },
      },
    });
    decide = vi.fn(() => ({ ...slackRoute, threadPolicy: "root" as const }));
    getGlobalHookRunner.mockReturnValue(
      createHookRunnerWithRegistry([
        { hookName: "outbound_route_decision", handler: decide, pluginId: "slack-thread-guard" },
      ]).runner,
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("routes a webchat-origin final into its persisted Slack channel root, never the source adapter", async () => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
      createMultiStageDispatch(["final"]),
    );
    const direct = vi.fn(async () => ({ messageIds: ["wrong-surface"] }));
    const preparePayload = vi.fn(async (payload: unknown) => payload);
    const onError = vi.fn();

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
      delivery: { deliver: direct, preparePayload, onError },
    });

    expectDispatched(result);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toEqual({
      sessionKey: slackSessionKey,
      original: {
        channel: "webchat",
        to: "webchat-client",
        accountId: "web",
        threadId: "1712345678.123456",
      },
    });
    expect(direct).not.toHaveBeenCalled();
    expect(preparePayload).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(latestDurableSendRequest()).toMatchObject({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: null,
      replyToMode: "off",
    });
    expect(latestDurableSendRequest().payloads?.[0]?.replyToId).toBeUndefined();
  });

  it("forces a same-surface Slack thread final to the channel root", async () => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
      createMultiStageDispatch(["final"]),
    );
    const direct = vi.fn(async () => ({ messageIds: ["threaded"] }));

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "slack",
      accountId: "work",
      route: { agentId: "main", sessionKey: slackSessionKey },
      ctxPayload: createCtx({
        SessionKey: slackSessionKey,
        Surface: "slack",
        OriginatingTo: "channel:C123",
        MessageThreadId: "1712345678.123456",
      }),
      delivery: { deliver: direct },
    });

    expectDispatched(result);
    expect(direct).not.toHaveBeenCalled();
    expect(latestDurableSendRequest()).toMatchObject({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: null,
    });
  });

  it("decides once per turn and suppresses non-final output on a decided route", async () => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
      createMultiStageDispatch(["block", "tool", "final"]),
    );
    const direct = vi.fn(async () => ({ messageIds: ["source"] }));
    const onDelivered = vi.fn();

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "slack",
      accountId: "work",
      route: { agentId: "main", sessionKey: slackSessionKey },
      ctxPayload: createCtx({
        SessionKey: slackSessionKey,
        Surface: "slack",
        OriginatingTo: "channel:C123",
        MessageThreadId: "1712345678.123456",
      }),
      delivery: { deliver: direct, onDelivered },
    });

    expectDispatched(result);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(latestDurableSendRequest().payloads?.[0]?.text).toBe("final text");
    const suppressed = onDelivered.mock.calls.map((call) => call[1]?.kind);
    expect(suppressed).toEqual(["block", "tool"]);
  });

  it("keeps native delivery with source observers when no plugin requests a route", async () => {
    decide.mockReturnValue(undefined);
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
      createMultiStageDispatch(["final"]),
    );
    const direct = vi.fn(async () => ({ messageIds: ["native"] }));

    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:direct:42" },
      ctxPayload: createCtx({
        SessionKey: "agent:main:telegram:direct:42",
        Surface: "telegram",
        OriginatingTo: "42",
      }),
      delivery: { deliver: direct },
    });

    expectDispatched(result);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  });

  it("rejects a failed decision before any delivery and keeps the source error observer out of it", async () => {
    decide.mockImplementation(() => {
      throw new Error("Slack outbound route lacks matching persisted peer and account");
    });
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
      createMultiStageDispatch(["final"]),
    );
    const direct = vi.fn(async () => ({ messageIds: ["wrong-surface"] }));
    const onError = vi.fn();

    await expect(
      dispatchRoutedChannelTurn({
        cfg,
        channel: "webchat",
        accountId: "web",
        route: { agentId: "main", sessionKey: slackSessionKey },
        ctxPayload: createCtx({
          SessionKey: slackSessionKey,
          Surface: "webchat",
          OriginatingTo: "webchat-client",
        }),
        delivery: { deliver: direct, onError },
      }),
    ).rejects.toThrow("lacks matching persisted peer");

    expect(direct).not.toHaveBeenCalled();
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
