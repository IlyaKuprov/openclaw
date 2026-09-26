import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  getHeartbeatWakeAbortSignal,
  requestHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import {
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler,
} from "./session-event-wake.js";

describe("heartbeat wake settlement", () => {
  let disposeHandler: (() => void) | undefined;

  afterEach(async () => {
    resetGatewayWorkAdmission();
    if (vi.isFakeTimers()) {
      disposeHandler?.();
      disposeHandler = setHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    disposeHandler?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setHandler(handler: Parameters<typeof setHeartbeatWakeHandler>[0]) {
    disposeHandler = setHeartbeatWakeHandler(handler);
  }

  it("settles ready work after installation when a later target is admitted", async () => {
    vi.useFakeTimers();
    setHandler(null);
    const settled = vi.fn();
    const wake = { source: "session-state" as const, intent: "immediate" as const };
    void requestHeartbeatAndWait({
      ...wake,
      sessionKey: "agent:main:ready",
      coalesceMs: 0,
    }).then(settled);
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    setHandler(handler);
    const later = requestHeartbeatAndWait({
      ...wake,
      sessionKey: "agent:main:later",
      coalesceMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith({ status: "ran", durationMs: 7 });
    expect(handler.mock.calls.map(([request]) => request.sessionKey)).toEqual(["agent:main:ready"]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(later).resolves.toEqual({ status: "ran", durationMs: 7 });
    expect(handler.mock.calls.map(([request]) => request.sessionKey)).toEqual([
      "agent:main:ready",
      "agent:main:later",
    ]);
  });

  it("shares one turn between the public heartbeat and session wake entry points", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    const dispose = setSessionEventWakeHandler(handler);
    const wake = {
      source: "cron" as const,
      intent: "event" as const,
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 100,
    };
    const settled = vi.fn();
    try {
      void requestHeartbeatAndWait(wake).then(settled);
      void requestSessionEventWakeAndWait(wake).then(settled);
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledTimes(2);
      expect(settled).toHaveBeenNthCalledWith(1, { status: "ran", durationMs: 7 });
      expect(settled).toHaveBeenNthCalledWith(2, { status: "ran", durationMs: 7 });
    } finally {
      dispose();
    }
  });

  it("settles every caller represented by one coalesced wake", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    setHandler(handler);
    const wake = { source: "interval" as const, intent: "scheduled" as const, reason: "interval" };
    const resultA = requestHeartbeatAndWait({ ...wake, agentId: "main", coalesceMs: 100 });
    const resultB = requestHeartbeatAndWait({ ...wake, agentId: "main", coalesceMs: 100 });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ ...wake, agentId: "main" });
    await expect(Promise.all([resultA, resultB])).resolves.toEqual([
      { status: "ran", durationMs: 7 },
      { status: "ran", durationMs: 7 },
    ]);
  });

  it("keeps an awaited cron wake pending across a retryable skip", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const result = requestHeartbeatAndWait({
      source: "cron",
      intent: "scheduled",
      reason: "interval",
      coalesceMs: 0,
    });
    const settled = vi.fn();
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ status: "ran", durationMs: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("detaches an aborted waiter without cancelling its shared wake", async () => {
    vi.useFakeTimers();
    const { promise: child, resolve: finishChild } = createDeferred();
    const handler = vi.fn(async () => {
      await child;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHandler(handler);
    const controller = new AbortController();
    const result = requestHeartbeatAndWait(
      { source: "interval", intent: "scheduled", reason: "interval", coalesceMs: 0 },
      { abortSignal: controller.signal },
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).resolves.toEqual({
      status: "failed",
      reason: "heartbeat wake cancelled",
    });

    finishChild?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("aborts the admitted turn only after its last cancellable owner expires", async () => {
    vi.useFakeTimers();
    const started = createDeferred();
    const signalAborted = createDeferred();
    let aborted = false;
    const handler = vi.fn(async () => {
      const signal = getHeartbeatWakeAbortSignal();
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          signalAborted.resolve();
        },
        { once: true },
      );
      started.resolve();
      await signalAborted.promise;
      return { status: "failed" as const, reason: "cancelled" };
    });
    setHandler(handler);
    const first = new AbortController();
    const second = new AbortController();
    const request = { source: "interval" as const, intent: "scheduled" as const, coalesceMs: 0 };
    const a = requestHeartbeatAndWait(request, {
      abortSignal: first.signal,
      cancelQueuedOnAbort: true,
    });
    const b = requestHeartbeatAndWait(request, {
      abortSignal: second.signal,
      cancelQueuedOnAbort: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    await started.promise;
    try {
      first.abort();
      await expect(a).resolves.toMatchObject({ status: "failed" });
      expect(aborted).toBe(false);
      second.abort();
      await expect(b).resolves.toMatchObject({ status: "failed" });
      expect(aborted).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      signalAborted.resolve();
    }
  });

  it("requeues a live owner once after its coalesced peer expires during a busy turn", async () => {
    vi.useFakeTimers();
    const started = createDeferred();
    const releaseBusy = createDeferred();
    let sharedSignal: AbortSignal | undefined;
    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1) {
        sharedSignal = getHeartbeatWakeAbortSignal();
        started.resolve();
        await releaseBusy.promise;
        return { status: "skipped" as const, reason: "active-run" };
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHandler(handler);
    const first = new AbortController();
    const second = new AbortController();
    const wake = { source: "interval" as const, intent: "scheduled" as const, coalesceMs: 0 };
    const expired = requestHeartbeatAndWait(wake, {
      abortSignal: first.signal,
      cancelQueuedOnAbort: true,
    });
    const live = requestHeartbeatAndWait(wake, {
      abortSignal: second.signal,
      cancelQueuedOnAbort: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    await started.promise;
    first.abort();
    await expect(expired).resolves.toMatchObject({ status: "failed" });
    expect(sharedSignal?.aborted).toBe(false);
    releaseBusy.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(live).resolves.toMatchObject({ status: "ran" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("bounds fire-and-forget coalescing while a handler is absent, including a cancellable owner", async () => {
    vi.useFakeTimers();
    setHandler(null);
    const originalIterator = Array.prototype[Symbol.iterator];
    const oversizedMembers: number[] = [];
    // oxlint-disable-next-line no-extend-native -- Instrument this test's member copies, then restore the iterator.
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value(this: unknown[]) {
        if (
          this.length > 16 &&
          this[0] &&
          typeof this[0] === "object" &&
          "settlements" in this[0] &&
          "sequence" in this[0]
        ) {
          oversizedMembers.push(this.length);
        }
        return originalIterator.call(this);
      },
    });
    try {
      const cancelled = new AbortController();
      const own = requestHeartbeatAndWait(
        { source: "interval", intent: "scheduled", agentId: "main", coalesceMs: 0 },
        { abortSignal: cancelled.signal, cancelQueuedOnAbort: true },
      );
      for (let i = 0; i < 128; i += 1) {
        requestHeartbeat({
          source: "interval",
          intent: "scheduled",
          agentId: "main",
          coalesceMs: 0,
        });
      }
      expect(oversizedMembers).toEqual([]);
      cancelled.abort();
      await expect(own).resolves.toMatchObject({ status: "failed" });
      const busy = vi.fn().mockResolvedValue({ status: "skipped", reason: "active-run" });
      setHandler(busy);
      await vi.advanceTimersByTimeAsync(250);
      expect(busy).toHaveBeenCalledOnce();
      for (let i = 0; i < 128; i += 1) {
        requestHeartbeat({
          source: "interval",
          intent: "scheduled",
          agentId: "main",
          coalesceMs: 0,
        });
      }
      expect(oversizedMembers).toEqual([]);
      const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      setHandler(handler);
      await vi.advanceTimersByTimeAsync(250);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      // oxlint-disable-next-line no-extend-native -- Restore the test-scoped iterator instrumentation.
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: originalIterator,
      });
    }
  });

  it("removes only a cancelled cron tick from a merged queued task wake", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const controller = new AbortController();
    const expired = requestHeartbeatAndWait(
      {
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:expired",
        tasks: [{ jobId: "expired", name: "expired", prompt: "Old work" }],
        coalesceMs: 100,
      },
      { abortSignal: controller.signal, cancelQueuedOnAbort: true },
    );
    const live = requestHeartbeatAndWait({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:live",
      tasks: [{ jobId: "live", name: "live", prompt: "Current work" }],
      coalesceMs: 100,
    });
    controller.abort();
    await expect(expired).resolves.toEqual({
      status: "failed",
      reason: "heartbeat wake cancelled",
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(live).resolves.toEqual({ status: "ran", durationMs: 1 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tasks: [{ jobId: "live", name: "live", prompt: "Current work" }] }),
    );
  });

  it("does not execute a cron tick cancelled while waiting for a retry", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const controller = new AbortController();
    const expired = requestHeartbeatAndWait(
      { source: "interval", intent: "scheduled", reason: "interval", coalesceMs: 0 },
      { abortSignal: controller.signal, cancelQueuedOnAbort: true },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    controller.abort();
    await expect(expired).resolves.toEqual({
      status: "failed",
      reason: "heartbeat wake cancelled",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("drops an expired cron wake selected before detached-work admission without dropping its event handoff", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const controller = new AbortController();
    const expired = requestHeartbeatAndWait(
      {
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        agentId: "main",
        scheduledEveryMs: 60_000,
        coalesceMs: 0,
      },
      { abortSignal: controller.signal, cancelQueuedOnAbort: true },
    );
    const event = requestHeartbeatAndWait({
      source: "cron",
      intent: "immediate",
      reason: "system-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await expect(expired).resolves.toEqual({
      status: "failed",
      reason: "heartbeat wake cancelled",
    });
    expect(handler).not.toHaveBeenCalled();

    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await expect(event).resolves.toMatchObject({ status: "ran" });
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual(["system-event"]);
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("scheduledEveryMs");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("resets the surviving coalesced event after a guarded retry and handler replacement", async () => {
    vi.useFakeTimers();
    const oldHandler = vi.fn().mockResolvedValueOnce({
      status: "skipped",
      reason: "not-due",
      retryAtMs: Date.now() + 30_000,
    });
    setHandler(oldHandler);
    const controller = new AbortController();
    const cancelled = requestHeartbeatAndWait(
      { source: "cron", intent: "event", reason: "old-event", agentId: "main", coalesceMs: 0 },
      { abortSignal: controller.signal, cancelQueuedOnAbort: true },
    );
    const live = requestHeartbeatAndWait({
      source: "cron",
      intent: "event",
      reason: "live-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(oldHandler).toHaveBeenCalledOnce();
    const replacement = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHandler(replacement);
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ status: "failed" });
    await vi.advanceTimersByTimeAsync(250);
    expect(replacement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "live-event" }),
    );
    await expect(live).resolves.toMatchObject({ status: "ran" });
    expect(replacement.mock.calls[0]?.[0]).not.toHaveProperty("retainedWork");
  });
});
