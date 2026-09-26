// Covers the opt-in ALERT: marker gate on plain scheduled heartbeat polls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/config.js";
import { hasHeartbeatAlertMarker, requiresHeartbeatAlertMarker } from "./heartbeat-dispatch.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  withTempHeartbeatSandbox,
  type HeartbeatReplySpy,
} from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();

const WHATSAPP_GROUP = "120363140186826074@g.us";
const MARKER_PROMPT =
  "Check the running work. Reply NO_REPLY when nothing needs attention; start the reply with ALERT: when the user must be interrupted.";
const UNMARKED_PROSE = "All sessions are in done status, no stalled work.";
const MARKED_ALERT = "ALERT: heartbeat-main timed out three times.";

describe("heartbeat ALERT: marker gate", () => {
  afterEach(() => {
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  function createConfig(params: {
    tmpDir: string;
    storePath: string;
    prompt?: string;
    responsePrefix?: string;
    isolatedSession?: boolean;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            ...(params.isolatedSession ? { isolatedSession: true } : {}),
            ...(params.prompt ? { prompt: params.prompt } : {}),
          },
        },
      },
      ...(params.responsePrefix ? { messages: { responsePrefix: params.responsePrefix } } : {}),
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: params.storePath },
    } as OpenClawConfig;
  }

  async function runPoll(params: {
    tmpDir: string;
    storePath: string;
    replySpy: HeartbeatReplySpy;
    replyText: string;
    prompt?: string;
    event?: { text: string; contextKey?: string };
    reason?: string;
    replyPayload?: Record<string, unknown>;
    intent?: "immediate" | "scheduled";
    responsePrefix?: string;
    isolatedSession?: boolean;
    toolErrorWarning?: boolean;
  }) {
    const cfg = createConfig(params);
    const sessionKey = await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: WHATSAPP_GROUP,
    });
    if (params.event) {
      enqueueSystemEvent(params.event.text, {
        sessionKey,
        ...(params.event.contextKey ? { contextKey: params.event.contextKey } : {}),
      });
    }
    const reply = { text: params.replyText, ...params.replyPayload };
    params.replySpy.mockResolvedValue(
      params.toolErrorWarning
        ? setReplyPayloadMetadata(reply, { toolErrorWarning: { toolName: "read" } })
        : reply,
    );
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
    await runHeartbeatOnce({
      cfg,
      ...(params.reason ? { reason: params.reason } : {}),
      intent: params.intent ?? "scheduled",
      deps: {
        whatsapp: sendWhatsApp as unknown,
        getQueueSize: () => 0,
        nowMs: () => 0,
        webAuthExists: async () => true,
        hasActiveWebListener: () => true,
        getReplyFromConfig: params.replySpy,
      } satisfies HeartbeatDeps,
    });
    return { sendWhatsApp, sessionKey };
  }

  it("recognises the marker past a response prefix or markdown decoration", () => {
    expect(hasHeartbeatAlertMarker("ALERT: gateway down")).toBe(true);
    expect(hasHeartbeatAlertMarker("  *Alert:* job failed")).toBe(true);
    expect(hasHeartbeatAlertMarker("[talos] ALERT: x", "[talos]")).toBe(true);
    expect(hasHeartbeatAlertMarker("[bot]  ALERT: x", " [bot] ")).toBe(true);
    expect(hasHeartbeatAlertMarker("+ ALERT: service down")).toBe(true);
    expect(hasHeartbeatAlertMarker("1. ALERT: service down")).toBe(true);
    expect(hasHeartbeatAlertMarker("- [ ] ALERT: disk full")).toBe(true);
    expect(hasHeartbeatAlertMarker("1. [x] ALERT: backup failed")).toBe(true);
    expect(hasHeartbeatAlertMarker("All sessions are fine, no alerts.")).toBe(false);
    expect(hasHeartbeatAlertMarker("Nothing to report; no ALERT: raised.")).toBe(false);
  });

  it("keeps unmarked prose silent when the configured prompt names the marker", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: UNMARKED_PROSE,
        prompt: MARKER_PROMPT,
      });
      expect(sendWhatsApp).not.toHaveBeenCalled();
      const event = getLastHeartbeatEvent();
      expect(event?.status).toBe("ok-token");
      expect(event?.silent).toBe(true);
      expect(event?.preview).toContain("All sessions are in done status");
    });
  });

  it("keeps an isolated scheduled poll quiet despite an unrelated base-session event", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp, sessionKey } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: UNMARKED_PROSE,
        prompt: MARKER_PROMPT,
        isolatedSession: true,
        event: { text: "Unrelated base-session notification" },
      });
      expect(sendWhatsApp).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({ status: "ok-token", silent: true });
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
    });
  });

  it("delivers a synthesized read-tool warning without an alert marker", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const warning = "⚠️ read failed: file unavailable";
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: warning,
        replyPayload: { isError: true },
        toolErrorWarning: true,
        prompt: MARKER_PROMPT,
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp.mock.calls[0]?.[1]).toContain(warning);
      expect(getLastHeartbeatEvent()?.status).toBe("sent");
    });
  });

  it("delivers an unmarked error payload without a tool warning tag", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: "⚠️ model call failed",
        replyPayload: { isError: true },
        prompt: MARKER_PROMPT,
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    });
  });

  it("delivers a marked alert behind a whitespace-padded response prefix", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: MARKED_ALERT,
        prompt: MARKER_PROMPT,
        responsePrefix: " [bot] ",
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp.mock.calls[0]?.[1]).toContain(MARKED_ALERT);
    });
  });

  it.each([
    "+ ALERT: service down",
    "1. ALERT: service down",
    "- [ ] ALERT: disk full",
    "1. [x] ALERT: backup failed",
  ])("delivers markdown list alert %s from a scheduled poll", async (replyText) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText,
        prompt: MARKER_PROMPT,
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp.mock.calls[0]?.[1]).toContain(replyText);
    });
  });

  it("delivers a marked alert when the configured prompt names the marker", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: MARKED_ALERT,
        prompt: MARKER_PROMPT,
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp.mock.calls[0]?.[1]).toContain(MARKED_ALERT);
      expect(getLastHeartbeatEvent()?.status).toBe("sent");
    });
  });

  it("does not gate explicitly requested immediate runs", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: UNMARKED_PROSE,
        prompt: MARKER_PROMPT,
        intent: "immediate",
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    });
  });

  it("delivers unmarked prose when the configured prompt omits the marker", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: UNMARKED_PROSE,
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp.mock.calls[0]?.[1]).toContain(UNMARKED_PROSE);
      expect(getLastHeartbeatEvent()?.status).toBe("sent");
    });
  });

  it("gates only plain polls: relays, task continuations and scheduled tasks stay ungated", () => {
    const plain = {
      hasExecCompletion: false,
      hasCronEvents: false,
      hasTaskContinuation: false,
      inspectsRunQueue: true,
      genericEvents: [],
      configuredPromptOptsIntoAlertMarker: true,
    };
    const gated = (
      prepared: Parameters<typeof requiresHeartbeatAlertMarker>[0],
      tasks: Parameters<typeof requiresHeartbeatAlertMarker>[1] = [],
      intent: Parameters<typeof requiresHeartbeatAlertMarker>[2] = "scheduled",
    ) => requiresHeartbeatAlertMarker(prepared, tasks, intent);
    expect(gated(plain)).toBe(true);
    expect(requiresHeartbeatAlertMarker(plain, [], undefined)).toBe(false);
    expect(gated({ ...plain, hasTaskContinuation: true })).toBe(false);
    expect(gated({ ...plain, hasExecCompletion: true })).toBe(false);
    expect(gated({ ...plain, hasCronEvents: true })).toBe(false);
    expect(
      gated({
        ...plain,
        inspectsRunQueue: false,
        genericEvents: [{ text: "Uninspected base event" }] as never,
      }),
    ).toBe(true);
    // A pending generic system event (for example an explicit "other" wake asking
    // to report an overdue delivery) is a relay, never a plain poll.
    expect(
      gated({
        ...plain,
        genericEvents: [{ text: "Reef: delivery overdue", contextKey: "reef:overdue" }] as never,
      }),
    ).toBe(false);
    for (const intent of ["immediate", "event", "task", "manual"] as const) {
      expect(gated(plain, [], intent)).toBe(false);
    }
    expect(gated(plain, [{ name: "rotate", prompt: "rotate logs" }] as never)).toBe(false);
    expect(gated({ ...plain, configuredPromptOptsIntoAlertMarker: false })).toBe(false);
  });

  it("delivers unmarked text that carries structured content even when the prompt names the marker", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: UNMARKED_PROSE,
        prompt: MARKER_PROMPT,
        replyPayload: {
          presentation: { blocks: [{ type: "text", text: "Queue: 3 running, 0 stalled." }] },
        },
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    });
  });

  it("delivers an unmarked cron relay even when the prompt names the marker", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: "Reminder handled: the overnight report is ready.",
        prompt: MARKER_PROMPT,
        event: { text: "Reminder: Overnight report", contextKey: "cron:overnight-report" },
        reason: "cron:pending",
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp.mock.calls[0]?.[1]).toContain("overnight report is ready");
    });
  });

  it("delivers an unmarked exec relay even when the prompt names the marker", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { sendWhatsApp } = await runPoll({
        tmpDir,
        storePath,
        replySpy,
        replyText: "Command completed and uploaded report.txt.",
        prompt: MARKER_PROMPT,
        event: {
          text: "Exec completed (heartbeat-test, code 0) :: uploaded report.txt",
          contextKey: "exec:heartbeat-test",
        },
        reason: "exec-event",
      });
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp.mock.calls[0]?.[1]).toContain("uploaded report.txt");
    });
  });
});
