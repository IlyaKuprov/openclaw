// Slack plugin module implements workspace-qualified approval targets.
import type { MessagingTargetParseOptions } from "openclaw/plugin-sdk/channel-targets";
import { parseSlackTarget, type SlackTargetKind } from "./target-parsing.js";

type SlackApprovalTarget = {
  kind: SlackTargetKind;
  id: string;
  teamId?: string;
};

const SLACK_APPROVAL_TARGET_RE = /^team:([^:]+):(user|channel):([^:]+)$/i;

export function formatSlackApprovalTarget(target: SlackApprovalTarget): string {
  const teamId = target.teamId?.trim();
  const id = target.id.trim();
  if (!teamId) {
    return `${target.kind}:${id}`;
  }
  if (!/^T[A-Z0-9]+$/i.test(teamId) || !isSlackTargetId(target.kind, id)) {
    throw new Error("Invalid Slack workspace-qualified approval target");
  }
  return `team:${teamId}:${target.kind}:${id}`;
}

export function parseSlackApprovalTarget(
  raw: string,
  options: MessagingTargetParseOptions = {},
): SlackApprovalTarget | undefined {
  const trimmed = raw.trim();
  const match = SLACK_APPROVAL_TARGET_RE.exec(trimmed);
  if (match) {
    const teamId = match[1]?.trim();
    const kind = match[2]?.toLowerCase() as SlackTargetKind | undefined;
    const id = match[3]?.trim();
    if (!teamId || !/^T[A-Z0-9]+$/i.test(teamId) || !kind || !id || !isSlackTargetId(kind, id)) {
      throw new Error("Invalid Slack workspace-qualified approval target");
    }
    return { kind, id, teamId };
  }
  if (/^team:/i.test(trimmed)) {
    throw new Error("Invalid Slack workspace-qualified approval target");
  }
  const target = parseSlackTarget(trimmed, options);
  return target ? { kind: target.kind, id: target.id } : undefined;
}

function isSlackTargetId(kind: SlackTargetKind, id: string): boolean {
  return kind === "user" ? /^[UW][A-Z0-9]+$/i.test(id) : /^[CDG][A-Z0-9]+$/i.test(id);
}
