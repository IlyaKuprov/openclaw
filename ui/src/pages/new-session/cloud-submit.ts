import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  readCloudSessionRecovery,
  type CloudSessionRecovery,
  writeCloudSessionRecovery,
  writeCloudSessionRecoveryIfAvailable,
} from "./cloud-recovery.ts";
import {
  deleteCloudDraftSession,
  deleteRecoveredCloudDraftSession,
  startCloudInitialTurn,
} from "./cloud-target.ts";

type CloudDraftAdvanceResult =
  | { status: "started"; messageId: string; messageSeq?: number }
  | { status: "send-rejected"; error: string; messageId: string }
  | { status: "cleanup-rejected"; error: string; messageId?: string }
  | { status: "dispatch-rejected"; error: string }
  | { status: "cancelled"; cleanupError?: string; recoveryPersisted: boolean }
  | { status: "interrupted" }
  | { status: "ownership-lost" };

export type CloudRecoveryRetirement = "resolved" | "interrupted";

export async function advanceCloudDraftSession(params: {
  client: Pick<GatewayBrowserClient, "request">;
  key: string;
  agentId: string;
  profileId: string;
  message: string;
  attachments?: unknown[];
  messageId: string;
  gatewayUrl: string;
  recoveryScope: string;
  recoveryPhase: CloudSessionRecovery["phase"];
  persistRecovery?: boolean;
  recovering: boolean;
  isCurrent: () => boolean;
  ownsRecovery: () => boolean;
  clearRecovery: (retirement: CloudRecoveryRetirement) => void;
  setRecoveryPhase: (phase: CloudSessionRecovery["phase"]) => void;
}): Promise<CloudDraftAdvanceResult> {
  const persistRecovery = params.persistRecovery !== false;
  const recovery = {
    sessionKey: params.key,
    messageId: params.messageId,
    message: params.message,
    attachments: params.attachments,
    profileId: params.profileId,
    agentId: params.agentId,
    gatewayUrl: params.gatewayUrl,
    recoveryScope: params.recoveryScope,
    phase: params.recoveryPhase,
  } satisfies CloudSessionRecovery;
  const existingRecovery =
    params.recovering && persistRecovery
      ? readCloudSessionRecovery(params.gatewayUrl, params.recoveryScope)
      : null;
  if (!params.isCurrent()) {
    const recoveryPersisted = persistRecovery
      ? params.recovering
        ? existingRecovery?.sessionKey === params.key
        : writeCloudSessionRecoveryIfAvailable(recovery)
      : false;
    const cleanupError = params.recovering
      ? await deleteRecoveredCloudDraftSession(params.client, params.key, params.agentId)
      : await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return {
      status: "cancelled",
      cleanupError,
      recoveryPersisted: cleanupError ? recoveryPersisted : false,
    };
  }
  const recoveryPersisted = persistRecovery
    ? params.recovering
      ? existingRecovery?.sessionKey === params.key
      : writeCloudSessionRecovery(recovery)
    : true;
  if (!params.isCurrent() || !recoveryPersisted) {
    if (params.recovering && !recoveryPersisted) {
      return {
        status: "cancelled",
        cleanupError: "cloud recovery storage is unavailable",
        recoveryPersisted: false,
      };
    }
    const cleanupError = params.recovering
      ? await deleteRecoveredCloudDraftSession(params.client, params.key, params.agentId)
      : await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "cancelled", cleanupError, recoveryPersisted };
  }

  const cloudStart = await startCloudInitialTurn(
    params.client,
    {
      key: params.key,
      agentId: params.agentId,
      profileId: params.profileId,
      message: params.message,
      attachments: params.attachments,
      messageId: params.messageId,
      recovering: params.recovering,
      retryTerminalPlacement: params.recovering && params.recoveryPhase === "sending",
    },
    params.isCurrent,
    () => {
      if (params.recoveryPhase === "sending") {
        return true;
      }
      if (!persistRecovery) {
        params.setRecoveryPhase("sending");
        return true;
      }
      const persisted = writeCloudSessionRecovery({ ...recovery, phase: "sending" });
      if (persisted) {
        params.setRecoveryPhase("sending");
      }
      return persisted;
    },
  );
  if (cloudStart.status === "cancelled") {
    const cleanupError = await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "cancelled", cleanupError, recoveryPersisted: persistRecovery };
  }
  if (cloudStart.status === "cleanup-rejected") {
    return cloudStart;
  }
  if (cloudStart.status === "send-not-started") {
    const cleanupError = await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "dispatch-rejected", error: cleanupError || cloudStart.error };
  }
  if (cloudStart.status === "send-definitive-rejected") {
    const cleanupError = await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return { status: "dispatch-rejected", error: cleanupError || cloudStart.error };
  }
  if (cloudStart.status === "session-missing") {
    params.clearRecovery("resolved");
    return { status: "dispatch-rejected", error: cloudStart.error };
  }
  if (cloudStart.status === "dispatch-rejected") {
    const cleanupError = await deleteCloudDraftSession(params.client, params.key, params.agentId);
    if (!cleanupError) {
      params.clearRecovery("resolved");
    }
    return {
      status: "dispatch-rejected",
      error: cleanupError || cloudStart.error,
    };
  }
  if (cloudStart.status === "send-rejected") {
    return cloudStart;
  }
  if (!params.ownsRecovery()) {
    // Delivery completed, so retire only this submission's recovery record.
    // The callback's expected-key guard preserves any newer owner.
    params.clearRecovery("resolved");
    return { status: "ownership-lost" };
  }
  if (!params.isCurrent()) {
    // The page recorded why its lifecycle changed before this accepted send returned.
    // Retire the delivered recovery without relabeling that interruption as a takeover.
    params.clearRecovery("interrupted");
    return { status: "interrupted" };
  }
  params.clearRecovery("resolved");
  return cloudStart;
}
