// Host-owned route decision and durable delivery for inbound final replies.
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.entry.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
} from "../../hooks/message-hook-mappers.js";
import { collectPayloadMediaSources } from "../../infra/outbound/deliver-payload.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  validateOutboundRouteDecision,
  type PersistedOutboundRouteProof,
  type PluginHookOutboundRouteDecisionResult,
} from "../../plugins/outbound-route-decision.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
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

type DecidedOutboundRoute = {
  decision: PluginHookOutboundRouteDecisionResult;
  assertCurrent: () => void;
};

function readPersistedOutboundRoute(
  turn: OutboundRouteTurn,
): PersistedOutboundRouteProof | undefined {
  // Never resolve aliases: the decision must name the row that owns delivery.
  const stored = loadExactSessionEntryReadOnly({
    sessionKey: turn.routeSessionKey,
    storePath: turn.storePath,
    agentId: turn.agentId,
  });
  if (!stored) {
    return undefined;
  }
  const context = deliveryContextFromSession(stored.entry);
  return {
    sessionKey: stored.sessionKey,
    channel: context?.channel,
    to: context?.to,
    accountId: context?.accountId,
    threadId: context?.threadId,
  };
}

/** Resolve only finals with a registered plugin; all other deliveries keep their native route. */
export async function decideFinalOutboundRoute(
  turn: OutboundRouteTurn,
  info: ChannelDeliveryInfo,
): Promise<DecidedOutboundRoute | undefined> {
  const runner = getGlobalHookRunner();
  if (info.kind !== "final" || !runner?.hasHooks("outbound_route_decision")) {
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
  const requested = await runner.runOutboundRouteDecision(
    event,
    { channelId: "slack" },
    readPersistedOutboundRoute(turn),
  );
  if (!requested) {
    return undefined;
  }
  const assertCurrent = () => {
    validateOutboundRouteDecision(event, readPersistedOutboundRoute(turn), requested);
  };
  assertCurrent();
  return { decision: requested, assertCurrent };
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
    ctxPayload: turn.ctxPayload,
    payload: rootedPayload,
    info,
    executionIdentityToken: params.executionIdentityToken,
    ...durableOptions,
    to: decision.to,
    threadId: null,
    replyToId: null,
    replyToMode: "off",
    mediaAccess,
    assertRouteAuthority: assertCurrent,
  });
  throwIfDurableInboundReplyDeliveryFailed(routed);
  if (!isDurableInboundReplyDeliveryHandled(routed)) {
    throw new Error(
      `outbound route decision cannot deliver via Slack: ${"reason" in routed ? routed.reason : routed.status}`,
    );
  }
  return { payload: rootedPayload, delivery: routed.delivery };
}
