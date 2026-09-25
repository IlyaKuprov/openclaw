import { describe, expect, it, vi } from "vitest";
import { validateSlackSessionRoutePeer } from "../../extensions/slack/src/outbound-route-peer.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

const event = {
  sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
  original: {
    channel: "slack",
    to: "channel:C123",
    accountId: "work",
    threadId: "1712345678.123456",
  },
};
const persisted = {
  sessionKey: event.sessionKey,
  channel: "slack",
  to: "channel:C123",
  accountId: "work",
  threadId: "1712345678.123456",
};
const root = { channel: "slack", to: "channel:C123", accountId: "work", threadPolicy: "root" };
const context = { channelId: "slack" } as const;

function routeRunner(handler: (...args: unknown[]) => unknown) {
  return createHookRunnerWithRegistry([{ hookName: "outbound_route_decision", handler }]).runner;
}

describe("outbound_route_decision pure route contract", () => {
  it("accepts an exact non-Slack route with channel-owned peer validation", async () => {
    const matrixEvent = {
      sessionKey: "agent:main:matrix:channel:!Room:example.org",
      original: { channel: "matrix", to: "!Room:example.org", accountId: "work" },
    };
    const matrixProof = { ...matrixEvent.original, sessionKey: matrixEvent.sessionKey };
    const matrixRoot = {
      channel: "matrix",
      to: "!Room:example.org",
      accountId: "work",
      threadPolicy: "root",
    };
    await expect(
      routeRunner(() => matrixRoot).runOutboundRouteDecision(
        matrixEvent,
        { channelId: "matrix" },
        matrixProof,
        ({ peerId, to }) => peerId === to,
      ),
    ).resolves.toEqual(matrixRoot);
  });

  it("accepts a channel with no account when the original and persisted routes agree", async () => {
    const input = {
      sessionKey: "agent:main:matrix:channel:!Room:example.org",
      original: { channel: "matrix", to: "!Room:example.org" },
    };
    const stored = { ...input.original, sessionKey: input.sessionKey };
    const requested = { channel: "matrix", to: stored.to, threadPolicy: "root" };
    await expect(
      routeRunner(() => requested).runOutboundRouteDecision(
        input,
        { channelId: "matrix" },
        stored,
        ({ peerId, to }) => peerId === to,
      ),
    ).resolves.toEqual(requested);

    await expect(
      routeRunner(() => requested).runOutboundRouteDecision(
        { ...input, original: { ...input.original, to: "!Wrong:example.org" } },
        { channelId: "matrix" },
        stored,
        ({ peerId, to }) => peerId === to,
      ),
    ).rejects.toThrow(/route authority/);
  });

  it("fails closed when a channel provides no peer proof", async () => {
    await expect(
      routeRunner(() => root).runOutboundRouteDecision(event, context, persisted, undefined),
    ).rejects.toThrow(/route authority/);
  });
  it("permits a non-Slack originating surface for a persisted Slack session without trusting its target", async () => {
    const webchatEvent = {
      ...event,
      original: { channel: "webchat", to: "unrelated-webchat-target", accountId: "web" },
    };
    await expect(
      routeRunner(() => root).runOutboundRouteDecision(
        webchatEvent,
        context,
        persisted,
        validateSlackSessionRoutePeer,
      ),
    ).resolves.toEqual(root);
  });

  it("accepts an authoritative Slack root decision without sharing the persisted proof or media", async () => {
    const handler = vi.fn().mockReturnValue(root);
    const runner = routeRunner(handler);
    await expect(
      runner.runOutboundRouteDecision(event, context, persisted, validateSlackSessionRoutePeer),
    ).resolves.toEqual(root);
    expect(handler).toHaveBeenCalledWith(event, context);
    expect(handler.mock.calls[0]).toHaveLength(2);
  });

  it.each([
    ["missing canonical session", { ...event, sessionKey: "" }, persisted, root],
    [
      "session mismatch",
      event,
      { ...persisted, sessionKey: "agent:main:slack:channel:c999" },
      root,
    ],
    ["missing persisted account", event, { ...persisted, accountId: undefined }, root],
    [
      "missing original account",
      { ...event, original: { ...event.original, accountId: undefined } },
      persisted,
      root,
    ],
    ["changed persisted destination", event, { ...persisted, to: "channel:C999" }, root],
    [
      "changed original destination",
      { ...event, original: { ...event.original, to: "channel:C999" } },
      persisted,
      root,
    ],
    ["changed account", event, persisted, { ...root, accountId: "other" }],
    ["wrong destination", event, persisted, { ...root, to: "channel:C999" }],
    ["non-canonical destination", event, persisted, { ...root, to: "C123" }],
    ["non-Slack channel", event, persisted, { ...root, channel: "discord" }],
    ["thread escape", event, persisted, { ...root, threadId: "1712345678.123456" }],
    ["invalid root policy", event, persisted, { ...root, threadPolicy: "inherit" }],
    ["null result", event, persisted, null],
    ["missing route field", event, persisted, { channel: "slack", to: "channel:C123" }],
    [
      "unrelated peer kind",
      { ...event, sessionKey: "agent:main:slack:direct:u123" },
      persisted,
      root,
    ],
    ["unexpected persisted thread", event, { ...persisted, threadId: "other-thread" }, root],
    [
      "missing persisted thread encoded as undefined",
      {
        ...event,
        sessionKey: "agent:main:slack:channel:c123:thread:undefined",
        original: { ...event.original, threadId: undefined },
      },
      {
        ...persisted,
        sessionKey: "agent:main:slack:channel:c123:thread:undefined",
        threadId: undefined,
      },
      root,
    ],
  ])("fails closed on %s", async (_label, input, stored, decision) => {
    const runner = routeRunner(() => decision);
    await expect(
      runner.runOutboundRouteDecision(input, context, stored, validateSlackSessionRoutePeer),
    ).rejects.toThrow();
  });

  it("fails closed on conflicting registered route decisions, but accepts identical ones", async () => {
    const registry = [
      { hookName: "outbound_route_decision", handler: () => root },
      { hookName: "outbound_route_decision", handler: () => ({ ...root, to: "channel:C999" }) },
    ];
    const { runner } = createHookRunnerWithRegistry(registry);
    await expect(
      runner.runOutboundRouteDecision(event, context, persisted, validateSlackSessionRoutePeer),
    ).rejects.toThrow();
    registry[1]!.handler = () => ({ ...root });
    const { runner: compatible } = createHookRunnerWithRegistry(registry);
    await expect(
      compatible.runOutboundRouteDecision(event, context, persisted, validateSlackSessionRoutePeer),
    ).resolves.toEqual(root);
  });

  it("does not apply a late decision after timeout; no later hook or delivery is authorized", async () => {
    vi.useFakeTimers();
    try {
      const started = createDeferred();
      const release = createDeferred<typeof root>();
      const late = vi.fn(() => {
        started.resolve();
        return release.promise;
      });
      const next = vi.fn(() => root);
      const { runner } = createHookRunnerWithRegistry([
        { hookName: "outbound_route_decision", handler: late, timeoutMs: 10 },
        { hookName: "outbound_route_decision", handler: next },
      ]);
      const pending = runner.runOutboundRouteDecision(
        event,
        context,
        persisted,
        validateSlackSessionRoutePeer,
      );
      const rejection = expect(pending).rejects.toThrow(/timed out/);
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      release.resolve(root);
      await Promise.resolve();
      expect(next).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an earlier valid decision if a later handler times out", async () => {
    vi.useFakeTimers();
    try {
      const runner = createHookRunnerWithRegistry([
        { hookName: "outbound_route_decision", handler: () => root },
        {
          hookName: "outbound_route_decision",
          handler: () => new Promise(() => {}),
          timeoutMs: 10,
        },
      ]).runner;
      const pending = runner.runOutboundRouteDecision(
        event,
        context,
        persisted,
        validateSlackSessionRoutePeer,
      );
      const rejected = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects handler errors even if the runner requests fail-open for this hook", async () => {
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "outbound_route_decision",
          handler: () => {
            throw new Error("no route");
          },
        },
      ],
      { catchErrors: true, failurePolicyByHook: { outbound_route_decision: "fail-open" } },
    );
    await expect(
      runner.runOutboundRouteDecision(event, context, persisted, validateSlackSessionRoutePeer),
    ).rejects.toThrow("no route");
  });

  it("does not require route proof when no plugin requests a change", async () => {
    const runner = routeRunner(() => undefined);
    await expect(
      runner.runOutboundRouteDecision(event, context, undefined, validateSlackSessionRoutePeer),
    ).resolves.toBeUndefined();
  });

  it("isolates and freezes the plugin-visible route without changing host inputs", async () => {
    const runner = routeRunner((visible: unknown) => {
      const seen = visible as typeof event;
      expect(seen).not.toBe(event);
      expect(Object.isFrozen(seen.original)).toBe(true);
      expect(() => {
        seen.original.to = "channel:C999";
      }).toThrow();
      return root;
    });
    await expect(
      runner.runOutboundRouteDecision(event, context, persisted, validateSlackSessionRoutePeer),
    ).resolves.toEqual(root);
    expect(event.original.to).toBe("channel:C123");
  });

  it("accepts a workspace-qualified canonical channel target when all authorities agree", async () => {
    const qualified = "team:T456:channel:C123";
    const qualifiedEvent = {
      sessionKey: "agent:main:slack:channel:team:t456:channel:c123",
      original: { channel: "slack", to: qualified, accountId: "work" },
    };
    const qualifiedPersisted = {
      sessionKey: qualifiedEvent.sessionKey,
      channel: "slack",
      to: qualified,
      accountId: "work",
    };
    await expect(
      routeRunner(() => ({ ...root, to: qualified })).runOutboundRouteDecision(
        qualifiedEvent,
        context,
        qualifiedPersisted,
        validateSlackSessionRoutePeer,
      ),
    ).resolves.toEqual({ ...root, to: qualified });
  });

  it("accepts the Slack parser's lowercase normalized channel target", async () => {
    const lower = "channel:c123";
    const lowerEvent = { ...event, original: { ...event.original, to: lower } };
    const lowerPersisted = { ...persisted, to: lower };
    await expect(
      routeRunner(() => ({ ...root, to: lower })).runOutboundRouteDecision(
        lowerEvent,
        context,
        lowerPersisted,
        validateSlackSessionRoutePeer,
      ),
    ).resolves.toEqual({ ...root, to: lower });
  });

  it.each([
    ["group", "agent:main:slack:group:c123", "channel:C123"],
    ["direct user", "agent:main:slack:direct:u123", "user:U123"],
    ["direct bot", "agent:main:slack:direct:b123", "user:B123"],
    ["qualified direct user", "agent:main:slack:direct:team:t123:user:u123", "team:T123:user:U123"],
    ["direct DM channel", "agent:main:slack:dm:d123", "channel:D123"],
  ])("accepts the persisted %s Slack peer only when the key agrees", async (_kind, key, to) => {
    const input = { sessionKey: key, original: { channel: "webchat", to: "web-user" } };
    const stored = { sessionKey: key, channel: "slack", to, accountId: "work" };
    const decision = { ...root, to };
    await expect(
      routeRunner(() => decision).runOutboundRouteDecision(
        input,
        context,
        stored,
        validateSlackSessionRoutePeer,
      ),
    ).resolves.toEqual(decision);
    await expect(
      routeRunner(() => decision).runOutboundRouteDecision(
        input,
        context,
        {
          ...stored,
          to: "channel:C999",
        },
        validateSlackSessionRoutePeer,
      ),
    ).rejects.toThrow();
  });

  it("rejects the account encoded in a direct key when the stored account differs", async () => {
    const key = "agent:main:slack:work:direct:u123";
    const input = { sessionKey: key, original: { channel: "webchat", to: "web-user" } };
    const stored = { sessionKey: key, channel: "slack", to: "user:U123", accountId: "other" };
    await expect(
      routeRunner(() => ({
        ...root,
        to: stored.to,
        accountId: stored.accountId,
      })).runOutboundRouteDecision(input, context, stored, validateSlackSessionRoutePeer),
    ).rejects.toThrow();
  });

  it("rejects a direct user's id when the stored route changes its target kind", async () => {
    const key = "agent:main:slack:direct:u123";
    const input = { sessionKey: key, original: { channel: "webchat", to: "web-user" } };
    const stored = { sessionKey: key, channel: "slack", to: "channel:U123", accountId: "work" };
    await expect(
      routeRunner(() => ({ ...root, to: stored.to })).runOutboundRouteDecision(
        input,
        context,
        stored,
        validateSlackSessionRoutePeer,
      ),
    ).rejects.toThrow();
  });

  it("fails closed for an opaque ACP Slack binding without host-verified conversation authority", async () => {
    const key = "agent:codex:acp:binding:slack:default:c123";
    const input = { sessionKey: key, original: { channel: "webchat", to: "web-user" } };
    const stored = { sessionKey: key, channel: "slack", to: "channel:C123", accountId: "default" };
    await expect(
      routeRunner(() => ({ ...root, accountId: "default" })).runOutboundRouteDecision(
        input,
        context,
        stored,
        validateSlackSessionRoutePeer,
      ),
    ).rejects.toThrow();
  });
});
