import { describe, expect, it } from "vitest";
import { getRestartRecoveryTerminalDeliveryEvidence } from "../config/sessions/restart-recovery-state.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  buildRestartRecoveryTerminalDeliveryEvidence,
  captureRestartRecoveryCleanupMarker,
  constrainRestartRecoveryDeliveryPayloads,
  shouldPersistRestartRecoveryCleanup,
} from "./agent-command-restart-recovery.js";
import { hasMessagingToolDeliveryToSource } from "./subagents/announce/subagent-announce-completion-delivery.js";

describe("buildCurrentRunRestartRecoveryClaim", () => {
  it("persists the complete generated-media policy, including an empty allowlist", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        deliveryMediaUrls: [],
        disableMessageTool: true,
        entry: { sessionId: "session-1", updatedAt: 1 },
        forceRestartSafeTools: true,
        runId: "media-run",
        sourceIngress: "internal",
        sourceRunId: "media-run",
        sourceReplyDeliveryMode: "automatic",
        suppressTextDelivery: true,
      }),
    ).toEqual({
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryMediaUrls: [],
      restartRecoveryDisableMessageTool: true,
      restartRecoveryDeliveryRunId: "media-run",
      restartRecoveryDeliverySourceRunId: "media-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "automatic",
      restartRecoveryForceSafeTools: true,
      restartRecoverySuppressTextDelivery: true,
    });
  });

  it("preserves a preclaimed recovery policy", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        entry: {
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "channel:123",
            accountId: "main",
            threadId: "42",
          },
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliverySourceRunId: "media-run",
          restartRecoveryDeliveryMediaUrls: ["/tmp/proof.png"],
          restartRecoveryDisableMessageTool: true,
          restartRecoverySourceIngress: "internal",
          restartRecoverySourceReplyDeliveryMode: "automatic",
          restartRecoveryForceSafeTools: true,
          restartRecoverySuppressTextDelivery: true,
        },
        runId: "recovery-run",
      }),
    ).toEqual({
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "main",
        threadId: "42",
      },
      restartRecoveryDeliveryMediaUrls: ["/tmp/proof.png"],
      restartRecoveryDisableMessageTool: true,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "media-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "automatic",
      restartRecoveryForceSafeTools: true,
      restartRecoverySuppressTextDelivery: true,
    });
  });

  it("preserves the claimed route when delivery preparation resolves an alias", () => {
    expect(
      buildCurrentRunRestartRecoveryClaim({
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100123:topic:1",
          threadId: 1,
        },
        entry: {
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
        },
        runId: "recovery-run",
      }),
    ).toMatchObject({
      restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
      restartRecoveryDeliveryRunId: "recovery-run",
    });
  });

  it("requires explicit ownership for a new source claim", () => {
    expect(() =>
      buildCurrentRunRestartRecoveryClaim({
        entry: { sessionId: "session-1", updatedAt: 1 },
        runId: "media-run",
        sourceRunId: "media-run",
      }),
    ).toThrow("restart recovery source ownership is required for a new claim");
  });
});

