import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { updateSessionStore } from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function seedEntries(storePath: string) {
  const protectedKey = resolveInternalSessionEffectsIdentity({
    agentId: "main",
    runId: "legacy-accessor-owner",
  }).sessionKey;
  const siblingKey = "agent:main:legacy-accessor-sibling";
  await replaceSessionEntry(
    { agentId: "main", sessionKey: protectedKey, storePath },
    { pluginOwnerId: "original-plugin", sessionId: "protected-session", updatedAt: 10 },
  );
  await replaceSessionEntry(
    { agentId: "main", sessionKey: siblingKey, storePath },
    { model: "original-model", sessionId: "sibling-session", updatedAt: 10 },
  );
  return { protectedKey, siblingKey };
}

describe("legacy whole-store accessor ownership", () => {
  it("reads an accessor owner once for both the protected comparison and SQLite reconciliation", async () => {
    const tempDir = tempDirs.make("openclaw-sdk-legacy-accessor-");
    const storePath = path.join(tempDir, "sessions.json");
    const { protectedKey, siblingKey } = await seedEntries(storePath);
    let ownerReads = 0;

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store[protectedKey] = {
            ...store[protectedKey]!,
            get pluginOwnerId() {
              ownerReads += 1;
              return ownerReads === 1 ? "original-plugin" : "foreign-plugin";
            },
          };
          store[siblingKey] = { ...store[siblingKey]!, model: "updated-model" };
          return "updated";
        },
        { skipMaintenance: true },
      ),
    ).resolves.toBe("updated");

    expect(fs.existsSync(path.join(tempDir, "openclaw-agent.sqlite"))).toBe(true);
    expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.pluginOwnerId).toBe(
      "original-plugin",
    );
    expect(ownerReads).toBe(1);
    expect(loadSessionEntry({ sessionKey: siblingKey, storePath })?.model).toBe("updated-model");
  });

  it("rejects a changed protected owner without persisting another public row", async () => {
    const tempDir = tempDirs.make("openclaw-sdk-legacy-accessor-reject-");
    const storePath = path.join(tempDir, "sessions.json");
    const { protectedKey, siblingKey } = await seedEntries(storePath);
    let ownerReads = 0;

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store[protectedKey] = {
            ...store[protectedKey]!,
            get pluginOwnerId() {
              ownerReads += 1;
              return "foreign-plugin";
            },
          };
          store[siblingKey] = { ...store[siblingKey]!, model: "unauthorized-sibling" };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow(`Writing internal session "${protectedKey}" requires scoped plugin runtime.`);

    expect(ownerReads).toBe(1);
    expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.pluginOwnerId).toBe(
      "original-plugin",
    );
    expect(loadSessionEntry({ sessionKey: siblingKey, storePath })?.model).toBe("original-model");
  });
});
