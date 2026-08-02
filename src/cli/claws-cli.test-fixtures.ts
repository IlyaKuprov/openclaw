import type { ClawUpdatePlan } from "../claws/update-plan-types.js";

export function createClawUpdatePlanFixture(): ClawUpdatePlan {
  return {
    schemaVersion: "openclaw.clawUpdatePlan.v1",
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:update-plan",
    found: true,
    agentId: "demo-agent",
    currentClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
    summary: {
      totalActions: 1,
      added: 0,
      changed: 1,
      removed: 0,
      released: 0,
      unchanged: 0,
      manual: 0,
      blocked: 0,
      capabilityChanges: 1,
      capabilityEscalations: 1,
    },
    actions: [
      {
        kind: "package",
        id: "skill:@acme/demo-skill",
        action: "change",
        target: "clawhub:@acme/demo-skill@1.0.0",
        blocked: false,
        reason: "target changes a package",
        installPolicyWarning: {
          reason: "Review \u001b[31mskill behavior",
          findings: [{ ruleId: "shell", severity: "warn", message: "Runs a shell command" }],
          acknowledgementId: `sha256:${"a".repeat(64)}`,
        },
      },
    ],
    capabilityChanges: [
      {
        kind: "agent",
        id: "demo-agent",
        path: "agent.sandbox.mode",
        action: "change",
        classification: "escalation",
        requiresDistinctConsent: true,
        reason: "Agent capability field sandbox.mode changes in the target manifest.",
        effect: { path: "sandbox.mode", current: "non-main", desired: "all" },
        current: { summary: "non-main", digest: "sha256:current" },
        desired: { summary: "all", digest: "sha256:desired" },
      },
    ],
    blockers: [],
    diagnostics: [],
  };
}
