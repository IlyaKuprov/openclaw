/**
 * Channel ingress allowlist diagnostics.
 *
 * Merges allowlists, applies mutable identifier policy, and redacts access-graph facts.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  identifierAuthenticationFrom,
  meetsIdentifierAuthentication,
  minimumIdentifierAuthenticationFrom,
  weakestIdentifierAuthentication,
  type IdentifierAuthentication,
} from "./identifier-authentication.js";
import type {
  ChannelIngressPolicyInput,
  ChannelIngressState,
  IngressReasonCode,
  RedactedIngressAllowlistFacts,
  RedactedIngressEntryDiagnostic,
  ResolvedIngressAllowlist,
  SubjectIdentifierAuthentication,
} from "./types.js";

/**
 * Returns the first access-group related failure reason for an allowlist.
 */
export function allowlistFailureReason(
  allowlist: ResolvedIngressAllowlist,
): IngressReasonCode | null {
  if (allowlist.accessGroups.failed.length > 0) {
    return "access_group_failed";
  }
  if (allowlist.accessGroups.unsupported.length > 0) {
    return "access_group_unsupported";
  }
  if (allowlist.accessGroups.missing.length > 0) {
    return "access_group_missing";
  }
  return null;
}

/**
 * Projects an allowlist into redacted diagnostics safe for ingress access graphs.
 */
export function redactedAllowlistDiagnostics(
  allowlist: ResolvedIngressAllowlist,
  reasonCode: IngressReasonCode,
): RedactedIngressAllowlistFacts {
  return {
    configured: allowlist.hasConfiguredEntries,
    matched: allowlist.match.matched,
    reasonCode,
    matchedEntryIds: allowlist.matchedEntryIds,
    invalidEntryCount: allowlist.invalidEntries.length,
    disabledEntryCount: allowlist.disabledEntries.length,
    accessGroups: allowlist.accessGroups,
  };
}

function mergeResolvedAllowlists(
  allowlists: readonly ResolvedIngressAllowlist[],
): ResolvedIngressAllowlist {
  const matches = allowlists.map((allowlist) => allowlist.match);
  const matchedEntryIds = uniqueStrings(
    allowlists.flatMap((allowlist) => allowlist.matchedEntryIds),
  );
  return {
    rawEntryCount: allowlists.reduce((sum, allowlist) => sum + allowlist.rawEntryCount, 0),
    normalizedEntries: allowlists.flatMap((allowlist) => allowlist.normalizedEntries),
    invalidEntries: allowlists.flatMap((allowlist) => allowlist.invalidEntries),
    disabledEntries: allowlists.flatMap((allowlist) => allowlist.disabledEntries),
    matchedEntryIds,
    hasConfiguredEntries: allowlists.some((allowlist) => allowlist.hasConfiguredEntries),
    hasMatchableEntries: allowlists.some((allowlist) => allowlist.hasMatchableEntries),
    hasWildcard: allowlists.some((allowlist) => allowlist.hasWildcard),
    accessGroups: {
      referenced: uniqueStrings(
        allowlists.flatMap((allowlist) => allowlist.accessGroups.referenced),
      ),
      matched: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.matched)),
      missing: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.missing)),
      unsupported: uniqueStrings(
        allowlists.flatMap((allowlist) => allowlist.accessGroups.unsupported),
      ),
      failed: uniqueStrings(allowlists.flatMap((allowlist) => allowlist.accessGroups.failed)),
    },
    match: {
      matched: matches.some((match) => match.matched) || matchedEntryIds.length > 0,
      matchedEntryIds,
    },
  };
}

/**
 * Strength an entry can actually carry for this message.
 *
 * An entry is matched by a subject identifier of the same kind, so the subject side is read
 * by kind. A wildcard entry is built from the primary identity field and so carries the
 * primary kind, which makes "how well do we know who this is" the question it answers, with
 * no special case.
 */
function effectiveEntryAuthentication(params: {
  entry: ResolvedIngressAllowlist["normalizedEntries"][number];
  subjectAuthentication: SubjectIdentifierAuthentication;
}): IdentifierAuthentication {
  const entry = identifierAuthenticationFrom(params.entry);
  const subject = params.subjectAuthentication[params.entry.kind];
  // An absent subject claim does not weaken: the channel made no per-message statement.
  return subject ? weakestIdentifierAuthentication(entry, subject) : entry;
}

/**
 * Drops allowlist entries whose identifier claim is too weak to authorize this message.
 *
 * Runs after matching rather than during it so a rejected entry stays visible as a
 * diagnostic. An operator who allowlisted a display name should be told it was ignored,
 * not left to infer it from an unexplained block.
 */
export function applyIdentifierAuthenticationPolicy(params: {
  allowlist: ResolvedIngressAllowlist;
  policy: ChannelIngressPolicyInput;
  subjectAuthentication?: SubjectIdentifierAuthentication;
}): ResolvedIngressAllowlist {
  const minimum = minimumIdentifierAuthenticationFrom(params.policy);
  const subjectAuthentication = params.subjectAuthentication ?? {};
  const { allowlist } = params;
  const rejected = allowlist.normalizedEntries.filter(
    (entry) =>
      !meetsIdentifierAuthentication(
        effectiveEntryAuthentication({ entry, subjectAuthentication }),
        minimum,
      ),
  );
  if (rejected.length === 0) {
    return allowlist;
  }
  const rejectedEntryIds = new Set(rejected.map((entry) => entry.opaqueEntryId));
  const matchedEntryIds = allowlist.matchedEntryIds.filter((id) => !rejectedEntryIds.has(id));
  const disabledEntries: RedactedIngressEntryDiagnostic[] = [
    ...allowlist.disabledEntries,
    ...rejected.map((entry) => ({
      opaqueEntryId: entry.opaqueEntryId,
      // The alias case keeps its long-standing code so existing diagnostics do not shift;
      // the new code covers weakness the two-level policy could not express.
      reasonCode:
        identifierAuthenticationFrom(entry) === "mutable"
          ? ("mutable_identifier_disabled" as const)
          : ("identifier_authentication_too_weak" as const),
    })),
  ];
  return {
    ...allowlist,
    disabledEntries,
    matchedEntryIds,
    hasMatchableEntries: allowlist.normalizedEntries.some(
      (entry) => !rejectedEntryIds.has(entry.opaqueEntryId),
    ),
    match: {
      matched: matchedEntryIds.length > 0,
      matchedEntryIds,
    },
  };
}

/**
 * Resolves the sender allowlist used for group/channel ingress after route overrides.
 */
export function effectiveGroupSenderAllowlist(params: {
  state: ChannelIngressState;
  policy: ChannelIngressPolicyInput;
}): ResolvedIngressAllowlist {
  let effective =
    params.policy.groupAllowFromFallbackToAllowFrom &&
    !params.state.allowlists.group.hasConfiguredEntries
      ? params.state.allowlists.dm
      : params.state.allowlists.group;
  for (const route of params.state.routeFacts) {
    if (route.gate !== "matched" || !route.senderAllowlist) {
      continue;
    }
    if (route.senderPolicy === "inherit") {
      effective = mergeResolvedAllowlists([effective, route.senderAllowlist]);
      continue;
    }
    // Route sender policies other than inherit replace the channel-level sender allowlist.
    effective = route.senderAllowlist;
  }
  return applyIdentifierAuthenticationPolicy({
    allowlist: effective,
    policy: params.policy,
    subjectAuthentication: params.state.subjectAuthentication,
  });
}
