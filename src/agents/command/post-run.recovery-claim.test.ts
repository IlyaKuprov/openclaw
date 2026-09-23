// HF-19: the restart-recovery claim is cleared by ownership and retained only
// when the finishing run ended because the process is restarting, whether that
// restart arrived on the abort signal or as the thrown terminal error.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import type { persistAgentSession } from "./attempt-execution.shared.js";

const persistMock = vi.hoisted(() => vi.fn());
vi.mock("./attempt-execution.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attempt-execution.shared.js")>()),
  persistAgentSession: persistMock,
}));

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
    claim: { tracked: true, ...claim },
  });
  return sessionStore;
}

describe("clearCommandRecoveryClaim", () => {
  beforeEach(() => {
    persistMock.mockReset();
    persistMock.mockImplementation(async (params: Parameters<typeof persistAgentSession>[0]) => {
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
});
