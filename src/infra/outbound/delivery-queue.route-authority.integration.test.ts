// Restart recovery must recheck the host-selected physical Slack route at the real adapter.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateSlackSessionRoutePeer } from "../../../extensions/slack/src/outbound-route-peer.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("queued Slack root route recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    closeOpenClawAgentDatabasesForTest();
  });

  it.each(["stale", "current"] as const)(
    "%s persisted route reaches the actual adapter only with authority after restart",
    async (routeState) => {
      const sessionKey = "agent:main:slack:channel:c123";
      const storePath = path.join(tmpDir(), "route-sessions.json");
      const to = "channel:C123";
      const proof = {
        agentId: "main",
        storePath,
        sessionKey,
        channel: "slack" as const,
        to,
        accountId: "work",
      };
      const sessionEntry = (target: string) => ({
        sessionId: "routed-session",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: { channel: "slack", to: target, accountId: "work" },
        }),
      });
      await replaceSessionEntry({ sessionKey, storePath }, sessionEntry(to));
      const id = `root-recovery-${routeState}`;
      await enqueueDeliveryOnce(
        {
          channel: "slack",
          to,
          accountId: "work",
          routeAuthority: proof,
          payloads: [{ text: "root reply" }],
          queuePolicy: "required",
        },
        id,
        tmpDir(),
      );
      expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
        routeAuthority: proof,
        // v2026.9.5 tests this shipped settlement field before reaching its
        // route-oblivious send path. Current recovery must ignore only this fence.
        settlement: {
          outcome: "failed",
          routeAuthorityRecoveryRequired: true,
        },
      });
      if (routeState === "stale") {
        // Snapshot of the shipped v2026.9.5 recovery gate at ec9c1a13.
        // Shallow CI clones may not contain that commit; verify it when present.
        const shippedGate = `  if (entry.settlement) {
    await settleQueuedFailure({ ...opts, error: entry.settlement.error }, stateContext);
    return "continue";
  }`;
        let oldRecovery: string | undefined;
        try {
          oldRecovery = execFileSync(
            "git",
            [
              "show",
              "ec9c1a13db8938e5a3eaa51fca2e981cde2395a9:src/infra/outbound/delivery-queue-recovery.ts",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          );
        } catch {
          // The checked-in shipped-source excerpt still documents the old gate.
        }
        if (oldRecovery) {
          expect(oldRecovery).toContain(shippedGate);
          expect(oldRecovery.indexOf(shippedGate)).toBeLessThan(
            oldRecovery.indexOf("const result = await drainQueuedEntry("),
          );
        }
      }
      if (routeState === "stale") {
        await replaceSessionEntry({ sessionKey, storePath }, sessionEntry("channel:C456"));
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const platformSend = vi.fn(async () => ({ channel: "slack", messageId: "root-message" }));
      const outbound = {
        deliveryMode: "direct" as const,
        validateSessionRoutePeer: validateSlackSessionRoutePeer,
        sendText: async (ctx: { onPlatformSendDispatch?: () => Promise<void> }) => {
          await ctx.onPlatformSendDispatch?.();
          return platformSend();
        },
        sendMedia: async (ctx: { onPlatformSendDispatch?: () => Promise<void> }) => {
          await ctx.onPlatformSendDispatch?.();
          return platformSend();
        },
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "slack",
            source: "test",
            plugin: createOutboundTestPlugin({ id: "slack", outbound }),
          },
        ]),
      );
      process.env.OPENCLAW_STATE_DIR = tmpDir();
      const summary = await recoverPendingDeliveries({
        cfg: {} as OpenClawConfig,
        deliver: (params) => deliverOutboundPayloads(params),
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      });
      expect(platformSend).toHaveBeenCalledTimes(routeState === "stale" ? 0 : 1);
      expect(summary.recovered).toBe(routeState === "stale" ? 0 : 1);
    },
  );
});
