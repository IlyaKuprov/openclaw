import { expect, it, vi } from "vitest";
import {
  createClawPackagePolicyPreflight,
  replayClawInstallPolicyAcknowledgement,
  resolveClawInstallPolicyAcknowledgement,
} from "./install-policy-acknowledgement.js";
import type { preflightClawPackage } from "./packages.js";

const FIRST_ID = `sha256:${"a".repeat(64)}`;
const SECOND_ID = `sha256:${"b".repeat(64)}`;
const THIRD_ID = `sha256:${"c".repeat(64)}`;

function replayIdentity(plan: {
  planIntegrity: string;
  warnings: Array<{ packageId: string; warning: { reason: string; acknowledgementId: string } }>;
  packageDigest?: string;
}): string {
  return JSON.stringify({ packageDigest: plan.packageDigest });
}

it("preserves one warning id and aggregates multiple package warnings in order", () => {
  const first = {
    packageId: "skill:first",
    warning: { reason: "First", acknowledgementId: FIRST_ID },
  };
  expect(resolveClawInstallPolicyAcknowledgement([first])).toMatchObject({
    acknowledgementId: FIRST_ID,
    warnings: [first.warning],
  });

  const acknowledgement = resolveClawInstallPolicyAcknowledgement([
    first,
    { packageId: "plugin:second", warning: { reason: "Second", acknowledgementId: SECOND_ID } },
  ]);

  expect(acknowledgement.acknowledgementId).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(acknowledgement.acknowledgementId).not.toBe(FIRST_ID);
  expect(acknowledgement.packageAcknowledgementIds).toEqual(
    new Map([
      ["skill:first", FIRST_ID],
      ["plugin:second", SECOND_ID],
    ]),
  );
});

it("fails closed when any package warning has no acknowledgement id", () => {
  expect(
    resolveClawInstallPolicyAcknowledgement([
      { packageId: "skill:first", warning: { reason: "First", acknowledgementId: FIRST_ID } },
      { packageId: "plugin:second", warning: { reason: "Second" } },
    ]).acknowledgementId,
  ).toBeUndefined();
});

it("replays each reviewed package warning id instead of the aggregate id", async () => {
  const preflight = vi.fn(
    async (
      ..._args: Parameters<typeof preflightClawPackage>
    ): ReturnType<typeof preflightClawPackage> => ({
      ok: true,
      action: "install",
      integrity: "sha256:fixture",
    }),
  );
  const run = createClawPackagePolicyPreflight({
    config: { security: { installPolicy: { enabled: true } } },
    acknowledgementIds: new Map([["plugin:@acme/first", FIRST_ID]]),
    preflight,
  });
  const plugin = {
    kind: "plugin" as const,
    source: "clawhub" as const,
    ref: "@acme/first",
    version: "1.0.0",
  };
  const skill = {
    kind: "skill" as const,
    source: "clawhub" as const,
    ref: "@acme/second",
    version: "1.0.0",
  };

  await run(plugin, "/tmp/workspace", "install");
  await run(skill, "/tmp/workspace", "update");

  expect(preflight).toHaveBeenNthCalledWith(
    1,
    plugin,
    "/tmp/workspace",
    expect.objectContaining({
      mode: "install",
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: FIRST_ID,
    }),
  );
  expect(preflight).toHaveBeenNthCalledWith(
    2,
    skill,
    "/tmp/workspace",
    expect.not.objectContaining({ installPolicyAcknowledgementId: expect.anything() }),
  );
});

it("reconstructs earlier warning stages before consuming an exact later plan", async () => {
  type Plan = {
    planIntegrity: string;
    warnings: Array<{ packageId: string; warning: { reason: string; acknowledgementId: string } }>;
  };
  const firstPlan: Plan = {
    planIntegrity: "sha256:first-plan",
    warnings: [
      { packageId: "plugin:first", warning: { reason: "First", acknowledgementId: FIRST_ID } },
    ],
  };
  const secondPlan: Plan = {
    planIntegrity: "sha256:second-plan",
    warnings: [
      {
        packageId: "plugin:first",
        warning: { reason: "Second", acknowledgementId: SECOND_ID },
      },
    ],
  };
  const finalPlan: Plan = { planIntegrity: "sha256:final-plan", warnings: [] };
  const rebuild = vi
    .fn<(ids: ReadonlyMap<string, string>) => Promise<Plan>>()
    .mockResolvedValueOnce(secondPlan)
    .mockResolvedValueOnce(finalPlan);

  const replay = await replayClawInstallPolicyAcknowledgement({
    initialPlan: firstPlan,
    presentedAcknowledgementId: SECOND_ID,
    presentedPlanIntegrity: secondPlan.planIntegrity,
    planIntegrity: (plan) => plan.planIntegrity,
    replayIdentity,
    warnings: (plan) => plan.warnings,
    rebuild,
  });

  expect(replay).toMatchObject({ plan: finalPlan, matched: true });
  expect(replay.acknowledgement.packageAcknowledgementIds).toEqual(
    new Map([["plugin:first", SECOND_ID]]),
  );
  expect(rebuild).toHaveBeenNthCalledWith(1, new Map([["plugin:first", FIRST_ID]]));
  expect(rebuild).toHaveBeenNthCalledWith(2, new Map([["plugin:first", SECOND_ID]]));
});

