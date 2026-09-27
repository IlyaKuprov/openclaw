import { afterEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";
import { loadRegistryFromSinglePlugin } from "./loader.test-harness.js";

// A plugin can refuse to register unless the host owns the outbound route contract,
// then request a channel-root route that the host validates and dispatches.
describe("outbound_route_decision plugin registration", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  });

  it("exposes the contract version to a plugin that gates its registration on it", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "route-guard",
      registration: `if (api.outboundRouteDecisionContract !== 1) {
        throw new Error("requires the host-owned outbound route decision contract");
      }
      api.on("outbound_route_decision", (event, ctx) => {
        globalThis.routeGuardSeen = { event, ctx };
        if (!event.sessionKey.toLowerCase().includes("slack")) {
          return;
        }
        return { channel: "slack", to: event.original.to, accountId: "work", threadPolicy: "root" };
      });`,
    });
    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: { allow: ["route-guard"], entries: { "route-guard": { enabled: true } } },
    });

    expect(registry.plugins.find((entry) => entry.id === "route-guard")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["outbound_route_decision"]);

    const runner = createHookRunner(registry);
    const event = {
      sessionKey: "agent:main:slack:channel:c123",
      original: { channel: "slack", to: "channel:C123", accountId: "work", threadId: "1712.1" },
    };
    const persisted = { ...event.original, sessionKey: event.sessionKey };
    const decision = await runner.runOutboundRouteDecision(
      event,
      { channelId: "slack" },
      persisted,
      ({ peerKind, peerId, to }) =>
        peerKind === "channel" && to === `channel:${peerId.toUpperCase()}`,
    );

    expect(decision).toEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadPolicy: "root",
    });
    const seen = (globalThis as { routeGuardSeen?: { event: unknown; ctx: unknown } })
      .routeGuardSeen;
    expect(seen?.event).toEqual(event);
    expect(seen?.ctx).toEqual({ channelId: "slack" });
    expect(Object.isFrozen(seen?.event)).toBe(true);

    const untouched = await runner.runOutboundRouteDecision(
      { sessionKey: "agent:main:telegram:direct:42", original: { channel: "telegram", to: "42" } },
      { channelId: "telegram" },
      undefined,
      undefined,
    );
    expect(untouched).toBeUndefined();
    delete (globalThis as { routeGuardSeen?: unknown }).routeGuardSeen;
  });
});
