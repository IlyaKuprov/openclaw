import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { HEARTBEAT_ALERT_MARKER, resolveHeartbeatRunPrompt } from "./heartbeat-runner-prompt.js";

type ResolveParams = Parameters<typeof resolveHeartbeatRunPrompt>[0];

const PLAIN_PREFLIGHT = {
  pendingEventEntries: [],
  shouldInspectPendingEvents: false,
  isCronWake: false,
  session: { inspectsRunQueue: false },
} as unknown as ResolveParams["preflight"];

function resolve(params: {
  prompt?: string;
  heartbeatScratchContent?: string;
  scheduledTasks?: ResolveParams["scheduledTasks"];
}) {
  const cfg = {
    agents: {
      defaults: {
        heartbeat: {
          every: "5m",
          ...(params.prompt ? { prompt: params.prompt } : {}),
        },
      },
    },
  } as OpenClawConfig;
  return resolveHeartbeatRunPrompt({
    cfg,
    heartbeat: cfg.agents?.defaults?.heartbeat,
    preflight: PLAIN_PREFLIGHT,
    canRelayToUser: true,
    startedAt: Date.now(),
    scheduledTasks: params.scheduledTasks ?? [],
    heartbeatScratchContent: params.heartbeatScratchContent,
    useHeartbeatResponseTool: false,
  });
}

describe("heartbeat alert-marker opt-in comes from the configured prompt only", () => {
  it.each([HEARTBEAT_ALERT_MARKER, "Alert:", "alert:"])(
    "opts in when the configured prompt names %s",
    (marker) => {
      const resolution = resolve({
        prompt: `Check the sessions. Reply NO_REPLY unless something needs ${marker}`,
      });
      expect(resolution.configuredPromptOptsIntoAlertMarker).toBe(true);
    },
  );

  it("does not opt in when only the appended monitor scratch names the marker", () => {
    const resolution = resolve({
      prompt: "Check the sessions and reply NO_REPLY when nothing needs attention.",
      heartbeatScratchContent: `Escalate with ${HEARTBEAT_ALERT_MARKER} when a job is stuck.`,
    });
    expect(resolution.prompt).toContain(HEARTBEAT_ALERT_MARKER);
    expect(resolution.configuredPromptOptsIntoAlertMarker).toBe(false);
  });

  it("does not opt in for the stock prompt", () => {
    expect(resolve({}).configuredPromptOptsIntoAlertMarker).toBe(false);
  });

  it("never opts in on the scheduled-task branch", () => {
    const resolution = resolve({
      prompt: `Poll. ${HEARTBEAT_ALERT_MARKER} only on trouble.`,
      scheduledTasks: [
        { name: "rotate logs", interval: "1h" },
      ] as unknown as ResolveParams["scheduledTasks"],
    });
    expect(resolution.configuredPromptOptsIntoAlertMarker).toBe(false);
  });
});
