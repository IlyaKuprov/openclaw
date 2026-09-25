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

const SLACK_CHANNEL_TARGET =
  /^(?:team:(?:T[A-Z0-9]+|t[a-z0-9]+):)?channel:(?:[CDG][A-Z0-9]+|[cdg][a-z0-9]+)$/;

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
    parsed.peerKind !== "channel" ||
    !persisted ||
    persisted.sessionKey !== event.sessionKey ||
    !isNonempty(event.original.channel) ||
    !isNonempty(persisted.to) ||
    !isNonempty(persisted.accountId) ||
    persisted.channel !== "slack" ||
    (event.original.channel === "slack" &&
      (!isNonempty(event.original.to) ||
        !isNonempty(event.original.accountId) ||
        event.original.to !== persisted.to ||
        event.original.accountId !== persisted.accountId ||
        event.original.threadId !== persisted.threadId)) ||
    (parsed.threadId !== undefined &&
      (persisted.threadId === undefined || String(persisted.threadId) !== parsed.threadId)) ||
    !SLACK_CHANNEL_TARGET.test(persisted.to) ||
    (parsed.peerId.includes(":") ? parsed.peerId : `channel:${parsed.peerId}`) !==
      persisted.to.toLowerCase()
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
