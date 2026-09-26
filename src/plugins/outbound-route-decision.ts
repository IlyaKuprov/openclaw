import { parseSessionDeliveryRoute } from "../sessions/session-key-utils.js";

/** Only the canonical session and the original route are visible to the plugin. */
export type PluginHookOutboundRouteDecisionEvent = {
  sessionKey: string;
  original: { channel: string; to: string; accountId?: string; threadId?: string | number };
};

/** A request, not a send. The host owns route verification, media and transport. */
export type PluginHookOutboundRouteDecisionResult = {
  channel: string;
  to: string;
  accountId?: string;
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

/** Channel-owned proof that a canonical session peer denotes the exact stored target. */
export type OutboundRoutePeerValidator = (params: {
  peerKind: "channel" | "group" | "direct" | "dm";
  peerId: string;
  to: string;
  accountId?: string;
}) => boolean;

function isNonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** Reject missing or conflicting authority before the caller changes either delivery path. */
export function validateOutboundRouteDecision(
  event: PluginHookOutboundRouteDecisionEvent,
  persisted: PersistedOutboundRouteProof | undefined,
  decision: unknown,
  validatePeer: OutboundRoutePeerValidator | undefined,
): PluginHookOutboundRouteDecisionResult {
  const parsed = parseSessionDeliveryRoute(event.sessionKey);
  if (
    !parsed ||
    !isNonempty(parsed.channel) ||
    !persisted ||
    persisted.sessionKey !== event.sessionKey ||
    !isNonempty(event.original.channel) ||
    !isNonempty(persisted.to) ||
    (persisted.accountId !== undefined && !isNonempty(persisted.accountId)) ||
    persisted.channel !== parsed.channel ||
    (parsed.accountId !== undefined && parsed.accountId !== persisted.accountId) ||
    (event.original.channel === persisted.channel &&
      (!isNonempty(event.original.to) ||
        event.original.to !== persisted.to ||
        event.original.accountId !== persisted.accountId ||
        event.original.threadId !== persisted.threadId)) ||
    (parsed.threadId !== undefined &&
      (persisted.threadId === undefined || String(persisted.threadId) !== parsed.threadId)) ||
    !validatePeer ||
    !validatePeer({
      peerKind: parsed.peerKind,
      peerId: parsed.peerId,
      to: persisted.to,
      accountId: persisted.accountId,
    })
  ) {
    throw new Error("outbound route decision lacks matching persisted route authority");
  }
  if (
    typeof decision !== "object" ||
    decision === null ||
    Array.isArray(decision) ||
    !["accountId,channel,threadPolicy,to", "channel,threadPolicy,to"].includes(
      Object.keys(decision).toSorted().join(","),
    )
  ) {
    throw new Error("invalid outbound route decision");
  }
  const requested = decision as Record<string, unknown>;
  if (
    requested.channel !== persisted.channel ||
    requested.threadPolicy !== "root" ||
    requested.to !== persisted.to ||
    requested.accountId !== persisted.accountId
  ) {
    throw new Error("outbound route decision conflicts with persisted route");
  }
  return {
    channel: persisted.channel,
    to: persisted.to,
    ...(persisted.accountId !== undefined ? { accountId: persisted.accountId } : {}),
    threadPolicy: "root",
  };
}
