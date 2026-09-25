// Host-owned route decision and durable delivery for inbound final replies.
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
} from "../../hooks/message-hook-mappers.js";
import { collectPayloadMediaSources } from "../../infra/outbound/deliver-payload.js";
import {
  decideOutboundRoute,
  type DecidedOutboundRoute,
} from "../../infra/outbound/outbound-route-decision.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { parseSessionDeliveryRoute } from "../../routing/session-key.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
  type DurableInboundReplyDeliveryOptions,
} from "./durable-delivery.js";
import type { AssembledChannelTurn, ChannelDeliveryInfo, ChannelDeliveryResult } from "./types.js";

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

/** A decided route has no direct/provider fallback, including unsupported durable preflight. */
export async function deliverDecidedFinalOutboundRoute(params: {
  turn: OutboundRouteTurn;
  route: DecidedOutboundRoute;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
  durableOptions: DurableInboundReplyDeliveryOptions | false | undefined;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
}): Promise<{ payload: ReplyPayload; delivery: ChannelDeliveryResult }> {
  const { turn, route, payload, info, durableOptions } = params;
  const { decision, assertCurrent } = route;
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
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: turn.cfg,
    agentId: turn.agentId,
    sessionKey: turn.routeSessionKey,
    accountId: decision.accountId,
    requesterSenderId: turn.ctxPayload.SenderId ?? turn.ctxPayload.From,
    requesterSenderName: turn.ctxPayload.SenderName,
    requesterSenderUsername: turn.ctxPayload.SenderUsername,
    requesterSenderE164: turn.ctxPayload.SenderE164,
    mediaSources: collectPayloadMediaSources([rootedPayload]),
    mediaAccess: durableOptions ? durableOptions.mediaAccess : undefined,
  });
  const routed = await deliverInboundReplyWithMessageSendContextCore({
    cfg: turn.cfg,
    channel: decision.channel,
    accountId: decision.accountId,
    agentId: turn.agentId,
    ctxPayload: { ...turn.ctxPayload, ChatType: destinationChatType },
    payload: rootedPayload,
    info,
    executionIdentityToken: params.executionIdentityToken,
    ...durableOptions,
    to: decision.to,
    threadId: null,
    replyToId: null,
    replyToMode: "off",
    rootReplyOnly: true,
    mediaAccess,
    assertRouteAuthority: assertCurrent,
    routeAuthority: {
      agentId: turn.agentId,
      storePath:
        turn.storePath ??
        resolveSessionStorePathCore(turn.cfg.session?.store, { agentId: turn.agentId }),
      sessionKey: turn.routeSessionKey,
      channel: decision.channel,
      to: decision.to,
      accountId: decision.accountId,
    },
  });
  throwIfDurableInboundReplyDeliveryFailed(routed);
  if (!isDurableInboundReplyDeliveryHandled(routed)) {
    throw new Error(
      `outbound route decision cannot deliver via ${decision.channel}: ${"reason" in routed ? routed.reason : routed.status}`,
    );
  }
  return { payload: rootedPayload, delivery: routed.delivery };
}
