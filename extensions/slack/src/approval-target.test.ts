// Slack tests cover workspace-qualified approval target behavior.
import { describe, expect, it } from "vitest";
import { formatSlackApprovalTarget, parseSlackApprovalTarget } from "./approval-target.js";

describe("Slack approval targets", () => {
  it("round-trips a workspace-qualified channel", () => {
    const target = formatSlackApprovalTarget({
      teamId: "T123",
      kind: "channel",
      id: "C456",
    });

    expect(target).toBe("team:T123:channel:C456");
    expect(parseSlackApprovalTarget(target)).toEqual({
      teamId: "T123",
      kind: "channel",
      id: "C456",
    });
  });

  it("keeps ordinary Slack targets compatible", () => {
    expect(parseSlackApprovalTarget("user:U123")).toEqual({
      kind: "user",
      id: "U123",
    });
  });

  it("rejects malformed workspace-qualified targets", () => {
    expect(() => parseSlackApprovalTarget("team:not-a-team:user:U123")).toThrow(
      "Invalid Slack workspace-qualified approval target",
    );
  });
});