describe("constrainRestartRecoveryDeliveryPayloads", () => {
  it("replaces model media with the exact host-owned set", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [
          {
            text: "ready",
            mediaUrl: "/tmp/old.png",
            mediaUrls: ["/tmp/old-2.png"],
            trustedLocalMedia: true,
            audioAsVoice: true,
            ...({ attachments: [{ url: "/tmp/nested-old.png" }] } as Record<string, unknown>),
          },
        ],
        [" /tmp/missing.png ", "/tmp/missing.png"],
      ),
    ).toEqual([
      {
        text: "ready",
        mediaUrl: "/tmp/missing.png",
        mediaUrls: ["/tmp/missing.png"],
        trustedLocalMedia: true,
      },
    ]);
  });

  it("attaches host-owned media to the first visible reply after reasoning", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [
          { text: "thinking", isReasoning: true, mediaUrls: ["/tmp/model-reasoning.png"] },
          { text: "ready", mediaUrls: ["/tmp/model-selected.png"] },
        ],
        [" /tmp/missing.png ", "/tmp/missing.png"],
      ),
    ).toEqual([
      { text: "thinking", isReasoning: true },
      {
        text: "ready",
        mediaUrl: "/tmp/missing.png",
        mediaUrls: ["/tmp/missing.png"],
        trustedLocalMedia: true,
      },
    ]);
  });

  it("does not attach host-owned media to commentary, notices, or errors", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [
          { text: "commentary", isCommentary: true },
          { text: "status", isStatusNotice: true },
          { text: "failed attempt", isError: true },
          { text: "ready" },
        ],
        ["/tmp/missing.png"],
      ),
    ).toEqual([
      { text: "commentary", isCommentary: true },
      { text: "status", isStatusNotice: true },
      { text: "failed attempt", isError: true },
      {
        text: "ready",
        mediaUrl: "/tmp/missing.png",
        mediaUrls: ["/tmp/missing.png"],
        trustedLocalMedia: true,
      },
    ]);
  });

  it("keeps host-owned media separate when no visible successful reply exists", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [{ text: "failed attempt", isError: true }],
        ["/tmp/missing.png"],
      ),
    ).toEqual([
      { text: "failed attempt", isError: true },
      { mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true },
    ]);
  });

  it("strips all model media from a text-only notice", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [{ text: "failed", mediaUrls: ["/tmp/unrelated.png"], sensitiveMedia: true }],
        [],
      ),
    ).toEqual([{ text: "failed" }]);
  });

  it("suppresses model text on a media-only repair attempt", () => {
    expect(
      constrainRestartRecoveryDeliveryPayloads(
        [{ text: "caption already sent", mediaUrls: ["/tmp/old.png"] }],
        ["/tmp/missing.png"],
        true,
      ),
    ).toEqual([{ mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true }]);
  });
});

describe("buildRestartRecoveryTerminalDeliveryEvidence", () => {
  it.each([false, true])(
    "retains the source final marker %s through durable projection",
    (sourceReplyFinal) => {
      const original = {
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:123",
            text: "reply",
            sourceReplyFinal,
          },
        ],
      };
      const stored = getRestartRecoveryTerminalDeliveryEvidence(
        {
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryTerminalDeliveryEvidence: [
            { runId: "original", ...buildRestartRecoveryTerminalDeliveryEvidence(original) },
          ],
        },
        "original",
      );
      expect(stored?.messagingToolSentTargets?.[0]?.sourceReplyFinal).toBe(sourceReplyFinal);
      expect(
        hasMessagingToolDeliveryToSource(
          stored!,
          { channel: "discord", to: "channel:123" },
          { requireFinalReply: true },
        ),
      ).toBe(sourceReplyFinal);
    },
  );

  it.each([0, 1, undefined])(
    "preserves automatic result count %s without manufacturing a send",
    (resultCount) => {
      const stored = getRestartRecoveryTerminalDeliveryEvidence(
        {
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryTerminalDeliveryEvidence: [
            {
              runId: "original",
              ...buildRestartRecoveryTerminalDeliveryEvidence({
                deliveryStatus: { status: "sent", resultCount },
              }),
            },
          ],
        },
        "original",
      );
      expect(stored?.deliveryStatus?.resultCount).toBe(resultCount);
    },
  );

  it("marks an empty terminal result as captured", () => {
    expect(buildRestartRecoveryTerminalDeliveryEvidence({})).toEqual({ captured: true });
  });

  it("marks bounded messaging-tool target evidence as truncated", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      messagingToolSentTargets: Array.from({ length: 65 }, (_, index) => ({
        provider: "discord",
        to: `channel:${index}`,
        text: "sent",
      })),
    });

    expect(evidence?.messagingToolSentTargets).toHaveLength(64);
    expect(evidence?.messagingToolSentTargetsTruncated).toBe(true);
  });

  it("does not mark reasoning payloads as visible terminal replies", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ isReasoning: true, mediaUrls: ["/tmp/private.png"] }],
    });

    expect(evidence?.payloads).toEqual([{ mediaUrls: ["/tmp/private.png"], visible: false }]);
  });

  it("preserves explicit hidden-payload visibility", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      payloads: [{ visible: false, mediaUrls: ["/tmp/private.png"] }],
    });

    expect(evidence?.payloads).toEqual([{ mediaUrls: ["/tmp/private.png"], visible: false }]);
  });

  it("retains aggregate-only messaging-tool delivery as ambiguous evidence", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/proof.png"],
    });

    expect(evidence).toEqual({
      captured: true,
      messagingToolAggregateEvidenceUnaccounted: true,
      restartUnsafeSideEffectsDetected: true,
    });
  });

  it("retains mixed unaccounted aggregate delivery as ambiguous evidence", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      messagingToolSentTargets: [
        { provider: "discord", to: "channel:123", mediaUrls: ["/tmp/one.png"] },
      ],
    });

    expect(evidence?.messagingToolAggregateEvidenceUnaccounted).toBe(true);
    expect(evidence?.messagingToolSentTargets).toEqual([
      {
        provider: "discord",
        to: "channel:123",
        mediaUrls: ["/tmp/one.png"],
        visible: true,
      },
    ]);
  });

  it("retains restart-unsafe committed side effects", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({ successfulCronAdds: 1 });

    expect(evidence).toEqual({ captured: true, restartUnsafeSideEffectsDetected: true });
  });

  it("preserves explicit negative messaging-target visibility", () => {
    const evidence = buildRestartRecoveryTerminalDeliveryEvidence({
      messagingToolSentTargets: [{ provider: "discord", to: "channel:123", text: "" }],
    });

    expect(evidence?.messagingToolSentTargets).toEqual([
      { provider: "discord", to: "channel:123", visible: false },
    ]);
  });
});

