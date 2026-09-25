// The actual routeReply -> SQLite queue -> recovery path, with a host-only route hook.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSlackSessionRoutePeer } from "../../../extensions/slack/src/outbound-route-peer.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getDeliveryQueueEntryStatus } from "../../infra/delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import { drainPendingDeliveriesCore } from "../../infra/outbound/delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "../../infra/outbound/delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  readQueuedEntry,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "../../infra/outbound/prepared-batch.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverPrivateCommandReply } from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { routeReply } from "./route-reply.js";

const routeHook = vi.hoisted(() => ({
  enabled: false,
  rewriteReplyTo: false,
  decide: vi.fn(),
  rewrite: vi.fn(async (event: { payload: Record<string, unknown> }) => ({
    payload: { ...event.payload, replyToId: "escaped-thread" },
  })),
  observeSent: false,
  sent: vi.fn(),
}));
vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) =>
      (name === "outbound_route_decision" && routeHook.enabled) ||
      (name === "reply_payload_sending" && routeHook.rewriteReplyTo) ||
      (name === "message_sent" && routeHook.observeSent),
    runOutboundRouteDecision: routeHook.decide,
    runReplyPayloadSending: routeHook.rewrite,
    runMessageSent: routeHook.sent,
  }),
}));

const sessionKey = "agent:main:slack:channel:c123:thread:1712345678.123456";
const canonical = {
  channel: "slack",
  to: "channel:C123",
  accountId: "work",
  threadPolicy: "root",
} as const;
const intentId = "block-reply:v1:route-reply-root-fixture";
const createSendText = () =>
  vi.fn(async (_params: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]) => ({
    channel: "slack" as const,
    messageId: "root-recovered",
  }));
const createMatrixSendText = () =>
  vi.fn(async (_params: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]) => ({
    channel: "matrix" as const,
    messageId: "owner-dm",
  }));

