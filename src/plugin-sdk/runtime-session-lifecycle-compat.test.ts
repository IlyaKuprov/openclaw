import { describe, expect, it } from "vitest";
import type { PluginRuntime, PluginRuntimeWithSessionLifecycleCleanupV1 } from "./core.js";

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
    expect(acceptPreviousAdapter).toBeTypeOf("function");
    expect(requireV1).toBeTypeOf("function");
  });
});
