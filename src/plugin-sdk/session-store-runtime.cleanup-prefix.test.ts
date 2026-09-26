import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { cleanupSessionLifecycleArtifacts } from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("SDK lifecycle cleanup prefix guard", () => {
  it("uses the guarded prefix for the SQLite deletion, even if its getter changes", async () => {
    const storePath = path.join(tempDirs.make("openclaw-sdk-cleanup-prefix-"), "sessions.json");
    const nowMs = Date.now();
    const ordinaryKey = "agent:main:ordinary-cleanup-old";
    const otherKey = "agent:main:unrelated-old";
    const protectedOwnerlessKey = "agent:main:internal-session-effects:ownerless";
    const protectedForeignKey = "agent:main:internal-session-effects:foreign";
    for (const [sessionKey, pluginOwnerId] of [
      [ordinaryKey, undefined],
      [otherKey, undefined],
      [protectedOwnerlessKey, undefined],
      [protectedForeignKey, "another-plugin"],
    ] as const) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: sessionKey.slice("agent:main:".length),
          updatedAt: nowMs - 600_000,
          ...(pluginOwnerId ? { pluginOwnerId } : {}),
        },
      );
    }

    let prefixReads = 0;
    const params = {
      agentId: "main",
      storePath,
      get sessionKeySegmentPrefix() {
        prefixReads += 1;
        return prefixReads === 1 ? "ordinary-cleanup-" : "internal-session-effects:";
      },
      transcriptContentMarker: "cleanup-prefix-marker",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs,
    };
    await expect(cleanupSessionLifecycleArtifacts(params)).resolves.toEqual({
      archivedTranscriptArtifacts: 0,
      removedEntries: 1,
    });
    expect(prefixReads).toBe(1);
    expect(loadSessionEntry({ sessionKey: ordinaryKey, storePath })).toBeUndefined();
    for (const sessionKey of [otherKey, protectedOwnerlessKey, protectedForeignKey]) {
      expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(
        sessionKey.slice("agent:main:".length),
      );
    }
  });

  it("rejects a protected raw prefix before any accessor call", async () => {
    const storePath = path.join(tempDirs.make("openclaw-sdk-cleanup-prefix-"), "sessions.json");
    let prefixReads = 0;
    await expect(
      cleanupSessionLifecycleArtifacts({
        agentId: "main",
        storePath,
        get sessionKeySegmentPrefix() {
          prefixReads += 1;
          return prefixReads === 1 ? " INTERNAL-SESSION-EFFECTS: " : "ordinary-cleanup-";
        },
        transcriptContentMarker: "cleanup-prefix-marker",
        orphanTranscriptMinAgeMs: 300_000,
      }),
    ).rejects.toThrow("Cleaning internal sessions requires scoped plugin runtime.");
    expect(prefixReads).toBe(1);
  });
});
