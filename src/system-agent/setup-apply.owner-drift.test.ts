import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCurrentSystemAgentSetupTargetAgentId } from "./setup-apply.js";

describe("system-agent setup owner drift", () => {
  it("rejects an ambient owner change when the verified owner remains in the roster", () => {
    const drifted: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    };

    expect(() =>
      resolveCurrentSystemAgentSetupTargetAgentId({
        config: drifted,
        expectedAgentId: "main",
      }),
    ).toThrow("default agent changed");
  });

  it("keeps an explicitly selected verified target pinned", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    };

    expect(
      resolveCurrentSystemAgentSetupTargetAgentId({
        config,
        targetAgentId: "main",
        expectedAgentId: "main",
      }),
    ).toBe("main");
  });
});
