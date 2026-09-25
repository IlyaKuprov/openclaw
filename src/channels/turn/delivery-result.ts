// Delivery-result adapters for channel turn receipts.
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { isReplyDispatchDeliveryPending } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptThreadId,
} from "../message/receipt.js";
import type { MessageReceipt } from "../message/types.js";
import type {
  ChannelDeliveryIntent,
  ChannelDeliveryOutcome,
  ChannelDeliveryResult,
  ChannelEventDeliveryAdapter,
} from "./types.js";

export function isExplicitlyNonVisibleChannelDelivery(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

function markChannelDeliveryErrorVisible(error: unknown): unknown {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    try {
      Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
      return error;
    } catch {
      // Fall back to a wrapper when a platform error object is non-extensible.
    }
  }
  const visibleError = new Error("visible channel reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

/** Observers after visible sends cannot disguise delivery as a safe retry. */
export async function runChannelDeliveryObserver(params: {
  onDelivered: ChannelEventDeliveryAdapter["onDelivered"] | undefined;
  payload: ReplyPayload;
  info: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[1];
  result: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[2];
}): Promise<void> {
  if (!params.onDelivered || isReplyDispatchDeliveryPending(params.result)) {
    return;
  }
  try {
    await params.onDelivered(params.payload, params.info, params.result);
  } catch (error: unknown) {
    throw isExplicitlyNonVisibleChannelDelivery(params.result)
      ? error
      : markChannelDeliveryErrorVisible(error);
  }
}

type ReceiptParams = Parameters<typeof createMessageReceiptFromOutboundResults>[0];

/** Aggregates caller-confirmed sends, preserving nested receipts before legacy message IDs. */
export function createAcceptedChannelDeliveryResult(
  params: Pick<ReceiptParams, "kind" | "replyToId"> & {
    results?: ReceiptParams["results"];
    deliveryResults?: readonly ChannelDeliveryOutcome[];
    content?: string;
  },
): {
  messageIds: string[];
  receipt: MessageReceipt;
  visibleReplySent: true;
  content?: string;
} {
  const { deliveryResults, content, ...receiptParams } = params;
  const results = deliveryResults
    ? [
        ...(receiptParams.results ?? []),
        ...deliveryResults.flatMap((result): ReceiptParams["results"] =>
          result.receipt
            ? [{ receipt: result.receipt }]
            : (result.messageIds ?? []).map((messageId) => ({ messageId })),
        ),
      ]
    : (receiptParams.results ?? []);
  const receipt = createMessageReceiptFromOutboundResults({ ...receiptParams, results });
  return {
    messageIds: listMessageReceiptPlatformIds(receipt),
    receipt,
    visibleReplySent: true,
    ...(content === undefined ? {} : { content }),
  };
}

/** Builds a typed non-visible channel outcome without transport identity. */
export function createSuppressedChannelDeliveryResult(params: {
  reason: NonNullable<ChannelDeliveryResult["suppression"]>["reason"];
  cancelReason?: string;
  metadata?: Record<string, unknown>;
}): ChannelDeliveryResult {
  return {
    visibleReplySent: false,
    suppression: {
      reason: params.reason,
      ...(params.cancelReason ? { cancelReason: params.cancelReason } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
  };
}

const CHANNEL_PARTIAL_DELIVERY_ERROR_CODE = "CHANNEL_PARTIAL_DELIVERY";

type ChannelPartialDeliveryEnvelope = {
  cause?: unknown;
  code: typeof CHANNEL_PARTIAL_DELIVERY_ERROR_CODE;
  deliveryResult: ChannelDeliveryOutcome & { visibleReplySent: true };
};

export type ChannelPartialDeliveryError = Error & ChannelPartialDeliveryEnvelope;

/** Preserves provider-visible delivery facts when a later native operation fails. */
export function createChannelPartialDeliveryError(
  cause: unknown,
  deliveryResult: ChannelDeliveryOutcome & { visibleReplySent: true },
): ChannelPartialDeliveryError & { sentBeforeError: true; visibleReplySent: true } {
  return Object.assign(new Error(formatErrorMessage(cause), { cause }), {
    code: "CHANNEL_PARTIAL_DELIVERY" as const,
    deliveryResult,
    sentBeforeError: true as const,
    visibleReplySent: true as const,
  });
}

export function isChannelPartialDeliveryError(
  error: unknown,
): error is ChannelPartialDeliveryEnvelope {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const candidate = error as { code?: unknown; deliveryResult?: unknown };
  return (
    candidate.code === CHANNEL_PARTIAL_DELIVERY_ERROR_CODE &&
    Boolean(
      candidate.deliveryResult &&
      typeof candidate.deliveryResult === "object" &&
      !Array.isArray(candidate.deliveryResult) &&
      (candidate.deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === true,
    )
  );
}

/** Converts a normalized message receipt into the delivery result shape used by channel turns. */
export function createChannelDeliveryResultFromReceipt(params: {
  receipt: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  content?: string;
  deliveryIntent?: ChannelDeliveryIntent;
}): ChannelDeliveryResult {
  const messageIds = listMessageReceiptPlatformIds(params.receipt);
  const threadId = resolveMessageReceiptThreadId(params.receipt, params.threadId);
  return {
    ...(messageIds.length > 0 ? { messageIds } : {}),
    receipt: params.receipt,
    ...(threadId ? { threadId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.visibleReplySent === undefined ? {} : { visibleReplySent: params.visibleReplySent }),
    ...(params.content === undefined ? {} : { content: params.content }),
    ...(params.deliveryIntent ? { deliveryIntent: params.deliveryIntent } : {}),
  };
}
