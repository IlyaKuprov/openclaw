import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  validateOutboundRouteDecision,
  type PersistedOutboundRouteProof,
  type PluginHookOutboundRouteDecisionEvent,
  type PluginHookOutboundRouteDecisionResult,
} from "../../plugins/outbound-route-decision.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";

export type DecidedOutboundRoute = {
  decision: PluginHookOutboundRouteDecisionResult;
  assertCurrent: () => void;
};

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
  const storePath =
    params.storePath ??
    resolveSessionStorePathCore(params.cfg.session?.store, { agentId: params.agentId });
  const readPersisted = (): PersistedOutboundRouteProof | undefined => {
    // This is an exact physical-row probe, never an alias or a last-channel inference.
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
  const requested = await runner.runOutboundRouteDecision(
    params.event,
    { channelId: "slack" },
    readPersisted(),
  );
  if (!requested) {
    return undefined;
  }
  const assertCurrent = () => {
    validateOutboundRouteDecision(params.event, readPersisted(), requested);
  };
  assertCurrent();
  return { decision: requested, assertCurrent };
}
