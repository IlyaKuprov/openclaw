// Slack plugin module implements threading tool context behavior.
import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";
import { formatSlackApprovalTarget, parseSlackApprovalTarget } from "./approval-target.js";
import { normalizeSlackThreadTsCandidate } from "./thread-ts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  // Preserve the inbound resolver's exact channel match, including names resolved at startup.
  const configuredReplyToMode =
    params.context.ReplyToMode ?? resolveSlackReplyToMode(account, params.context.ChatType);
  const messageThreadTs = normalizeSlackThreadTsCandidate(params.context.MessageThreadId);
  const transportThreadTs = normalizeSlackThreadTsCandidate(params.context.TransportThreadId);
  const replyToThreadTs = normalizeSlackThreadTsCandidate(params.context.ReplyToId);
  const currentMessageTs = normalizeSlackThreadTsCandidate(params.context.CurrentMessageId);
  const currentThreadTs =
    messageThreadTs ?? transportThreadTs ?? replyToThreadTs ?? currentMessageTs;
  const hasExplicitThreadTarget =
    messageThreadTs != null ||
    transportThreadTs != null ||
    (replyToThreadTs != null && currentMessageTs != null && replyToThreadTs !== currentMessageTs);
  const effectiveReplyToMode = hasExplicitThreadTarget ? "all" : configuredReplyToMode;
  // For channel messages, To is "channel:C…" — extract the bare ID.
  // For DMs, prefer NativeChannelId for channel-scoped actions, but keep the
  // user target as a valid implicit send destination when no D… id is known.
  const rawMessagingTarget = normalizeOptionalString(params.context.To);
  const currentMessagingTarget = qualifyEnterpriseApprovalTarget({
    enterpriseOrgInstall: account.config.enterpriseOrgInstall === true,
    teamId: normalizeOptionalString(
      (params.context as ChannelThreadingContext & { GroupSpace?: string }).GroupSpace,
    ),
    target: rawMessagingTarget,
  });
  const currentChannelId = currentMessagingTarget?.startsWith("channel:")
    ? currentMessagingTarget.slice("channel:".length)
    : (normalizeOptionalString(params.context.NativeChannelId) ?? currentMessagingTarget);
  return {
    currentChannelId,
    currentMessagingTarget,
    currentThreadTs,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
    sameChannelThreadRequired: hasExplicitThreadTarget,
  };
}

function qualifyEnterpriseApprovalTarget(params: {
  enterpriseOrgInstall: boolean;
  teamId?: string;
  target?: string;
}): string | undefined {
  if (!params.enterpriseOrgInstall || !params.teamId || !params.target) {
    return params.target;
  }
  const target = parseSlackApprovalTarget(params.target, { defaultKind: "channel" });
  return target
    ? formatSlackApprovalTarget({ kind: target.kind, id: target.id, teamId: params.teamId })
    : params.target;
}