it("retains other package acknowledgements while one package advances stages", async () => {
  type Plan = {
    planIntegrity: string;
    warnings: Array<{ packageId: string; warning: { reason: string; acknowledgementId: string } }>;
  };
  const firstPlan: Plan = {
    planIntegrity: "sha256:first-plan",
    warnings: [
      { packageId: "plugin:first", warning: { reason: "First A", acknowledgementId: FIRST_ID } },
      {
        packageId: "plugin:second",
        warning: { reason: "First B", acknowledgementId: SECOND_ID },
      },
    ],
  };
  const secondPlan: Plan = {
    planIntegrity: "sha256:second-plan",
    warnings: [
      { packageId: "plugin:first", warning: { reason: "Second A", acknowledgementId: THIRD_ID } },
    ],
  };
  const finalPlan: Plan = { planIntegrity: "sha256:final-plan", warnings: [] };
  const rebuild = vi.fn(async (ids: ReadonlyMap<string, string>): Promise<Plan> => {
    if (ids.get("plugin:first") === THIRD_ID && ids.get("plugin:second") === SECOND_ID) {
      return finalPlan;
    }
    if (ids.get("plugin:first") === FIRST_ID && ids.get("plugin:second") === SECOND_ID) {
      return secondPlan;
    }
    return firstPlan;
  });

  const secondAcknowledgement = resolveClawInstallPolicyAcknowledgement(secondPlan.warnings);
  const replay = await replayClawInstallPolicyAcknowledgement({
    initialPlan: firstPlan,
    presentedAcknowledgementId: secondAcknowledgement.acknowledgementId,
    presentedPlanIntegrity: secondPlan.planIntegrity,
    planIntegrity: (plan) => plan.planIntegrity,
    replayIdentity,
    warnings: (plan) => plan.warnings,
    rebuild,
  });

  expect(replay).toMatchObject({ plan: finalPlan, matched: true });
  expect(replay.acknowledgement.packageAcknowledgementIds).toEqual(
    new Map([
      ["plugin:first", THIRD_ID],
      ["plugin:second", SECOND_ID],
    ]),
  );
  expect(rebuild).toHaveBeenNthCalledWith(
    2,
    new Map([
      ["plugin:first", THIRD_ID],
      ["plugin:second", SECOND_ID],
    ]),
  );
});

it("keeps the initial warning plan when the supplied pair is not in its replay chain", async () => {
  const initialPlan = {
    planIntegrity: "sha256:first-plan",
    warnings: [
      { packageId: "plugin:first", warning: { reason: "First", acknowledgementId: FIRST_ID } },
    ],
  };
  const finalPlan = { planIntegrity: "sha256:final-plan", warnings: [] };

  const replay = await replayClawInstallPolicyAcknowledgement({
    initialPlan,
    presentedAcknowledgementId: SECOND_ID,
    presentedPlanIntegrity: "sha256:unrelated-plan",
    planIntegrity: (plan) => plan.planIntegrity,
    replayIdentity,
    warnings: (plan) => plan.warnings,
    rebuild: async () => finalPlan,
  });

  expect(replay).toMatchObject({ plan: initialPlan, matched: false });
  expect(replay.acknowledgement.packageAcknowledgementIds).toEqual(
    new Map([["plugin:first", FIRST_ID]]),
  );
});

it("rejects warning replay when another reviewed plan field changes", async () => {
  const initialPlan = {
    planIntegrity: "sha256:first-plan",
    packageDigest: "sha256:reviewed-package",
    warnings: [
      { packageId: "plugin:first", warning: { reason: "First", acknowledgementId: FIRST_ID } },
    ],
  };
  const changedPlan = {
    planIntegrity: "sha256:changed-plan",
    packageDigest: "sha256:changed-package",
    warnings: [],
  };

  const replay = await replayClawInstallPolicyAcknowledgement({
    initialPlan,
    presentedAcknowledgementId: FIRST_ID,
    presentedPlanIntegrity: initialPlan.planIntegrity,
    planIntegrity: (plan) => plan.planIntegrity,
    replayIdentity,
    warnings: (plan) => plan.warnings,
    rebuild: async () => changedPlan,
  });

  expect(replay).toMatchObject({ plan: changedPlan, matched: false });
});
