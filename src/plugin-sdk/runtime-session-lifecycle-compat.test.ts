import { describe, expect, it } from "vitest";
import type { PluginRuntime, PluginRuntimeWithSessionLifecycleCleanupV1 } from "./core.js";

// The owner-bound V1 surface accepts cleanup intent, never caller-selected host authority.
type CleanupIntent = Parameters<
  PluginRuntimeWithSessionLifecycleCleanupV1["agent"]["session"]["cleanupSessionLifecycleArtifacts"]
>[0];
type HostAuthorityKey = Extract<
  keyof CleanupIntent,
  "pluginOwnerId" | "requireExactPluginOwnerId" | "assertCommitAllowed"
>;

// An external adapter written before cleanup was added implements the prior
// session shape without that member. It must remain assignable to the SDK type.
type PreviousSessionAdapter = Omit<
  PluginRuntime["agent"]["session"],
  "cleanupSessionLifecycleArtifacts"
>;
type PreviousRuntimeAdapter = Omit<PluginRuntime, "agent"> & {
  agent: Omit<PluginRuntime["agent"], "session"> & {
    session: PreviousSessionAdapter;
  };
};

describe("plugin runtime lifecycle cleanup source compatibility", () => {
  it("accepts external runtime adapters that predate lifecycle cleanup", () => {
    const acceptPreviousAdapter = (runtime: PreviousRuntimeAdapter): PluginRuntime => runtime;
    const requireV1 = (runtime: PluginRuntimeWithSessionLifecycleCleanupV1) =>
      runtime.agent.session.cleanupSessionLifecycleArtifacts;
    const callerChoosesHostAuthority: HostAuthorityKey extends never ? false : true = false;
    expect(callerChoosesHostAuthority).toBe(false);
    expect(acceptPreviousAdapter).toBeTypeOf("function");
    expect(requireV1).toBeTypeOf("function");
  });
});
