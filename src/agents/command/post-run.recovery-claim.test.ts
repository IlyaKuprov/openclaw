// HF-19: retain a claim for restart aborts and for a lifecycle marker that
// rotates after admission; ordinary failures clear the claim this run owns.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { captureRestartRecoveryCleanupMarker } from "../agent-command-restart-recovery.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import type { persistAgentSession } from "./attempt-execution.shared.js";

const persistMock = vi.hoisted(() => vi.fn());
vi.mock("./attempt-execution.shared.js", () => ({ persistAgentSession: persistMock }));

const { clearCommandRecoveryClaim } = await import("./post-run.js");

const sessionKey = "agent:main:main";
const storePath = "/tmp/post-run-recovery-claim-sessions.json";
const runId = "run-armed";

function armedEntry(): SessionEntry {
  return {
    sessionId: "session-armed",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: runId,
    restartRecoveryContext: { channel: "slack", to: "channel:C1" },
  } as unknown as SessionEntry;
}

async function clearWith(claim: { abortSignal?: AbortSignal; terminalError?: unknown }) {
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: armedEntry() };
  await clearCommandRecoveryClaim({
    prepared: { sessionStore, sessionKey, storePath, runId } as never,
    sessionEntry: sessionStore[sessionKey],
    runOwnedSessionId: "session-armed",
    sessionReboundDuringRun: false,
    claim: { tracked: true, marker: captureRestartRecoveryCleanupMarker(armedEntry()), ...claim },
  });
  return sessionStore;
}

describe("clearCommandRecoveryClaim", () => {
  beforeEach(() => {
    persistMock.mockReset();
    persistMock.mockImplementation(async (params: Parameters<typeof persistAgentSession>[0]) => {
      if (params.shouldPersist?.(params.sessionStore[params.sessionKey]) === false) {
        return params.sessionStore[params.sessionKey];
      }
      params.sessionStore[params.sessionKey] = params.entry;
      return params.entry;
    });
  });

  it("clears the claim after an ordinary failure", async () => {
    await clearWith({ terminalError: new Error("provider exploded") });
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("retains the claim when the restart arrived on the abort signal", async () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());
    const store = await clearWith({ abortSignal: controller.signal });
    expect(persistMock).not.toHaveBeenCalled();
    expect(store[sessionKey]?.restartRecoveryDeliveryRunId).toBe(runId);
  });

  it("retains the claim when a deferred lifecycle restart was thrown instead", async () => {
    const store = await clearWith({ terminalError: createAgentRunRestartAbortError() });
    expect(persistMock).not.toHaveBeenCalled();
    expect(store[sessionKey]?.restartRecoveryDeliveryRunId).toBe(runId);
  });

  it("preserves a newly marked cycle when the restart wins without aborting this command", async () => {
    const initial = armedEntry();
    const nextCycle = {
      ...initial,
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId, lifecycleGeneration: "next-generation" }],
      mainRestartRecovery: { cycleId: "next-cycle", revision: 1, chargedAttempts: 0 },
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: nextCycle };
    await clearCommandRecoveryClaim({
      prepared: { sessionStore, sessionKey, storePath, runId } as never,
      sessionEntry: initial,
      runOwnedSessionId: initial.sessionId,
      sessionReboundDuringRun: false,
      claim: { tracked: true, marker: captureRestartRecoveryCleanupMarker(initial) },
    });

    expect(sessionStore[sessionKey]).toEqual(nextCycle);
  });
});