describe("shouldPersistRestartRecoveryCleanup", () => {
  const entry = (overrides: Partial<InternalSessionEntry>): InternalSessionEntry =>
    ({
      sessionId: "s1",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "run-1",
      ...overrides,
    }) as InternalSessionEntry;
  const marker = captureRestartRecoveryCleanupMarker(entry({}));

  it("clears the context it owns despite a stale abortedLastRun flag", () => {
    expect(
      shouldPersistRestartRecoveryCleanup(entry({ abortedLastRun: true }), "s1", "run-1", marker),
    ).toBe(true);
  });

  it("clears after an ordinary run and after a user abort", () => {
    expect(shouldPersistRestartRecoveryCleanup(entry({}), "s1", "run-1", marker)).toBe(true);
    expect(
      shouldPersistRestartRecoveryCleanup(entry({ abortedLastRun: false }), "s1", "run-1", marker),
    ).toBe(true);
  });

  it("retains a lifecycle-rotated marker even when the delivery claim still belongs to this run", () => {
    expect(
      shouldPersistRestartRecoveryCleanup(
        entry({
          abortedLastRun: true,
          restartRecoveryRuns: [{ runId: "run-1", lifecycleGeneration: "new-generation" }],
          mainRestartRecovery: { cycleId: "next-cycle", revision: 1, chargedAttempts: 0 },
        }),
        "s1",
        "run-1",
        marker,
      ),
    ).toBe(false);
  });

  it("leaves another run's context alone", () => {
    expect(
      shouldPersistRestartRecoveryCleanup(
        entry({ restartRecoveryDeliveryRunId: "run-2" }),
        "s1",
        "run-1",
        marker,
      ),
    ).toBe(false);
    expect(shouldPersistRestartRecoveryCleanup(entry({}), "s2", "run-1", marker)).toBe(false);
    expect(shouldPersistRestartRecoveryCleanup(undefined, "s1", "run-1", marker)).toBe(false);
  });
});
