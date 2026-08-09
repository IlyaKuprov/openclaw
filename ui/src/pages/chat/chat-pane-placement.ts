import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { NativeGatewaysSnapshot } from "../../app/native-gateways.runtime.ts";
import { isStoppableCloudWorkerPlacement } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

function placementGatewayName(snapshot: NativeGatewaysSnapshot | null | undefined): string {
  return (
    snapshot?.gateways.find((gateway) => gateway.id === snapshot.currentId)?.name ??
    t("chat.sessionHeader.placement.gateway")
  );
}

export function resolveChatPanePlacement(params: {
  gatewaySnapshot: ApplicationGatewaySnapshot;
  gatewaysSnapshot: NativeGatewaysSnapshot | null | undefined;
  reclaiming: boolean;
  row: GatewaySessionRow | undefined;
}): { gateway: string; reclaimDisabledReason: string | undefined } {
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.admin",
  });
  const reclaimDisabledReason = params.reclaiming
    ? t("common.loading")
    : params.row?.hasActiveRun === true
      ? t("chat.sessionHeader.placement.activeRun")
      : !isStoppableCloudWorkerPlacement(params.row?.placement)
        ? t("chat.sessionHeader.placement.unavailable")
        : access.allowed
          ? undefined
          : access.reason;
  return {
    gateway: placementGatewayName(params.gatewaysSnapshot),
    reclaimDisabledReason,
  };
}

export async function reclaimChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  connectionGeneration: number;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  gatewaysSnapshot: NativeGatewaysSnapshot | null | undefined;
  reclaiming: boolean;
  row: GatewaySessionRow;
  isCurrent: (client: GatewayBrowserClient, generation: number) => boolean;
  onReclaimingChange: (reclaiming: boolean) => void;
  publishError: (error: unknown) => void;
  refreshReplacement: (agentId?: string | null) => Promise<void>;
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  if (
    !client ||
    params.reclaiming ||
    params.row.hasActiveRun === true ||
    !isStoppableCloudWorkerPlacement(params.row.placement)
  ) {
    return;
  }
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.admin",
  });
  if (!access.allowed) {
    params.publishError(access.reason);
    return;
  }
  const gateway = placementGatewayName(params.gatewaysSnapshot);
  if (!window.confirm(t("chat.sessionHeader.placement.confirm", { gateway }))) {
    return;
  }
  const agentId = parseAgentSessionKey(params.row.key)?.agentId;
  params.onReclaimingChange(true);
  try {
    await client.request(
      "sessions.reclaim",
      { key: params.row.key, ...(agentId ? { agentId } : {}) },
      { timeoutMs: 10 * 60_000 },
    );
    if (params.isCurrent(client, params.connectionGeneration)) {
      await params.refreshReplacement(agentId);
    }
  } catch (error) {
    if (params.isCurrent(client, params.connectionGeneration)) {
      params.publishError(error);
    }
  } finally {
    params.onReclaimingChange(false);
    params.requestUpdate();
  }
}
