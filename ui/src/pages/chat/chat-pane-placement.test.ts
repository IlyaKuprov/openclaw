/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat pane placement", () => {
  it("reclaims an active placement through the existing sessions.reclaim flow", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const request = vi.fn(async () => ({ ok: true }));
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.reclaim"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as never;
    const session = {
      key: "agent:main:cloud",
      kind: "direct",
      updatedAt: 0,
      placement: {
        state: "active",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: "worker:one",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/repo",
      },
    } satisfies GatewaySessionRow;

    await pane.reclaimHeaderPlacement(session);

    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: session.key, agentId: "main" },
      { timeoutMs: 10 * 60_000 },
    );
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });
});
