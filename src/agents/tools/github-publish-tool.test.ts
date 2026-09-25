import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

describe("github_publish tool", () => {
  it("binds bounded model intent to the host-owned session", async () => {
    const callGatewayMock = vi.fn(async () => ({
      requestId: "publication-1",
      status: "requested" as const,
      message: "Publication was accepted.",
    }));
    const callGateway = callGatewayMock as InProcessGatewayCaller;
    const tool = createGitHubPublishTool({ callGateway });

    expect(tool.description).toContain("report the PR review as pending");
    expect(tool.description).toContain("current head before reporting PR completion");

    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:host-owned" },
      async () => await tool.execute("tool-call-1", { title: "Publish the fix" }),
    );

    expect(callGatewayMock).toHaveBeenCalledWith("sessions.github.publish", {
      sessionKey: "agent:main:host-owned",
      idempotencyKey: "tool-call-1",
      title: "Publish the fix",
    });
  });

  it("does not present a synchronous draft publication as reviewed", async () => {
    const tool = createGitHubPublishTool({
      callGateway: vi.fn(async () => ({
        requestId: "publication-2",
        status: "published",
        url: "https://github.com/example/project/pull/1",
        repository: "example/project",
        branch: "fix/draft",
        headCommit: "a".repeat(40),
      })) as InProcessGatewayCaller,
    });
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:draft" },
      async () => await tool.execute("tool-call-2", {}),
    );
    expect(result.details).toMatchObject({
      status: "published",
      review: expect.stringContaining("pending: PR published or reused, not reviewed"),
    });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("current head") }),
    ]);
  });
});
