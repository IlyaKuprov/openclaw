/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */

import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { collectPayloadMediaSources } from "../../infra/outbound/deliver-payload.js";
import {
  isOutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import { decideOutboundRoute } from "../../infra/outbound/outbound-route-decision.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { parseSessionDeliveryRoute } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  type ReplyDeliveryContext,
} from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import {
  formatBtwTextForExternalDelivery,
  shouldSuppressReasoningPayload,
} from "./reply-payloads.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";

const messageRuntimeLoader = createLazyImportLoader(
  () => import("../../channels/message/runtime.js"),
);

const BLOCK_REPLY_COMPLETION_RETENTION = {
  idPrefix: "block-reply:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

function loadDeliverRuntime() {
  return messageRuntimeLoader.load();
}

function replyDeliverySourceMatchesRoute(params: {
  source: NonNullable<
    NonNullable<ReturnType<typeof getReplyPayloadMetadata>>["replyDeliverySource"]
  >;
  payloadDelivery: ReplyDeliveryContext;
  routeDelivery: ReplyDeliveryContext;
  channel: string;
  accountId?: string;
}): boolean {
  const sourceChannel =
    normalizeMessageChannel(params.source.channel) ??
    normalizeOptionalLowercaseString(params.source.channel);
  const routeChannel =
    normalizeMessageChannel(params.channel) ?? normalizeOptionalLowercaseString(params.channel);
  return (
    sourceChannel === routeChannel &&
    normalizeAccountId(params.source.accountId) === normalizeAccountId(params.accountId) &&
    normalizeChatType(params.payloadDelivery.chatType ?? undefined) ===
      normalizeChatType(params.routeDelivery.chatType ?? undefined)
  );
}

type RouteReplyParams = {
  /** The reply payload to send. */
  payload: ReplyPayload;
  /** The originating channel type. */
  channel: OriginatingChannelType;
  /** The destination chat/channel/user ID. */
  to: string;
  /** Session key for deriving agent identity defaults (multi-agent). */
  sessionKey?: string;
  /** Prepared owner for unscoped sessions; an agent-scoped target remains authoritative. */
  agentId?: string;
  /** Session key for policy resolution when native-command delivery targets a different session. */
  policySessionKey?: string;
  /** Explicit conversation type for policy resolution when the policy key is generic. */
  policyConversationType?: SilentReplyConversationType;
  /** Trusted owner-private command route; the session identifies the command, not its DM recipient. */
  ownerPrivateCommandRoute?: true;
  /** Provider account id (multi-account). */
  accountId?: string;
  /** Originating sender id for sender-scoped outbound media policy. */
  requesterSenderId?: string;
  /** Originating sender display name for name-keyed sender policy matching. */
  requesterSenderName?: string;
  /** Originating sender username for username-keyed sender policy matching. */
  requesterSenderUsername?: string;
  /** Originating sender E.164 phone number for e164-keyed sender policy matching. */
  requesterSenderE164?: string;
  /** Thread id for replies (Telegram topic id or Matrix thread event id). */
  threadId?: string | number;
  /** Originating inbound message fact for the owning channel's reply resolver. */
  currentMessageId?: string;
  /** Reply policy fallback for delivery kinds that do not carry payload metadata. */
  replyDelivery?: ReplyDeliveryContext;
  /** Config for provider-specific settings. */
  cfg: OpenClawConfig;
  /** Optional abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
  /** Mirror reply into session transcript (default: true when sessionKey is set). */
  mirror?: boolean;
  /** Whether this message is being sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier for correlation with received events */
  groupId?: string;
  /** Reply lane for reply_payload_sending hooks. */
  replyKind: ReplyDispatchKind;
  /** Agent run id for hook context. */
  runId?: string;
  /** @internal Stable producer-owned block delivery intent. */
  deliveryIntentId?: string;
  /** Model/session context for response-prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
};

type RouteReplyResult = {
  /** Whether the reply was sent successfully. */
  ok: boolean;
  /** Whether a recipient-visible send completed or may already have completed. */
  delivered: boolean;
  /** True when the adapter may have sent but returned no delivery identity. */
  ambiguous?: boolean;
  queueCustody?: "held" | "released";
  /** Host routing owns this outcome; callers must not try an original-surface fallback. */
  routeDecisionControlled?: true;
  /** True when a hook intentionally suppressed provider delivery. */
  suppressed?: boolean;
  /** Delivery disposition reason when additional caller context is useful. */
  reason?:
    | "reasoning_payload_not_external"
    | "channel_transform"
    | "adapter_returned_no_identity"
    | "adapter_returned_no_send"
    | "cancelled_by_message_sending_hook"
    | "cancelled_by_reply_payload_sending_hook"
    | "empty_after_message_sending_hook"
    | "empty_after_reply_payload_sending_hook";
  /** Optional message ID from the provider. */
  messageId?: string;
  /** Error message if the send failed. */
  error?: string;
  /** Original failure retains the delivery owner's no-send proof. */
  cause?: unknown;
};

function summarizeVisibleRouteReplyDelivery(
  results: readonly { messageId?: string }[],
): Pick<RouteReplyResult, "delivered" | "messageId"> {
  // Durable results may prove delivery through a receipt or alternate identity
  // when messageId is empty. Provider success sentinels prove delivery but are
  // not editable IDs; explicit suppression sentinels prove neither.
  let delivered = false;
  let lastVisibleMessageId: string | undefined;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result) {
      continue;
    }
    const messageId = result.messageId?.trim().toLowerCase();
    if (messageId === "skipped" || messageId === "suppressed") {
      continue;
    }
    if (!delivered) {
      delivered = true;
      if (!messageId) {
        lastVisibleMessageId = result.messageId;
      }
    }
    if (messageId && messageId !== "unknown" && messageId !== "ok") {
      return { delivered: true, messageId: result.messageId };
    }
  }
  return {
    delivered,
    messageId: delivered ? lastVisibleMessageId : undefined,
  };
}

