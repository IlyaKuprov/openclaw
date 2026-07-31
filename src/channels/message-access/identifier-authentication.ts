/**
 * Ordered sender identifier authentication strength.
 *
 * Two independent claims decide whether a matched allowlist entry may authorize a sender:
 * how strongly the *entry* names someone, and how strongly the *message* proved the sender
 * holds that name. Channels whose transport authenticates the session only ever supply the
 * first, so they say nothing per message and nothing weakens. Channels that authenticate
 * per message supply both.
 *
 * The gate takes the weaker of the two. An unforgeable identifier proves nothing when the
 * message carrying it was never authenticated, and an authenticated message proves nothing
 * when the identifier it carries is an alias anyone can adopt.
 */

/**
 * Ordered strength of one identifier claim, strongest first.
 *
 * - `verified`: a trusted boundary bound this exact identifier to this sender.
 * - `asserted`: a trusted boundary vouched for something about the sender, but not for
 *   this identifier specifically. The default for an identifier a channel does not
 *   describe, because a channel that stays silent has not earned `verified`.
 * - `unverified`: an exact, stable identifier whose claimed ownership nobody proved.
 * - `mutable`: an alias. Two senders can hold it at once, so it identifies nobody even
 *   when honestly set.
 *
 * `unverified` and `mutable` are both below the default minimum and are kept apart because
 * they are weak for different reasons, and the diagnostic has to say which. Collapsing them
 * makes an unauthenticated email address read as a nickname.
 */
export type IdentifierAuthentication = "verified" | "asserted" | "unverified" | "mutable";

const RANK: Record<IdentifierAuthentication, number> = {
  verified: 3,
  asserted: 2,
  unverified: 1,
  mutable: 0,
};

/**
 * Strength assumed for an identifier no channel described.
 *
 * `asserted` rather than `verified`: a channel that has not stated what backs an identifier
 * has not earned the strongest claim. It is also the shipped minimum, so silence keeps
 * today's behavior instead of quietly failing closed on every existing channel.
 */
export const DEFAULT_IDENTIFIER_AUTHENTICATION: IdentifierAuthentication = "asserted";

/** Returns true when `actual` meets or exceeds `minimum`. */
export function meetsIdentifierAuthentication(
  actual: IdentifierAuthentication,
  minimum: IdentifierAuthentication,
): boolean {
  return RANK[actual] >= RANK[minimum];
}

/** Returns the weaker of two claims, which is how the entry and subject sides combine. */
export function weakestIdentifierAuthentication(
  a: IdentifierAuthentication,
  b: IdentifierAuthentication,
): IdentifierAuthentication {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * Resolves the strength an identity field declares.
 *
 * `dangerous: true` is the pre-existing spelling of `mutable` and is the only thing most
 * channels currently say. Keeping the mapping here rather than at each call site is what
 * lets the kernel run on one scale while channels migrate.
 */
export function identifierAuthenticationFrom(params: {
  authentication?: IdentifierAuthentication;
  dangerous?: boolean;
}): IdentifierAuthentication {
  if (params.authentication) {
    return params.authentication;
  }
  return params.dangerous ? "mutable" : DEFAULT_IDENTIFIER_AUTHENTICATION;
}

/**
 * Resolves the minimum a policy requires.
 *
 * `mutableIdentifierMatching` is the two-level spelling of this gate: `enabled` accepts
 * everything, anything else rejects aliases. Both map onto the scale exactly, so a channel
 * that never sets `minIdentifierAuthentication` keeps its current admissions.
 */
export function minimumIdentifierAuthenticationFrom(params: {
  minIdentifierAuthentication?: IdentifierAuthentication;
  mutableIdentifierMatching?: "disabled" | "enabled";
}): IdentifierAuthentication {
  if (params.minIdentifierAuthentication) {
    return params.minIdentifierAuthentication;
  }
  return params.mutableIdentifierMatching === "enabled"
    ? "mutable"
    : DEFAULT_IDENTIFIER_AUTHENTICATION;
}
