import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  patchSessionEntryCore as patchInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  patchSessionEntry,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-store-runtime write target guards", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-sdk-session-store-guards-"), "sessions.json");
  });

  async function seedSessionEntry(sessionKey: string, entry: SessionEntry): Promise<void> {
    await patchInternalSessionEntry({ agentId: "main", sessionKey, storePath }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }

  it("guards entry deletion against a concurrent session update", async () => {
    const sessionKey = "agent:main:delete-guarded";
    const updatedAt = Date.now();
    await seedSessionEntry(sessionKey, { sessionId: "session-delete-guarded", updatedAt });

    await expect(
      deleteSessionEntry({
        expectedSessionId: "older-session",
        expectedUpdatedAt: updatedAt - 1,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(false);
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "session-delete-guarded",
      updatedAt,
    });

    await expect(
      deleteSessionEntry({
        expectedSessionId: "session-delete-guarded",
        expectedUpdatedAt: updatedAt,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(true);
  });

  it.each(["patch", "upsert"] as const)(
    "rejects a public ordinary %s that reuses a hidden internal session ID",
    async (method) => {
      const internalKey = "agent:main:internal-session-effects:protected-window";
      const ordinaryKey = `agent:main:ordinary-${method}-protected-window`;
      const victim = {
        sessionId: "protected-window",
        pluginOwnerId: "active-memory",
        updatedAt: 1,
      };
      await seedSessionEntry(internalKey, victim);

      const write =
        method === "upsert"
          ? upsertSessionEntry({
              agentId: "main",
              storePath,
              sessionKey: ordinaryKey,
              entry: { sessionId: victim.sessionId, updatedAt: 2 },
            })
          : patchSessionEntry({
              agentId: "main",
              storePath,
              sessionKey: ordinaryKey,
              fallbackEntry: { sessionId: victim.sessionId, updatedAt: 2 },
              update: (entry) => entry,
            });
      await expect(write).rejects.toThrow(
        /internal session|protected window|scoped plugin runtime/i,
      );
      expect(loadInternalSessionEntry({ sessionKey: internalKey, storePath })).toMatchObject(
        victim,
      );
      expect(getSessionEntry({ sessionKey: ordinaryKey, storePath })).toBeUndefined();
    },
  );

  it("guards entry deletion when the earlier snapshot had no session id", async () => {
    const sessionKey = "agent:main:delete-guarded-absent-id";
    const updatedAt = Date.now();
    await seedSessionEntry(sessionKey, { sessionId: "replacement-session", updatedAt });

    await expect(
      deleteSessionEntry({
        expectedSessionId: null,
        expectedUpdatedAt: updatedAt,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(false);
    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "replacement-session",
      updatedAt,
    });
  });

  it.each(["patch", "upsert", "update", "delete"] as const)(
    "snapshots the checked public key for %s before targeting the store",
    async (method) => {
      const publicKey = "agent:main:ordinary-write";
      const internalKey = "agent:main:internal-session-effects:guarded-write";
      await seedSessionEntry(publicKey, {
        sessionId: "ordinary-write",
        model: "ordinary",
        updatedAt: 1,
      });
      await seedSessionEntry(internalKey, {
        sessionId: "guarded-write",
        model: "protected",
        updatedAt: 1,
      });
      let reads = 0;
      const target = {
        agentId: "main",
        storePath,
        entry: { sessionId: "ordinary-write", model: "changed", updatedAt: 2 },
        update: () => ({ model: "changed" }),
        get sessionKey() {
          reads += 1;
          return reads === 1 ? publicKey : internalKey;
        },
      };

      if (method === "patch") {
        await patchSessionEntry(target);
      } else if (method === "upsert") {
        await upsertSessionEntry(target);
      } else if (method === "update") {
        await updateSessionStoreEntry(target);
      } else {
        await deleteSessionEntry(target);
      }
      expect(reads).toBe(1);
      expect(loadInternalSessionEntry({ sessionKey: internalKey, storePath })?.model).toBe(
        "protected",
      );
    },
  );
});
