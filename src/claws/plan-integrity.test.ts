import { describe, expect, it } from "vitest";
import {
  stableStringifyClawPlanIntegrity,
  stableStringifyClawPlanReplayIdentity,
} from "./plan-integrity.js";

function warnedPlan(stage: string, reason = "Review staged package", acknowledgementId?: string) {
  return {
    actions: [
      {
        installPolicyWarning: {
          reason: `${reason} ${stage}`,
          ...(acknowledgementId ? { acknowledgementId } : {}),
          findings: [
            {
              ruleId: "review-package",
              severity: "warn",
              message: `Review package behavior in ${stage}/index.js`,
              file: `${stage}/index.js`,
              evidence: `matched ${stage}/index.js`,
            },
          ],
        },
      },
    ],
  };
}

describe("stableStringifyClawPlanIntegrity", () => {
  it("uses the policy acknowledgement id to bind stable warning semantics", () => {
    const first = stableStringifyClawPlanIntegrity(
      warnedPlan("/tmp/openclaw-plugin-a1b2c3/package", "Review staged package", "sha256:first"),
    );
    const repeated = stableStringifyClawPlanIntegrity(
      warnedPlan("/tmp/openclaw-plugin-d4e5f6/package", "Review staged package", "sha256:first"),
    );
    const changed = stableStringifyClawPlanIntegrity(
      warnedPlan(
        "/tmp/openclaw-plugin-g7h8i9/package",
        "Escalated review for staged package",
        "sha256:changed",
      ),
    );

    expect(repeated).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("does not normalize similarly named external paths without an acknowledgement id", () => {
    const first = stableStringifyClawPlanIntegrity(warnedPlan("/opt/openclaw-risk-abc123"));
    const changed = stableStringifyClawPlanIntegrity(warnedPlan("/opt/openclaw-risk-def456"));

    expect(changed).not.toBe(first);
  });
});

describe("stableStringifyClawPlanReplayIdentity", () => {
  it("ignores only plan integrity and install-policy warning state", () => {
    const reviewed = {
      planIntegrity: "sha256:reviewed",
      packageDigest: "sha256:package",
      installPolicyWarning: { reason: "Review", acknowledgementId: "sha256:warning" },
    };

    expect(
      stableStringifyClawPlanReplayIdentity({
        ...reviewed,
        planIntegrity: "sha256:rebuilt",
        installPolicyWarning: undefined,
      }),
    ).toBe(stableStringifyClawPlanReplayIdentity(reviewed));
    expect(
      stableStringifyClawPlanReplayIdentity({
        ...reviewed,
        planIntegrity: "sha256:rebuilt",
        packageDigest: "sha256:changed",
        installPolicyWarning: undefined,
      }),
    ).not.toBe(stableStringifyClawPlanReplayIdentity(reviewed));
  });
});
