import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
// Archive-owned cancellation and authoritative lifecycle drains.
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunInProgress,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent-runner/runs.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import {
  abortReplyRunBySessionId,
  isReplyRunActiveForSessionId,
  replyRunRegistry,
  waitForReplyRunEndBySessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import {
  interruptSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import type { WorkerInferenceSessionDrain } from "../worker-environments/inference.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  createChatAbortOps,
  hasGatewaySessionAbortOwner,
} from "./chat-abort-runtime.js";
import type { GatewayRequestContext } from "./types.js";

type SessionArchiveLifecycleParams = {
  context: GatewayRequestContext;
  storePath: string;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId: string;
  lifecycleIdentities: string[];
};

export type SessionArchiveLifecycleDrain = {
  release(): void;
  hasAuthoritativeWork(): boolean;
};

function hasAuthoritativeSessionWork(
  params: SessionArchiveLifecycleParams,
  workerDrain: WorkerInferenceSessionDrain | undefined,
  workIdentities: string[],
): boolean {
  const sessionId = params.sessionId;
  return (
    isCompetingSessionWorkAdmissionActive(params.storePath, params.lifecycleIdentities) ||
    params.sessionKeys.some((key) => replyRunRegistry.isActive(key)) ||
    Boolean(sessionId && isReplyRunActiveForSessionId(sessionId)) ||
    Boolean(sessionId && isEmbeddedAgentRunInProgress(sessionId)) ||
    hasPendingFollowupQueueWork(workIdentities) ||
    workIdentities.some(
      (key) => getCommandLaneSnapshot(resolveEmbeddedSessionLane(key)).queuedCount > 0,
    ) ||
    hasGatewaySessionAbortOwner({
      context: params.context,
      sessionKeys: params.sessionKeys,
      sessionId,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
    }) ||
    Boolean(
      sessionId &&
      params.context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId)?.turnClaim,
    ) ||
    workerDrain?.hasWork() === true
  );
}

/** Fence is already active when this starts; retain the returned runtime fence through commit. */
export async function prepareSessionArchiveLifecycle(
  params: SessionArchiveLifecycleParams,
): Promise<SessionArchiveLifecycleDrain> {
  const timeoutMs = SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS;
  const workIdentities = Array.from(
    new Set([...params.sessionKeys, ...(params.sessionId ? [params.sessionId] : [])]),
  );
  const workerControl = asWorkerInferenceControl(params.context.workerEnvironmentService);
  let workerDrain: WorkerInferenceSessionDrain | undefined;
  if (params.sessionId && workerControl?.beginInferenceSessionDrain) {
    workerDrain = workerControl.beginInferenceSessionDrain(params.sessionId);
  } else if (params.sessionId && workerControl?.hasInferenceForSession(params.sessionId) === true) {
    throw new Error("Worker inference drain is unavailable");
  }

  try {
    let controllerDrain = Promise.resolve(true);
    const abortResult = await abortChatRunsForSessionKeyWithPartials({
      context: params.context,
      ops: createChatAbortOps(params.context),
      sessionKey: params.sessionKeys[0]!,
      sessionKeyAliases: params.sessionKeys.slice(1),
      sessionId: params.sessionId,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      abortOrigin: "rpc",
      stopReason: "archive",
      requester: { isAdmin: true },
      includeProtectedRuns: true,
      onControllerTargets: (targets) => {
        controllerDrain = waitForChatAbortControllerRemoval({
          entries: params.context.chatAbortControllers,
          targets,
          timeoutMs,
        });
      },
      onAuthorizedAfterQueuedAbort: () => {
        const cleared = clearSessionQueues(workIdentities);
        let aborted = cleared.followupCleared > 0 || cleared.laneCleared > 0;
        for (const key of params.sessionKeys) {
          aborted = replyRunRegistry.abort(key) || aborted;
        }
        if (params.sessionId) {
          aborted = abortReplyRunBySessionId(params.sessionId) || aborted;
          aborted = abortEmbeddedAgentRun(params.sessionId) || aborted;
        }
        return aborted;
      },
    });
    if (abortResult.unauthorized) {
      throw new Error("Archive cancellation lost session ownership");
    }

    const admittedWork = interruptSessionWorkAdmissions({
      scope: params.storePath,
      identities: params.lifecycleIdentities,
      timeoutMs,
    });
    const replyWork = Promise.all([
      ...params.sessionKeys.map((key) => replyRunRegistry.waitForIdle(key, timeoutMs)),
      ...(params.sessionId ? [waitForReplyRunEndBySessionId(params.sessionId, timeoutMs)] : []),
    ]).then((results) => results.every(Boolean));
    const embeddedWork = params.sessionId
      ? waitForEmbeddedAgentRunEnd(params.sessionId, timeoutMs)
      : Promise.resolve(true);
    const placement = params.sessionId
      ? params.context.workerSessionPlacementService
          ?.getMany([params.sessionId])
          .get(params.sessionId)
      : undefined;
    const placementWork = placement?.turnClaim
      ? params.context.workerSessionPlacementService?.waitForTurnClaimRelease
        ? params.context.workerSessionPlacementService
            .waitForTurnClaimRelease(params.sessionId!, { timeoutMs })
            .then(() => true)
        : Promise.resolve(false)
      : Promise.resolve(true);
    const workerWork = workerDrain
      ? withTimeout(workerDrain.drained, timeoutMs, "worker inference archive drain").then(
          () => true,
        )
      : Promise.resolve(true);
    const drains = await Promise.all([
      controllerDrain,
      admittedWork,
      replyWork,
      embeddedWork,
      placementWork,
      workerWork,
    ]);
    if (!drains.every(Boolean)) {
      throw new Error("Session work did not fully drain before archive");
    }
    return {
      release: () => workerDrain?.release(),
      hasAuthoritativeWork: () => hasAuthoritativeSessionWork(params, workerDrain, workIdentities),
    };
  } catch (error) {
    workerDrain?.release();
    throw error;
  }
}
