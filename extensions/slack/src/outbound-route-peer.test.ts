import { describe, expect, it } from "vitest";
import { validateSlackSessionRoutePeer } from "./outbound-route-peer.js";

const base = { accountId: "work" };

describe("validateSlackSessionRoutePeer", () => {
  it("accepts channel and direct peers whose persisted target names the same id", () => {
    expect(
      validateSlackSessionRoutePeer({
        ...base,
        peerKind: "channel",
        peerId: "c123",
        to: "channel:C123",
      }),
    ).toBe(true);
    expect(
      validateSlackSessionRoutePeer({
        ...base,
        peerKind: "group",
        peerId: "G123",
        to: "channel:g123",
      }),
    ).toBe(true);
    expect(
      validateSlackSessionRoutePeer({ ...base, peerKind: "direct", peerId: "u42", to: "user:U42" }),
    ).toBe(true);
    expect(
      validateSlackSessionRoutePeer({
        ...base,
        peerKind: "channel",
        peerId: "team:t1:channel:c123",
        to: "team:T1:channel:C123",
      }),
    ).toBe(true);
  });

  it("rejects a different peer, a different peer kind, a bare target, or a missing account", () => {
    expect(
      validateSlackSessionRoutePeer({
        ...base,
        peerKind: "channel",
        peerId: "C123",
        to: "channel:C999",
      }),
    ).toBe(false);
    expect(
      validateSlackSessionRoutePeer({
        ...base,
        peerKind: "channel",
        peerId: "C123",
        to: "user:C123",
      }),
    ).toBe(false);
    expect(
      validateSlackSessionRoutePeer({ ...base, peerKind: "direct", peerId: "U42", to: "U42" }),
    ).toBe(false);
    expect(
      validateSlackSessionRoutePeer({
        ...base,
        accountId: undefined,
        peerKind: "channel",
        peerId: "C123",
        to: "channel:C123",
      }),
    ).toBe(false);
  });
});
