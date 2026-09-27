import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PersistedOutboundRouteProof,
  PluginHookOutboundRouteDecisionEvent,
  PluginHookOutboundRouteDecisionResult,
} from "../../plugins/outbound-route-decision.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";

export type DecidedOutboundRoute = {
  decision: PluginHookOutboundRouteDecisionResult;
  /** Re-read the exact persisted row; throws when it no longer matches the proven route. */
  assertCurrent: () => void;
};

const PROOF_FIELDS = ["sessionKey", "channel", "to", "accountId", "threadId"] as const;

function sameRouteProof(
  before: PersistedOutboundRouteProof | undefined,
  after: PersistedOutboundRouteProof | undefined,
): boolean {
  if (!before || !after) {
    return before === after;
  }
  return PROOF_FIELDS.every((field) => before[field] === after[field]);
}

/**
 * Ask registered plugins for a route decision and validate it against the exact
 * persisted session row. Returns undefined when no plugin is registered or no
 * plugin requests a route; throws when a requested route cannot be proven.
 */
export async function decideOutboundRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  storePath?: string;
  event: PluginHookOutboundRouteDecisionEvent;
}): Promise<DecidedOutboundRoute | undefined> {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("outbound_route_decision")) {
    return undefined;
  }
  const { getChannelPlugin } = await import("../../channels/plugins/index.js");
  const storePath =
    params.storePath ??
    resolveSessionStorePathCore(params.cfg.session?.store, { agentId: params.agentId });
  // This is an exact physical-row probe, never an alias or a last-channel inference.
  const readPersisted = (): PersistedOutboundRouteProof | undefined => {
    const stored = loadExactSessionEntryReadOnly({
      sessionKey: params.event.sessionKey,
      storePath,
      agentId: params.agentId,
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
  };
  const persisted = readPersisted();
  const requested = await runner.runOutboundRouteDecision(
    params.event,
    { channelId: persisted?.channel ?? "" },
    persisted,
    getChannelPlugin(persisted?.channel ?? "")?.outbound?.validateSessionRoutePeer,
  );
  if (!requested) {
    return undefined;
  }
  // Handlers may run for seconds, and a channel turn may hold the decision until
  // its final: the row the decision was proven against must still hold at send time.
  const assertCurrent = () => {
    if (!sameRouteProof(persisted, readPersisted())) {
      throw new Error("outbound route decision is stale: persisted session route changed");
    }
  };
  assertCurrent();
  return { decision: requested, assertCurrent };
}
