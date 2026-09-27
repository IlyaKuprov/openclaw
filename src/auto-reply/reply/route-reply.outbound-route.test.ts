import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { routeReply } from "./route-reply.js";

// Stand-in for a channel's outbound.validateSessionRoutePeer (Slack shape: channel:<ID>).
const validateChannelRoutePeer = ({
  peerKind,
  peerId,
  to,
}: {
  peerKind: string;
  peerId: string;
  to: string;
}) => peerKind === "channel" && to === `channel:${peerId.toUpperCase()}`;

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  hookRunner: undefined as unknown,
}));
vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));
vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => mocks.hookRunner,
}));

const sessionKey = "agent:main:slack:channel:c123:thread:1712345678.123456";
const canonical = { channel: "slack", to: "channel:C123", accountId: "work" } as const;
const rootDecision = { ...canonical, threadPolicy: "root" as const };
const threadId = "1712345678.123456";

function lastDelivery(): Record<string, unknown> {
  const call = mocks.deliverOutboundPayloads.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected an outbound delivery call");
  }
  return call[0] as Record<string, unknown>;
}

describe("routeReply host outbound route decision", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let cfg: { session: { store: string } };
  let decide: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
  let extraHooks: Array<{ hookName: string; handler: (...args: unknown[]) => unknown }>;
  const installRunner = () => {
    mocks.hookRunner = createHookRunnerWithRegistry([
      { hookName: "outbound_route_decision", handler: decide, pluginId: "slack-thread-guard" },
      ...extraHooks.map((hook) => ({ ...hook, pluginId: "other-plugin" })),
    ]).runner;
  };

  beforeEach(async () => {
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
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
            thread: { id: threadId },
          },
          context: { ...canonical, threadId },
          origin: { provider: "slack", surface: "slack", chatType: "channel", to: canonical.to },
        },
      },
    );
    decide = vi.fn(() => rootDecision);
    // A real hook runner: the plugin's request passes through host validation.
    extraHooks = [];
    mocks.hookRunner = createHookRunnerWithRegistry([
      { hookName: "outbound_route_decision", handler: decide, pluginId: "slack-thread-guard" },
    ]).runner;
    mocks.deliverOutboundPayloads.mockReset().mockResolvedValue([{ messageId: "sent-1" }]);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              validateSessionRoutePeer: validateChannelRoutePeer,
              sendText: async () => ({ channel: "slack", messageId: "unused" }),
            },
          }),
        },
        {
          pluginId: "webchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "webchat",
            outbound: {
              deliveryMode: "direct",
              sendText: async () => ({ channel: "webchat", messageId: "unused" }),
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
    mocks.hookRunner = undefined;
    vi.unstubAllEnvs();
  });

  it("delivers a same-surface thread reply at the persisted Slack channel root", async () => {
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId,
      replyKind: "final",
      payload: { text: "final answer", replyToId: "1712345678.999999" },
    });

    expect(result).toMatchObject({ ok: true, delivered: true });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toEqual({
      sessionKey,
      original: { channel: "slack", to: canonical.to, accountId: canonical.accountId, threadId },
    });
    expect(decide.mock.calls[0]?.[1]).toEqual({ channelId: "slack" });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(lastDelivery()).toMatchObject({
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId: null,
      replyToId: null,
      replyToMode: "off",
    });
    expect(
      (lastDelivery().payloads as Array<{ replyToId?: string }>)[0]?.replyToId,
    ).toBeUndefined();
  });

  it("reroutes a webchat-origin reply into the persisted Slack channel, never the webchat surface", async () => {
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      channel: "webchat",
      to: "webchat-client",
      replyKind: "final",
      payload: { text: "hello from the gateway" },
    });

    expect(result).toMatchObject({ ok: true, delivered: true });
    expect(decide.mock.calls[0]?.[0]).toEqual({
      sessionKey,
      original: {
        channel: "webchat",
        to: "webchat-client",
        accountId: undefined,
        threadId: undefined,
      },
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(lastDelivery()).toMatchObject({
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId: null,
    });
  });

  it("leaves an undecided route untouched", async () => {
    decide.mockReturnValue(undefined);
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      channel: "telegram",
      to: "client-1",
      replyKind: "final",
      payload: { text: "stays put" },
    });

    expect(result).toMatchObject({ ok: true, delivered: true });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(lastDelivery()).toMatchObject({ channel: "telegram", to: "client-1" });
  });

  it("fails closed when the plugin throws, without falling through to the original surface", async () => {
    decide.mockImplementation(() => {
      throw new Error("Slack outbound route lacks matching persisted peer and account");
    });
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      channel: "webchat",
      to: "webchat-client",
      replyKind: "final",
      payload: { text: "must not leak" },
    });

    expect(result).toMatchObject({ ok: false, delivered: false, routeDecisionControlled: true });
    expect(result.error).toContain("Failed to decide reply route");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("rejects a decision that the persisted session row does not prove", async () => {
    decide.mockReturnValue({ ...rootDecision, to: "channel:C999" });
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId,
      replyKind: "final",
      payload: { text: "wrong target" },
    });

    expect(result).toMatchObject({ ok: false, delivered: false, routeDecisionControlled: true });
    expect(result.error).toContain("conflicts with persisted route");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("keeps an owner-private command response off the session's Slack channel", async () => {
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      ownerPrivateCommandRoute: true,
      channel: "telegram",
      to: "owner-dm",
      replyKind: "final",
      payload: { text: "private status" },
    });

    expect(decide).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, delivered: true });
    expect(lastDelivery()).toMatchObject({ channel: "telegram", to: "owner-dm" });
  });
  it("keeps the root even when a later payload hook reintroduces a reply target", async () => {
    extraHooks.push({
      hookName: "reply_payload_sending",
      handler: (event) => ({
        payload: { ...(event as { payload: object }).payload, replyToId: "1712345678.424242" },
      }),
    });
    installRunner();
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId,
      replyKind: "final",
      payload: { text: "hook tries to thread" },
    });

    expect(result).toMatchObject({ ok: true, delivered: true });
    const payloads = lastDelivery().payloads as Array<{ replyToId?: string }>;
    expect(payloads[0]?.replyToId).toBeUndefined();
    expect(lastDelivery()).toMatchObject({ threadId: null, replyToId: null });
  });

  it("rejects a decision whose persisted row changed while the plugin was deciding", async () => {
    decide.mockImplementation(async () => {
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: cfg.session.store },
        {
          sessionId: "route-owner",
          updatedAt: Date.now(),
          delivery: {
            kind: "external",
            route: { channel: "slack", accountId: "other", target: { to: "channel:C999" } },
            context: { channel: "slack", to: "channel:C999", accountId: "other" },
            origin: {
              provider: "slack",
              surface: "slack",
              chatType: "channel",
              to: "channel:C999",
            },
          },
        },
      );
      return rootDecision;
    });
    const result = await routeReply({
      cfg: cfg as never,
      sessionKey,
      channel: "slack",
      to: canonical.to,
      accountId: canonical.accountId,
      threadId,
      replyKind: "final",
      payload: { text: "row moved underneath" },
    });

    expect(result).toMatchObject({ ok: false, delivered: false, routeDecisionControlled: true });
    expect(result.error).toContain("stale");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