/**
 * Routes a reply payload to the specified channel.
 *
 * This function provides a unified interface for sending messages to any
 * supported provider. It's used by the followup queue to route replies
 * back to the originating channel when OriginatingChannel/OriginatingTo
 * are set.
 */
export async function routeReply(params: RouteReplyParams): Promise<RouteReplyResult> {
  const { payload, channel, to, accountId, threadId, cfg, abortSignal } = params;
  if (shouldSuppressReasoningPayload(payload)) {
    return {
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "reasoning_payload_not_external",
    };
  }
  const resolvedAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: cfg,
    fallbackAgentId: params.agentId,
  });
  // Followups may originate elsewhere while their session belongs to a Slack channel.
  // An owner-private command instead carries an independently resolved DM target;
  // rerouting by the command's group session would disclose its contents there.
  let decidedRoute: Awaited<ReturnType<typeof decideOutboundRoute>>;
  try {
    decidedRoute =
      params.sessionKey && !params.ownerPrivateCommandRoute
        ? await decideOutboundRoute({
            cfg,
            agentId: resolvedAgentId,
            event: {
              sessionKey: params.sessionKey,
              original: { channel, to, accountId, threadId },
            },
          })
        : undefined;
  } catch (error) {
    const message = `Failed to decide reply route: ${formatErrorMessage(error)}`;
    return {
      ok: false,
      delivered: false,
      routeDecisionControlled: true,
      error: message,
      cause: new PlatformMessageNotDispatchedError(message, { cause: error }),
    };
  }
  const deliveryChannel = decidedRoute?.decision.channel ?? channel;
  const deliveryTo = decidedRoute?.decision.to ?? to;
  const deliveryAccountId = decidedRoute?.decision.accountId ?? accountId;
  const normalizedChannel = normalizeMessageChannel(deliveryChannel);
  const channelId =
    normalizeChannelId(deliveryChannel) ??
    normalizeOptionalLowercaseString(deliveryChannel) ??
    null;
  const loadedPlugin = channelId ? getLoadedChannelPlugin(channelId) : undefined;
  const bundledPlugin = channelId && !loadedPlugin ? getBundledChannelPlugin(channelId) : undefined;
  const messaging = loadedPlugin?.messaging ?? bundledPlugin?.messaging;
  const threading = loadedPlugin?.threading ?? bundledPlugin?.threading;
  // Debug: `pnpm test src/auto-reply/reply/route-reply.test.ts`
  const responsePrefix = resolveEffectiveMessagesConfig(cfg, resolvedAgentId, {
    channel: normalizedChannel,
    accountId: deliveryAccountId,
  }).responsePrefix;
  const transformReplyPayload = createChannelReplyTransform({
    messaging,
    cfg,
    accountId: deliveryAccountId,
  });
  const normalization = normalizeReplyPayloadOutcome(payload, {
    responsePrefix,
    responsePrefixContext: params.responsePrefixContext,
    transformReplyPayload,
  });
  if (normalization.kind === "suppress") {
    if (normalization.reason === "channel_transform") {
      return {
        ok: true,
        delivered: false,
        suppressed: true,
        reason: normalization.reason,
      };
    }
    return { ok: true, delivered: false };
  }
  const normalized = normalization.payload;
  const externalPayload: ReplyPayload = {
    ...normalized,
    text: formatBtwTextForExternalDelivery(normalized),
  };

  const text = externalPayload.text ?? "";
  let mediaUrls: string[] = [];
  for (const url of externalPayload.mediaUrls ?? []) {
    if (url) {
      mediaUrls.push(url);
    }
  }
  if (mediaUrls.length === 0 && externalPayload.mediaUrl) {
    mediaUrls = [externalPayload.mediaUrl];
  }
  const replyToId = externalPayload.replyToId;
  const hasChannelData = messaging?.hasStructuredReplyPayload?.({
    payload: externalPayload,
  });

  // Skip empty replies.
  if (
    !hasReplyPayloadContent(
      {
        ...externalPayload,
        text,
        mediaUrls,
      },
      {
        hasChannelData,
      },
    )
  ) {
    return { ok: true, delivered: false };
  }

  const rejectBeforeSend = (error: string): RouteReplyResult => ({
    ok: false,
    delivered: false,
    error,
    cause: new PlatformMessageNotDispatchedError(error, { cause: undefined }),
  });
  if (deliveryChannel === INTERNAL_MESSAGE_CHANNEL) {
    return rejectBeforeSend("Webchat routing not supported for queued replies");
  }
  if (!channelId) {
    return rejectBeforeSend(`Unknown channel: ${String(channel)}`);
  }
  if (abortSignal?.aborted) {
    return rejectBeforeSend("Reply routing aborted");
  }

  const payloadMetadata = getReplyPayloadMetadata(normalized);
  const payloadReplyDelivery = payloadMetadata?.replyDelivery;
  const payloadPolicyMatchesRoute =
    payloadReplyDelivery && params.replyDelivery && payloadMetadata.replyDeliverySource
      ? replyDeliverySourceMatchesRoute({
          source: payloadMetadata.replyDeliverySource,
          payloadDelivery: payloadReplyDelivery,
          routeDelivery: params.replyDelivery,
          channel: channelId,
          accountId,
        })
      : false;
  const decidedPeerKind = decidedRoute
    ? parseSessionDeliveryRoute(params.sessionKey)?.peerKind
    : undefined;
  const decidedIsGroup = decidedPeerKind === "channel" || decidedPeerKind === "group";
  const decidedConversationType =
    decidedPeerKind === "direct" || decidedPeerKind === "dm" ? "direct" : "group";
  const replyDelivery = decidedRoute
    ? ({ chatType: decidedConversationType, replyToMode: "off" } as const)
    : payloadPolicyMatchesRoute
      ? payloadReplyDelivery
      : (params.replyDelivery ?? payloadReplyDelivery);
  const replyTransport = decidedRoute
    ? null
    : (threading?.resolveReplyTransport?.({
        cfg,
        accountId: deliveryAccountId,
        threadId,
        replyToId,
        currentMessageId: params.currentMessageId,
        replyToIsExplicit: Boolean(
          payloadMetadata?.replyToIdExplicit || normalized.replyToTag || normalized.replyToCurrent,
        ),
        replyToCurrent: normalized.replyToCurrent,
        replyDelivery,
      }) ?? null);
  const resolvedReplyToId =
    decidedRoute || replyTransport?.replyToId === null
      ? undefined
      : (replyTransport?.replyToId ?? replyToId ?? undefined);
  const resolvedThreadId = decidedRoute
    ? null
    : replyTransport && Object.hasOwn(replyTransport, "threadId")
      ? (replyTransport.threadId ?? null)
      : (threadId ?? null);
  const deliveryPayload = copyReplyPayloadMetadata(
    normalized,
    decidedRoute
      ? {
          ...externalPayload,
          replyToId: undefined,
          replyToCurrent: undefined,
          replyToTag: undefined,
        }
      : { ...externalPayload, replyToId: resolvedReplyToId },
  );

  try {
    // Provider docking: this is an execution boundary (we're about to send).
    // Keep the module cheap to import by loading outbound plumbing lazily.
    const { durableMessageBatchMayHaveReachedRecipient, sendDurableMessageBatchCore } =
      await loadDeliverRuntime();
    decidedRoute?.assertCurrent();
    const outboundSession = buildOutboundSessionContext({
      cfg,
      agentId: resolvedAgentId,
      sessionKey: params.sessionKey,
      policySessionKey: decidedRoute ? params.sessionKey : params.policySessionKey,
      conversationType: decidedRoute ? decidedConversationType : params.policyConversationType,
      isGroup:
        params.policySessionKey || params.policyConversationType ? undefined : params.isGroup,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
    });
    const send = await sendDurableMessageBatchCore({
      cfg,
      channel: channelId,
      to: deliveryTo,
      accountId: deliveryAccountId ?? undefined,
      payloads: [deliveryPayload],
      replyPayloadSendingHook: {
        kind: params.replyKind,
        channel: channelId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        context: {
          channelId,
          ...(deliveryAccountId ? { accountId: deliveryAccountId } : {}),
          conversationId: deliveryTo,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.requesterSenderId ? { senderId: params.requesterSenderId } : {}),
          ...(params.runId ? { runId: params.runId } : {}),
        },
      },
      replyToId: resolvedReplyToId ?? null,
      threadId: resolvedThreadId,
      ...(decidedRoute
        ? {
            routeAuthority: {
              agentId: resolvedAgentId,
              storePath: resolveSessionStorePathCore(cfg.session?.store, {
                agentId: resolvedAgentId,
              }),
              sessionKey: params.sessionKey!,
              channel: channelId,
              to: deliveryTo,
              ...(deliveryAccountId ? { accountId: deliveryAccountId } : {}),
              sourceChannel: channel,
            },
            rootReplyOnly: true as const,
            replyToMode: "off" as const,
            mediaAccess: resolveAgentScopedOutboundMediaAccess({
              cfg,
              agentId: resolvedAgentId,
              sessionKey: params.sessionKey,
              accountId: deliveryAccountId,
              requesterSenderId: params.requesterSenderId,
              requesterSenderName: params.requesterSenderName,
              requesterSenderUsername: params.requesterSenderUsername,
              requesterSenderE164: params.requesterSenderE164,
              mediaSources: collectPayloadMediaSources([deliveryPayload]),
            }),
            onDirectAdapterHandoff: async () => decidedRoute.assertCurrent(),
            assertBeforeQueueAdmission: decidedRoute.assertCurrent,
            assertDirectAdapterHandoff: decidedRoute.assertCurrent,
            onPlatformSendDispatch: async () => decidedRoute.assertCurrent(),
          }
        : {}),
      session: outboundSession,
      signal: abortSignal,
      ...(params.deliveryIntentId
        ? {
            deliveryIntentId: params.deliveryIntentId,
            reusePendingDeliveryIntent: true,
            completionRetention: BLOCK_REPLY_COMPLETION_RETENTION,
            durability: "required" as const,
          }
        : {}),
      mirror:
        params.mirror !== false && params.sessionKey
          ? {
              sessionKey: params.sessionKey,
              agentId: resolvedAgentId,
              text,
              mediaUrls,
              ...(decidedRoute
                ? {
                    isGroup: decidedIsGroup,
                    ...(decidedIsGroup ? { groupId: deliveryTo } : {}),
                  }
                : {
                    ...(params.isGroup != null ? { isGroup: params.isGroup } : {}),
                    ...(params.groupId ? { groupId: params.groupId } : {}),
                  }),
            }
          : undefined,
    });
    if (send.status === "failed" || send.status === "partial_failed") {
      const delivery = summarizeVisibleRouteReplyDelivery(
        send.status === "failed" ? [] : send.results,
      );
      return {
        ok: false,
        delivered: delivery.delivered,
        ...(decidedRoute ? { routeDecisionControlled: true } : {}),
        error: `Failed to route reply to ${deliveryChannel}: ${formatErrorMessage(send.error)}`,
        cause: send.error,
        messageId: delivery.messageId,
        ...(!delivery.delivered && durableMessageBatchMayHaveReachedRecipient(send)
          ? { ambiguous: true }
          : {}),
        ...(isOutboundDeliveryError(send.error) && send.error.queueCustody
          ? { queueCustody: send.error.queueCustody }
          : {}),
      };
    }
    if (
      send.status === "suppressed" &&
      (send.reason === "cancelled_by_message_sending_hook" ||
        send.reason === "adapter_returned_no_send" ||
        send.reason === "cancelled_by_reply_payload_sending_hook" ||
        send.reason === "empty_after_message_sending_hook" ||
        send.reason === "empty_after_reply_payload_sending_hook")
    ) {
      return {
        ok: true,
        delivered: false,
        suppressed: true,
        reason: send.reason,
      };
    }
    if (send.status === "suppressed" && durableMessageBatchMayHaveReachedRecipient(send)) {
      return {
        ok: true,
        delivered: false,
        ambiguous: true,
        reason: "adapter_returned_no_identity",
      };
    }
    const results = send.status === "sent" ? send.results : [];
    const delivery = summarizeVisibleRouteReplyDelivery(results);
    return {
      ok: true,
      delivered: delivery.delivered,
      messageId: delivery.messageId,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    return {
      ok: false,
      delivered: false,
      ...(decidedRoute ? { routeDecisionControlled: true } : {}),
      ...(isOutboundDeliveryError(err)
        ? {
            queueCustody: err.queueCustody,
            ...(err.sentBeforeError ? { ambiguous: true } : {}),
          }
        : {}),
      error: `Failed to route reply to ${deliveryChannel}: ${message}`,
      cause: err,
    };
  }
}

/**
 * Checks if a channel type is routable via routeReply.
 *
 * Some channels (webchat) require special handling and cannot be routed through
 * this generic interface.
 */
export function isRoutableChannel(
  channel: OriginatingChannelType | undefined,
): channel is Exclude<OriginatingChannelType, typeof INTERNAL_MESSAGE_CHANNEL> {
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  return normalizeChatChannelId(channel) !== null || normalizeChannelId(channel) !== null;
}
