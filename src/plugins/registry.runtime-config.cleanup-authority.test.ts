import { describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

type Cleanup = NonNullable<PluginRuntime["agent"]["session"]["cleanupSessionLifecycleArtifacts"]>;

describe("plugin lifecycle cleanup host authority", () => {
  it("replaces caller-supplied owner and commit policy with its live plugin scope", async () => {
    const runtime = createPluginRuntime();
    const cleanup = vi.fn<Cleanup>(async (params) => {
      const guard: unknown = Object.getOwnPropertyDescriptor(params, "assertCommitAllowed")?.value;
      if (typeof guard === "function") {
        guard();
      }
      return { archivedTranscriptArtifacts: 0, removedEntries: 0 };
    });
    Object.defineProperty(runtime.agent.session, "cleanupSessionLifecycleArtifacts", {
      configurable: true,
      value: cleanup,
    });
    const registry = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: "active-memory",
      source: "/plugins/active-memory/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = registry.createApi(record, { config: {} });
    const publicCleanup = api.runtime.agent.session.cleanupSessionLifecycleArtifacts;
    if (!publicCleanup) {
      throw new Error("missing owner-bound cleanup capability");
    }
    const callerGuard = vi.fn(() => {
      throw new Error("caller cannot choose the commit guard");
    });
    const params = {
      agentId: "main",
      storePath: "/tmp/plugin-session-test.sqlite",
      sessionKeySegmentPrefix: "ordinary-session",
      orphanTranscriptMinAgeMs: 0,
      transcriptContentMarker: "synthetic",
      pluginOwnerId: "foreign-plugin",
      requireExactPluginOwnerId: false,
      assertCommitAllowed: callerGuard,
    };
    await expect(publicCleanup(params)).resolves.toEqual({
      archivedTranscriptArtifacts: 0,
      removedEntries: 0,
    });
    expect(callerGuard).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginOwnerId: "active-memory",
        requireExactPluginOwnerId: true,
        assertCommitAllowed: expect.any(Function),
      }),
    );
    registry.registry.plugins.splice(registry.registry.plugins.indexOf(record), 1);
    await expect(publicCleanup(params)).rejects.toThrow(/runtime is no longer active/);
  });
});
