// Host-owned route decision and durable delivery for inbound final replies.
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
} from "../../hooks/message-hook-mappers.js";
import {
  decideOutboundRoute,
  type DecidedOutboundRoute,
} from "../../infra/outbound/outbound-route-decision.js";
import { parseSessionDeliveryRoute } from "../../routing/session-key.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
import type {
  AssembledChannelTurn,
  ChannelDeliveryInfo,
  ChannelDeliveryResult,
  ChannelEventDeliveryAdapter,
} from "./types.js";

type OutboundRouteTurn = Pick<
  AssembledChannelTurn,
  "cfg" | "channel" | "accountId" | "agentId" | "routeSessionKey" | "storePath" | "ctxPayload"
>;

/** Resolve only finals with a registered plugin; all other deliveries keep their native route. */
export async function decideFinalOutboundRoute(
  turn: OutboundRouteTurn,
  info: ChannelDeliveryInfo,
): Promise<DecidedOutboundRoute | undefined> {
  if (info.kind !== "final") {
    return undefined;
  }
  const hookCtx = deriveInboundMessageHookContext(turn.ctxPayload);
  const event = {
    sessionKey: turn.routeSessionKey,
    original: {
      channel: turn.channel,
      to: resolveInboundReplyHookTarget(turn.ctxPayload, hookCtx),
      accountId: turn.accountId,
      threadId: turn.ctxPayload.MessageThreadId,
    },
  };
  return await decideOutboundRoute({
    cfg: turn.cfg,
    agentId: turn.agentId,
    storePath: turn.storePath,
    event,
  });
}

/** Keep source error observers off failures before or after a redirected send. */
export function createFinalOutboundRouteDispatch(
  turn: OutboundRouteTurn,
  onSourceError: ChannelEventDeliveryAdapter["onError"],
) {
  const routedAttempts = new WeakSet<ChannelDeliveryInfo>();
  let routeDecision: ReturnType<typeof decideFinalOutboundRoute> | undefined;
  return {
    decide: async (info: ChannelDeliveryInfo) => {
      // The decision can fail before returning a route; no source send was attempted.
      routedAttempts.add(info);
      const route = await (routeDecision ??= decideFinalOutboundRoute(
        turn,
        info.kind === "final" ? info : { ...info, kind: "final" },
      ));
      if (!route) {
        routedAttempts.delete(info);
      }
      return route;
    },
    onError: (error: unknown, info: ChannelDeliveryInfo) => {
      if (!routedAttempts.has(info)) {
        onSourceError?.(error, info);
      }
    },
  };
}

/** A decided route has no direct/provider fallback, including unsupported durable preflight. */
export async function deliverDecidedFinalOutboundRoute(params: {
  turn: OutboundRouteTurn;
  route: DecidedOutboundRoute;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
}): Promise<{ payload: ReplyPayload; delivery: ChannelDeliveryResult }> {
  const { turn, route, payload, info } = params;
  const { decision } = route;
  // The host decision has already validated this session peer against the exact
  // selected target. Source ChatType may describe a different conversation.
  const destinationPeer = parseSessionDeliveryRoute(turn.routeSessionKey);
  if (!destinationPeer || destinationPeer.channel !== decision.channel) {
    throw new Error("outbound route decision lacks matching destination session peer");
  }
  const destinationChatType =
    destinationPeer.peerKind === "dm" ? "direct" : destinationPeer.peerKind;
  const { replyToId: _inheritedReplyToId, ...withoutReply } = payload;
  const rootedPayload = copyReplyPayloadMetadata(payload, withoutReply);
  const routed = await deliverInboundReplyWithMessageSendContextCore({
    cfg: turn.cfg,
    channel: decision.channel,
    accountId: decision.accountId,
    agentId: turn.agentId,
    ctxPayload: { ...turn.ctxPayload, ChatType: destinationChatType },
    payload: rootedPayload,
    info,
    executionIdentityToken: params.executionIdentityToken,
    to: decision.to,
    threadId: null,
    replyToId: null,
    replyToMode: "off",
  });
  throwIfDurableInboundReplyDeliveryFailed(routed);
  if (!isDurableInboundReplyDeliveryHandled(routed)) {
    throw new Error(
      `outbound route decision cannot deliver via ${decision.channel}: ${"reason" in routed ? routed.reason : routed.status}`,
    );
  }
  return { payload: rootedPayload, delivery: routed.delivery };
}
