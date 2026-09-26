// Integration regressions for cron-owned heartbeat watchdog handoffs.
import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatRunResult,
} from "../../infra/heartbeat-wake.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import type { CronServiceDeps } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const heartbeatWatchdogFixtures = setupCronRegressionFixtures({
  prefix: "cron-heartbeat-watchdog-",
});

function requireJob(state: { store?: { jobs?: CronJob[] } | null }, id: string): CronJob {
  const job = state.store?.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
}

describe("cron heartbeat watchdog", () => {
  it("cancels its queued monitor wake when the cron watchdog expires", async () => {
    vi.useFakeTimers();
    setHeartbeatWakeHandler(null);
    try {
      const store = heartbeatWatchdogFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-09-02T12:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "expired-monitor",
        name: "expired monitor",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 },
        payload: { kind: "heartbeat" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.sessionTarget = "main";
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });
      vi.setSystemTime(scheduledAt);
      const queued = createDeferred();
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => Date.now(),
        defaultAgentId: "main",
        resolveHeartbeatTimeoutMs: () => 30 * 60_000,
        requestHeartbeatAndWait: (wake, lifecycle) => {
          const result = requestHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle);
          queued.resolve();
          return result;
        },
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const timerPromise = onTimer(state);
      await queued.promise;
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      await timerPromise;
      expect(requireJob(state, cronJob.id).state.lastError).toContain("timed out");

      const handler = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
      setHeartbeatWakeHandler(handler);
      await vi.advanceTimersByTimeAsync(250);
      expect(handler).not.toHaveBeenCalled();
      const live = requestHeartbeatAndWait({
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        agentId: "main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(live).resolves.toMatchObject({ status: "ran" });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      setHeartbeatWakeHandler(null);
      vi.useRealTimers();
    }
  });

  it("keeps the immediate event and its handoff alive behind a long queued turn", async () => {
    vi.useFakeTimers();
    const releaseBlocker = createDeferred();
    const blockerStarted = createDeferred();
    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1) {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    try {
      const scheduledAt = Date.parse("2026-09-02T12:00:00.000Z");
      vi.setSystemTime(scheduledAt);
      const blocker = requestHeartbeatAndWait({
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        agentId: "main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      await blockerStarted.promise;
      const store = heartbeatWatchdogFixtures.makeStorePath();
      const cronJob = createIsolatedRegressionJob({
        id: "immediate-event-handoff",
        name: "immediate event handoff",
        scheduledAt,
        schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        payload: { kind: "systemEvent", text: "Keep this event" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.sessionTarget = "main";
      cronJob.wakeMode = "now";
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });
      const eventQueued = createDeferred();
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => Date.now(),
        defaultAgentId: "main",
        enqueueSystemEvent: (text, opts) => {
          const remove = enqueueSystemEventWithReceipt(text, {
            sessionKey: "agent:main:main",
            contextKey: opts?.contextKey,
          });
          eventQueued.resolve();
          return remove ? { accepted: true, remove } : { accepted: false };
        },
        resolveHeartbeatTimeoutMs: () => 15 * 60_000,
        requestHeartbeatAndWait: (wake, lifecycle) =>
          requestHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const timerPromise = onTimer(state);
      await eventQueued.promise;
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      expect(peekSystemEventEntries("agent:main:main").map((entry) => entry.text)).toEqual([
        "Keep this event",
      ]);
      releaseBlocker.resolve();
      await blocker;
      await vi.advanceTimersByTimeAsync(0);
      await timerPromise;
      expect(requireJob(state, cronJob.id).state.lastStatus).toBe("ok");
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      releaseBlocker.resolve();
      setHeartbeatWakeHandler(null);
      resetSystemEventsForTest();
      vi.useRealTimers();
    }
  });
  it.each([
    { name: "queued", transitions: [] as { atMs: number; phase: "attempt" | "queue" }[] },
    {
      name: "requeued",
      transitions: [
        { atMs: 20 * 60_000, phase: "attempt" as const },
        { atMs: 25 * 60_000, phase: "queue" as const },
      ],
    },
  ])("times out a $name scheduled heartbeat at its original deadline", async ({ transitions }) => {
    vi.useFakeTimers();
    try {
      const store = heartbeatWatchdogFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-09-02T12:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "queued-heartbeat-deadline",
        name: "queued heartbeat deadline",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 },
        payload: { kind: "heartbeat" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.sessionTarget = "main";
      cronJob.wakeMode = "next-heartbeat";
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      const heartbeatQueued = createDeferred();
      let transition: { onQueued?: () => void; onAttemptStarted?: () => void } | undefined;
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => Date.now(),
        defaultAgentId: "main",
        resolveHeartbeatTimeoutMs: vi.fn(() => 30 * 60_000),
        requestHeartbeatAndWait: vi.fn(
          async (_wake, { onQueued, onAttemptStarted, abortSignal }) => {
            transition = { onQueued, onAttemptStarted };
            onQueued?.();
            heartbeatQueued.resolve();
            return await new Promise<HeartbeatRunResult>((resolve) => {
              abortSignal?.addEventListener(
                "abort",
                () => resolve({ status: "failed" as const, reason: "heartbeat wake cancelled" }),
                { once: true },
              );
            });
          },
        ),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const timerPromise = onTimer(state);
      await heartbeatQueued.promise;
      let elapsedMs = 0;
      for (const { atMs, phase } of transitions) {
        await vi.advanceTimersByTimeAsync(atMs - elapsedMs);
        if (phase === "attempt") {
          transition?.onAttemptStarted?.();
        } else {
          transition?.onQueued?.();
        }
        elapsedMs = atMs;
      }
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1 - elapsedMs);
      await timerPromise;
      expect(requireJob(state, cronJob.id).state.lastStatus).toBe("error");
      expect(requireJob(state, cronJob.id).state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "monitor",
      payload: { kind: "heartbeat" } as const,
      wakeMode: "next-heartbeat" as const,
    },
    {
      name: "main system event",
      payload: { kind: "systemEvent", text: "check heartbeat work" } as const,
      wakeMode: "now" as const,
    },
  ])(
    "disables the outer watchdog for an unlimited $name heartbeat",
    async ({ payload, wakeMode }) => {
      vi.useFakeTimers();
      try {
        const store = heartbeatWatchdogFixtures.makeStorePath();
        const scheduledAt = Date.parse("2026-09-02T12:20:00.000Z");
        const cronJob = createIsolatedRegressionJob({
          id: `unlimited-${payload.kind}`,
          name: `unlimited ${payload.kind}`,
          scheduledAt,
          schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
          payload,
          state: { nextRunAtMs: scheduledAt },
        });
        cronJob.sessionTarget = "main";
        cronJob.wakeMode = wakeMode;
        await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

        vi.setSystemTime(scheduledAt);
        const heartbeatStarted = createDeferred();
        const releaseHeartbeat = createDeferred();
        const runHeartbeat: NonNullable<CronServiceDeps["requestHeartbeatAndWait"]> = async (
          _wake,
          { onQueued, onAttemptStarted },
        ) => {
          onQueued?.();
          onAttemptStarted?.();
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
          return { status: "ran", durationMs: 1 };
        };
        const state = createCronRegressionState({
          storePath: store.storePath,
          nowMs: () => Date.now(),
          defaultAgentId: "main",
          resolveHeartbeatTimeoutMs: vi.fn(() => undefined),
          requestHeartbeatAndWait: vi.fn(runHeartbeat),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });

        const timerPromise = onTimer(state);
        let timerSettled = false;
        void timerPromise.then(() => {
          timerSettled = true;
        });
        await heartbeatStarted.promise;

        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(timerSettled).toBe(false);

        releaseHeartbeat.resolve();
        await timerPromise;
        expect(requireJob(state, cronJob.id).state.lastStatus).toBe("ok");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps the cron deadline while a heartbeat-backed trigger is still evaluating", async () => {
    vi.useFakeTimers();
    try {
      const store = heartbeatWatchdogFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-09-02T12:30:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "heartbeat-trigger-watchdog",
        name: "heartbeat trigger watchdog",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 },
        payload: { kind: "systemEvent", text: "check heartbeat work" },
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.sessionTarget = "main";
      cronJob.wakeMode = "now";
      cronJob.trigger = { script: "return { fire: true };" };
      await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

      vi.setSystemTime(scheduledAt);
      const triggerStarted = createDeferred();
      const resolveHeartbeatTimeoutMs = vi.fn(() => 15 * 60_000);
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => Date.now(),
        defaultAgentId: "main",
        requestHeartbeatAndWait: vi.fn(async () => ({ status: "ran" as const, durationMs: 1 })),
        resolveHeartbeatTimeoutMs,
        evaluateCronTrigger: vi.fn(async () => {
          triggerStarted.resolve();
          return await new Promise<never>(() => {});
        }),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      const timerPromise = onTimer(state);
      await triggerStarted.promise;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      await timerPromise;

      expect(resolveHeartbeatTimeoutMs).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeatAndWait).not.toHaveBeenCalled();
      expect(requireJob(state, cronJob.id).state.lastError).toContain("job execution timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
