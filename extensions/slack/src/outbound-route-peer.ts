// Slack owns target grammar; the host verifies the persisted route and decision.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";

export const validateSlackSessionRoutePeer: NonNullable<
  ChannelOutboundAdapter["validateSessionRoutePeer"]
> = ({ peerKind, peerId, to, accountId }) => {
  if (
    typeof accountId !== "string" ||
    !accountId.trim() ||
    !/^(?:team:t[a-z0-9]+:)?(?:channel:[cdg][a-z0-9]+|user:[buw][a-z0-9]+)$/i.test(to)
  ) {
    return false;
  }
  const peer = peerId.toLowerCase();
  const qualified = /^(team:t[a-z0-9]+:)?(channel|user):([a-z0-9]+)$/.exec(peer);
  const team = qualified?.[1] ?? "";
  const kind = qualified?.[2];
  const id = qualified?.[3] ?? peer;
  let target: string | undefined;
  if (peerKind === "channel" || peerKind === "group") {
    if ((!kind || kind === "channel") && /^[cdg][a-z0-9]+$/.test(id)) {
      target = `${team}channel:${id}`;
    }
  } else if ((!kind || kind === "user") && /^[buw][a-z0-9]+$/.test(id)) {
    target = `${team}user:${id}`;
  } else if ((!kind || kind === "channel") && /^d[a-z0-9]+$/.test(id)) {
    target = `${team}channel:${id}`;
  }
  return target === to.toLowerCase();
};
