import { parseSessionDeliveryRoute } from "../sessions/session-key-utils.js";

/** Only the canonical session and the original route are visible to the plugin. */
export type PluginHookOutboundRouteDecisionEvent = {
  sessionKey: string;
  original: { channel: string; to: string; accountId?: string; threadId?: string | number };
};

/** A request, not a send. The host owns route verification, media and transport. */
export type PluginHookOutboundRouteDecisionResult = {
  channel: "slack";
  to: string;
  accountId: string;
  threadPolicy: "root";
};

/** Host-only, exact persisted session entry projection; never supplied by the plugin. */
export type PersistedOutboundRouteProof = {
  sessionKey: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

const SLACK_TARGET = /^((?:team:t[a-z0-9]+:)?(?:channel:[cdg][a-z0-9]+|user:[buw][a-z0-9]+))$/i;

function peerTarget(
  peerKind: "channel" | "group" | "direct" | "dm",
  peerId: string,
): string | null {
  const peer = peerId.toLowerCase();
  const qualified = /^(team:t[a-z0-9]+:)?(channel|user):([a-z0-9]+)$/.exec(peer);
  const team = qualified?.[1] ?? "";
  const kind = qualified?.[2];
  const id = qualified?.[3] ?? peer;
  if (peerKind === "channel" || peerKind === "group") {
    return (!kind || kind === "channel") && /^[cdg][a-z0-9]+$/.test(id)
      ? `${team}channel:${id}`
      : null;
  }
  if ((!kind || kind === "user") && /^[buw][a-z0-9]+$/.test(id)) {
    return `${team}user:${id}`;
  }
  return (!kind || kind === "channel") && /^d[a-z0-9]+$/.test(id) ? `${team}channel:${id}` : null;
}

function isNonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** Reject missing or conflicting authority before the caller changes either delivery path. */
export function validateOutboundRouteDecision(
  event: PluginHookOutboundRouteDecisionEvent,
  persisted: PersistedOutboundRouteProof | undefined,
  decision: unknown,
): PluginHookOutboundRouteDecisionResult {
  const parsed = parseSessionDeliveryRoute(event.sessionKey);
  if (
    !parsed ||
    parsed.channel !== "slack" ||
    !persisted ||
    persisted.sessionKey !== event.sessionKey ||
    !isNonempty(event.original.channel) ||
    !isNonempty(persisted.to) ||
    !isNonempty(persisted.accountId) ||
    persisted.channel !== "slack" ||
    (parsed.accountId !== undefined && parsed.accountId !== persisted.accountId) ||
    (event.original.channel === "slack" &&
      (!isNonempty(event.original.to) ||
        !isNonempty(event.original.accountId) ||
        event.original.to !== persisted.to ||
        event.original.accountId !== persisted.accountId ||
        event.original.threadId !== persisted.threadId)) ||
    (parsed.threadId !== undefined &&
      (persisted.threadId === undefined || String(persisted.threadId) !== parsed.threadId)) ||
    !SLACK_TARGET.test(persisted.to) ||
    peerTarget(parsed.peerKind, parsed.peerId) !== persisted.to.toLowerCase()
  ) {
    throw new Error("outbound route decision lacks matching persisted Slack route authority");
  }
  if (
    typeof decision !== "object" ||
    decision === null ||
    Array.isArray(decision) ||
    Object.keys(decision).sort().join(",") !== "accountId,channel,threadPolicy,to"
  ) {
    throw new Error("invalid outbound route decision");
  }
  const requested = decision as Record<string, unknown>;
  if (
    requested.channel !== "slack" ||
    requested.threadPolicy !== "root" ||
    requested.to !== persisted.to ||
    requested.accountId !== persisted.accountId
  ) {
    throw new Error("outbound route decision conflicts with persisted Slack route");
  }
  return {
    channel: "slack",
    to: persisted.to,
    accountId: persisted.accountId,
    threadPolicy: "root",
  };
}