describe("routeReply host route decision with durable queue custody", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let storePath: string;
  let cfg: { session: { store: string } };
  let sendText: ReturnType<typeof createSendText>;
  let sendMatrixText: ReturnType<typeof createMatrixSendText>;

  beforeEach(async () => {
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    storePath = path.join(stateDir, "sessions.json");
    cfg = { session: { store: storePath } };
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "route-owner",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: {
            channel: "slack",
            accountId: canonical.accountId,
            target: { to: canonical.to },
            thread: { id: "1712345678.123456" },
          },
          context: {
            channel: "slack",
            to: canonical.to,
            accountId: canonical.accountId,
            threadId: "1712345678.123456",
          },
          origin: { provider: "slack", to: canonical.to, accountId: canonical.accountId },
        },
      },
    );
    routeHook.enabled = true;
    routeHook.rewriteReplyTo = false;
    routeHook.rewrite.mockClear();
    routeHook.observeSent = false;
    routeHook.sent.mockReset();
    routeHook.decide.mockReset().mockResolvedValue(canonical);
    sendText = createSendText();
    sendMatrixText = createMatrixSendText();
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
              sendText: (params) => sendText(params),
              sendMedia: async () => ({ channel: "slack", messageId: "media-root" }),
            },
          }),
        },
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: (params) => sendMatrixText(params),
              sendMedia: async () => ({ channel: "matrix", messageId: "wrong-surface" }),
            },
          }),
        },
      ]),
    );
  });
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    routeHook.enabled = false;
    routeHook.rewriteReplyTo = false;
    routeHook.observeSent = false;
    vi.unstubAllEnvs();
  });

  it("persists the decided Slack root/account, then recovers the same intent without another decision", async () => {
    sendText.mockRejectedValueOnce(
      new PlatformMessageNotDispatchedError("offline before dispatch", {
        cause: new Error("offline"),
      }),
    );
    const result = await routeReply({
      cfg,
      replyKind: "final",
      payload: { text: "queued final", replyToId: "old-thread" },
      channel: "matrix",
      to: "!other:example",
      accountId: "matrix-account",
      threadId: "matrix-thread",
      sessionKey,
      deliveryIntentId: intentId,
      mirror: false,
    });
    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(routeHook.decide).toHaveBeenCalledOnce();
    expect(routeHook.decide).toHaveBeenCalledWith(
      {
        sessionKey,
        original: {
          channel: "matrix",
          to: "!other:example",
          accountId: "matrix-account",
          threadId: "matrix-thread",
        },
      },
      { channelId: "slack" },
      expect.objectContaining({
        sessionKey,
        channel: "slack",
        to: canonical.to,
        accountId: canonical.accountId,
      }),
      validateSlackSessionRoutePeer,
    );
    const [pending] = await loadPendingDeliveries(fixtures.tmpDir());
    expect(pending).toMatchObject({
      id: intentId,
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId: null,
    });
    expect(pending?.reply).toBeUndefined();
    expect(readQueuedEntry(fixtures.tmpDir(), intentId)).toMatchObject({
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId: null,
    });
    expect(
      pending && acceptedPreparedOutboundEntries(pending.preparedBatch)[0]?.payload.replyToId,
    ).toBeUndefined();

    await drainPendingDeliveriesCore({
      drainKey: "slack:route-reply-reconnect-test",
      logLabel: "Slack reconnect drain",
      deliver: deliverOutboundPayloads,
      cfg,
      stateDir: fixtures.tmpDir(),
      log: createRecoveryLog(),
      selectEntry: (entry) => ({ match: entry.channel === "slack", bypassBackoff: true }),
    });
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.lastCall?.[0]).toMatchObject({
      to: canonical.to,
      accountId: canonical.accountId,
    });
    expect(routeHook.decide).toHaveBeenCalledOnce();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, intentId, fixtures.tmpDir()),
    ).toBe("completed");
  });

  it.each([
    { name: "recipient", channel: "slack", to: "channel:C999", accountId: "work", proof: true },
    { name: "account", channel: "slack", to: canonical.to, accountId: "other", proof: true },
    {
      name: "source channel",
      channel: "matrix",
      to: "!old:example",
      accountId: "old",
      proof: true,
    },
    {
      name: "source provenance",
      channel: "slack",
      to: canonical.to,
      accountId: "work",
      proof: true,
      sourceChannel: "telegram",
    },
    {
      name: "old row without proof",
      channel: "slack",
      to: canonical.to,
      accountId: "work",
      proof: false,
    },
  ])("does not reuse a stable intent for a different host $name", async (old) => {
    const id = `block-reply:v1:route-reply-stale-${old.name.replaceAll(" ", "-")}`;
    await enqueueDeliveryOnce(
      {
        channel: old.channel,
        to: old.to,
        accountId: old.accountId,
        ...(old.proof
          ? {
              routeAuthority: {
                agentId: "main",
                storePath,
                sessionKey,
                channel: old.channel,
                to: old.to,
                accountId: old.accountId,
                sourceChannel: old.sourceChannel ?? "matrix",
              },
            }
          : {}),
        payloads: [{ text: "old recipient payload" }],
        queuePolicy: "required",
      },
      id,
      fixtures.tmpDir(),
    );
    const result = await routeReply({
      cfg,
      replyKind: "block",
      payload: { text: "new host decision" },
      channel: "matrix",
      to: "!source:example",
      sessionKey,
      deliveryIntentId: id,
      mirror: false,
    });
    expect(result).toMatchObject({
      ok: false,
      delivered: false,
      routeDecisionControlled: true,
      error: expect.stringContaining("route differs from current host decision"),
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMatrixText).not.toHaveBeenCalled();
    expect(readQueuedEntry(fixtures.tmpDir(), id)).toMatchObject({
      channel: old.channel,
      to: old.to,
    });
  });

  it("reuses matching routed custody without replacing its prepared payload", async () => {
    const id = "block-reply:v1:route-reply-matching";
    await enqueueDeliveryOnce(
      {
        channel: "slack",
        to: canonical.to,
        accountId: canonical.accountId,
        routeAuthority: {
          agentId: "main",
          storePath,
          sessionKey,
          channel: "slack",
          to: canonical.to,
          accountId: canonical.accountId,
          sourceChannel: "matrix",
        },
        payloads: [{ text: "first prepared text" }],
        queuePolicy: "required",
      },
      id,
      fixtures.tmpDir(),
    );
    const result = await routeReply({
      cfg,
      replyKind: "block",
      payload: { text: "new text must not replace custody" },
      channel: "matrix",
      to: "!source:example",
      sessionKey,
      deliveryIntentId: id,
      mirror: false,
    });
    expect(result).toMatchObject({ ok: true, delivered: true });
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.lastCall?.[0]).toMatchObject({
      to: canonical.to,
      accountId: canonical.accountId,
      text: "first prepared text",
    });
    expect(sendMatrixText).not.toHaveBeenCalled();
  });

  it("preserves ordinary native stable retries without routed proof", async () => {
    const id = "block-reply:v1:native-matrix-retry";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!native:example",
        payloads: [{ text: "native queued text" }],
        queuePolicy: "required",
      },
      id,
      fixtures.tmpDir(),
    );
    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "matrix",
        to: "!native:example",
        payloads: [{ text: "new text" }],
        deliveryIntentId: id,
        reusePendingDeliveryIntent: true,
        queuePolicy: "required",
      }),
    ).resolves.toEqual([expect.objectContaining({ messageId: "owner-dm" })]);
    expect(sendMatrixText).toHaveBeenCalledOnce();
    expect(sendMatrixText.mock.lastCall?.[0]).toMatchObject({
      to: "!native:example",
      text: "native queued text",
    });
  });

  it("carries the decided channel peer into queued mirror and message_sent recipient facts, not the webchat DM source", async () => {
    routeHook.observeSent = true;
    sendText.mockRejectedValueOnce(
      new PlatformMessageNotDispatchedError("offline before dispatch", {
        cause: new Error("offline"),
      }),
    );
    await routeReply({
      cfg,
      replyKind: "final",
      payload: { text: "queued final" },
      channel: "webchat",
      to: "web-user",
      sessionKey,
      isGroup: false,
      groupId: "web-user",
      deliveryIntentId: "block-reply:v1:group-facts",
    });
    expect(readQueuedEntry(fixtures.tmpDir(), "block-reply:v1:group-facts")).toMatchObject({
      channel: "slack",
      to: canonical.to,
      mirror: { sessionKey, isGroup: true, groupId: canonical.to },
    });
    await drainPendingDeliveriesCore({
      drainKey: "slack:route-reply-group-facts",
      logLabel: "Slack reconnect drain",
      deliver: deliverOutboundPayloads,
      cfg,
      stateDir: fixtures.tmpDir(),
      log: createRecoveryLog(),
      selectEntry: (entry) => ({ match: entry.channel === "slack", bypassBackoff: true }),
    });
    expect(routeHook.sent).toHaveBeenCalledWith(
      expect.objectContaining({ to: canonical.to, success: true, sessionKey }),
      expect.objectContaining({ channelId: "slack", conversationId: canonical.to }),
    );
  });

  it("keeps an owner-private command response off the originating Slack channel", async () => {
    const outcome = await deliverPrivateCommandReply({
      commandParams: { cfg, sessionKey, agentId: "main" } as HandleCommandsParams,
      targets: [{ channel: "matrix", to: "@owner:example.org" }],
      reply: { text: "private diagnostics" },
    });
    expect(outcome).toBe("delivered");
    expect(sendMatrixText).toHaveBeenCalledOnce();
    expect(sendMatrixText.mock.lastCall?.[0]).toMatchObject({ to: "@owner:example.org" });
    expect(sendText).not.toHaveBeenCalled();
    expect(routeHook.decide).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([]);
  });

  it("sends a same-surface owner-private command to its DM, not the Slack group session", async () => {
    const outcome = await deliverPrivateCommandReply({
      commandParams: { cfg, sessionKey, agentId: "main" } as HandleCommandsParams,
      targets: [{ channel: "slack", to: "user:U987", accountId: "work" }],
      reply: { text: "private approval" },
    });
    expect(outcome).toBe("delivered");
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.lastCall?.[0]).toMatchObject({ to: "user:U987", accountId: "work" });
    expect(routeHook.decide).not.toHaveBeenCalled();
  });

  it("keeps a modifying hook from reintroducing an inherited reply target after root decision", async () => {
    routeHook.rewriteReplyTo = true;
    sendText.mockRejectedValueOnce(
      new PlatformMessageNotDispatchedError("offline before dispatch", {
        cause: new Error("offline"),
      }),
    );
    const hookIntentId = "block-reply:v1:root-after-hook";
    await routeReply({
      cfg,
      replyKind: "final",
      payload: { text: "canonical root" },
      channel: "matrix",
      to: "!other:example",
      sessionKey,
      deliveryIntentId: hookIntentId,
      mirror: false,
    });
    expect(routeHook.rewrite).toHaveBeenCalledOnce();
    const [entry] = acceptedPreparedOutboundEntries(
      readQueuedEntry(fixtures.tmpDir(), hookIntentId).preparedBatch as Parameters<
        typeof acceptedPreparedOutboundEntries
      >[0],
    );
    expect(entry?.payload.replyToId).toBeUndefined();
    expect(sendText.mock.lastCall?.[0]).not.toMatchObject({ replyToId: "escaped-thread" });
  });

  it("preserves direct-message policy for an authenticated Slack user route", async () => {
    const directSessionKey = "agent:main:slack:direct:u123";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: directSessionKey, storePath },
      {
        sessionId: "direct-owner",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: {
            channel: "slack",
            accountId: "work",
            target: { to: "user:U123" },
          },
          context: { channel: "slack", to: "user:U123", accountId: "work" },
          origin: { provider: "slack", to: "user:U123", accountId: "work" },
        },
      },
    );
    routeHook.decide.mockResolvedValueOnce({
      channel: "slack",
      to: "user:U123",
      accountId: "work",
      threadPolicy: "root",
    });
    sendText.mockRejectedValueOnce(
      new PlatformMessageNotDispatchedError("offline before dispatch", {
        cause: new Error("offline"),
      }),
    );
    const directIntentId = "block-reply:v1:direct-root-fixture";
    const result = await routeReply({
      cfg,
      replyKind: "final",
      payload: { text: "direct response" },
      channel: "matrix",
      to: "!other:example",
      sessionKey: directSessionKey,
      isGroup: true,
      groupId: "!other:example",
      deliveryIntentId: directIntentId,
    });
    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.lastCall?.[0]).toMatchObject({ to: "user:U123", accountId: "work" });
    expect(readQueuedEntry(fixtures.tmpDir(), directIntentId)).toMatchObject({
      channel: "slack",
      to: "user:U123",
      session: { key: directSessionKey, conversationType: "direct" },
      mirror: { sessionKey: directSessionKey, isGroup: false },
    });
    expect(readQueuedEntry(fixtures.tmpDir(), directIntentId).mirror).not.toHaveProperty("groupId");
  });

  it("fails closed on hook timeout, without queuing or falling through to the original surface", async () => {
    routeHook.decide.mockRejectedValueOnce(new Error("outbound_route_decision timed out"));
    const result = await routeReply({
      cfg,
      replyKind: "block",
      payload: { text: "not sent" },
      channel: "matrix",
      to: "!other:example",
      sessionKey,
      deliveryIntentId: intentId,
    });
    expect(result).toMatchObject({
      ok: false,
      delivered: false,
      routeDecisionControlled: true,
      error: expect.stringContaining("timed out"),
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([]);
  });

  it("rejects a plugin route when the exact persisted account no longer proves it", async () => {
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "route-owner",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: {
            channel: "slack",
            accountId: "other-account",
            target: { to: canonical.to },
          },
          context: { channel: "slack", to: canonical.to, accountId: "other-account" },
          origin: { provider: "slack", to: canonical.to, accountId: "other-account" },
        },
      },
    );
    const result = await routeReply({
      cfg,
      replyKind: "block",
      payload: { text: "not admitted" },
      channel: "matrix",
      to: "!other:example",
      sessionKey,
    });
    expect(result).toMatchObject({
      ok: false,
      delivered: false,
      routeDecisionControlled: true,
      error: expect.stringContaining("persisted route authority"),
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([]);
  });
});
