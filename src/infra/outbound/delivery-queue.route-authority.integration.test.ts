// Restart recovery must recheck the host-selected physical Slack route at the real adapter.
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
      expect(readQueuedEntry(tmpDir(), id)).toMatchObject({ routeAuthority: proof });
      if (routeState === "stale") {
        await replaceSessionEntry({ sessionKey, storePath }, sessionEntry("channel:C456"));
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const platformSend = vi.fn(async () => ({ channel: "slack", messageId: "root-message" }));
      const outbound = {
        deliveryMode: "direct" as const,
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
