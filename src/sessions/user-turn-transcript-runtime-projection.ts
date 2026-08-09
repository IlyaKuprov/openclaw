import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { readPersistedMediaFacts, type MediaFact } from "../media/media-facts.js";
import type { PersistedUserTurnMessage } from "./user-turn-transcript.types.js";

export function readOpenClawMessageMeta(
  message: AgentMessage,
): Record<string, unknown> | undefined {
  return asOptionalRecord((message as unknown as Record<string, unknown>)["__openclaw"]);
}

export function isUserMessage(message: AgentMessage): message is PersistedUserTurnMessage {
  return (message as { role?: unknown }).role === "user";
}

export function buildLateMediaAttachedProjection(message: AgentMessage): {
  text?: string;
  media: MediaFact[];
} {
  const isLateMedia = readOpenClawMessageMeta(message)?.lateMedia === true;
  const media = isLateMedia ? (readPersistedMediaFacts(message) ?? []) : [];
  const text = media
    .flatMap((fact) => {
      const mediaRef = fact.path ?? fact.url;
      return mediaRef ? [`[media attached: ${mediaRef}]`] : [];
    })
    .join("\n");
  return { ...(text ? { text } : {}), media };
}

function isBeforeAgentRunBlockedMessage(message: AgentMessage): boolean {
  const marker = (message as { __openclaw?: { beforeAgentRunBlocked?: unknown } })["__openclaw"]
    ?.beforeAgentRunBlocked;
  return marker !== undefined;
}

function userMessageHasImageContent(message: AgentMessage): boolean {
  return (
    isUserMessage(message) &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "image",
    )
  );
}

// Runtime messages may lack transcript metadata because channel adapters prepare
// display text separately. Merge only safe user messages, never block markers.
export function mergePreparedUserTurnMessageForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (
    !params.preparedMessage ||
    !isUserMessage(params.runtimeMessage) ||
    isBeforeAgentRunBlockedMessage(params.runtimeMessage)
  ) {
    return params.runtimeMessage;
  }
  const runtimeMessage = params.runtimeMessage as unknown as Record<string, unknown>;
  const preparedMessage = params.preparedMessage as unknown as Record<string, unknown>;
  const runtimeMeta = readOpenClawMessageMeta(params.runtimeMessage);
  const preparedMeta = readOpenClawMessageMeta(params.preparedMessage);
  return {
    ...runtimeMessage,
    ...preparedMessage,
    ...(preparedMeta ? { __openclaw: { ...runtimeMeta, ...preparedMeta } } : {}),
    ...(userMessageHasImageContent(params.runtimeMessage)
      ? { content: params.runtimeMessage.content }
      : {}),
  } as unknown as AgentMessage;
}

/** Restores only auth state that write hooks must not be able to forge or erase. */
export function restorePreparedUserTurnOperationalMetaForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (!params.preparedMessage || !isUserMessage(params.runtimeMessage)) {
    return params.runtimeMessage;
  }
  const preparedMeta = readOpenClawMessageMeta(params.preparedMessage);
  const senderIsOwner = preparedMeta?.senderIsOwner;
  if (typeof senderIsOwner !== "boolean") {
    return params.runtimeMessage;
  }
  return {
    ...(params.runtimeMessage as unknown as Record<string, unknown>),
    __openclaw: { ...readOpenClawMessageMeta(params.runtimeMessage), senderIsOwner },
  } as unknown as AgentMessage;
}
