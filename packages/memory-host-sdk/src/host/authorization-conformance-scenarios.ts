import type { MemoryAuthorizationConformanceScenario } from "./authorization-conformance.js";

function baseScenario(
  id: string,
  overrides: Partial<MemoryAuthorizationConformanceScenario> = {},
): MemoryAuthorizationConformanceScenario {
  const now = "2026-07-29T12:00:00.000Z";
  const userAudience = { kind: "user", id: "principal-owner" } as const;
  const context = {
    contextFingerprint: "context-revision-1",
    runId: "run-1",
    agentId: "agent-a",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    deliveryRevision: "delivery-revision-1",
    policyRevision: "policy-revision-1",
    hostFactsRevision: "host-facts-revision-1",
    operation: "read" as const,
    principalRefs: [
      {
        principalId: "principal-owner",
        evidenceRevision: "principal-evidence-revision-1",
      },
    ],
    membershipRefs: [],
    deliveryAudiences: [userAudience],
    lineagePolicySetIds: ["lineage-1"],
  };
  const scenario: MemoryAuthorizationConformanceScenario = {
    id,
    now,
    principals: [
      {
        principalId: "principal-owner",
        status: "active",
        evidenceRevision: "principal-evidence-revision-1",
        expiresAt: "2026-07-29T12:05:00.000Z",
      },
    ],
    memberships: [],
    stores: [
      {
        storeId: "store-a",
        agentId: "agent-a",
        placementCapabilities: [],
      },
    ],
    resources: [
      {
        resourceId: "resource-a",
        agentId: "agent-a",
        storeId: "store-a",
        revision: "resource-revision-1",
        audiences: [userAudience],
      },
    ],
    policyEntries: [
      {
        effect: "allow",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "retrieve",
      },
      {
        effect: "allow",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "read",
      },
    ],
    viewStoreIds: ["store-a"],
    context,
    plan: {
      contextFingerprint: context.contextFingerprint,
      runId: context.runId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      sessionIdentityRevision: context.sessionIdentityRevision,
      subjectRevision: context.subjectRevision,
      deliveryRevision: context.deliveryRevision,
      policyRevision: context.policyRevision,
      hostFactsRevision: context.hostFactsRevision,
      operation: context.operation,
      expiresAt: "2026-07-29T12:05:00.000Z",
    },
    ...overrides,
  };
  return scenario;
}

/** Produces malformed runtime input so conformance cases prove missing expirations fail closed. */
function withoutConformanceExpiry<T extends object>(value: T): T {
  const copy = { ...value };
  Reflect.deleteProperty(copy, "expiresAt");
  return copy;
}

/** Deterministic scenarios spanning every Phase 0 policy invariant. */
export function createMemoryAuthorizationConformanceScenarios(): MemoryAuthorizationConformanceScenario[] {
  const cases: MemoryAuthorizationConformanceScenario[] = [];

  const denyPrecedence = baseScenario("deny-precedence");
  cases.push({
    ...denyPrecedence,
    policyEntries: [
      ...denyPrecedence.policyEntries,
      {
        effect: "deny",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "read",
      },
    ],
  });

  const permissionImplication = baseScenario("permission-implication");
  cases.push({
    ...permissionImplication,
    policyEntries: permissionImplication.policyEntries.filter(
      (entry) => entry.operation !== "retrieve",
    ),
  });

  cases.push(baseScenario("permission-complete"));

  const revokedPrincipal = baseScenario("principal-revoked-retains-context-ref");
  cases.push({
    ...revokedPrincipal,
    principals: revokedPrincipal.principals.map((principal) =>
      Object.assign({}, principal, { status: "revoked" as const }),
    ),
  });

  const expiredPrincipal = baseScenario("principal-expired");
  cases.push({
    ...expiredPrincipal,
    principals: expiredPrincipal.principals.map((principal) =>
      Object.assign({}, principal, { expiresAt: "2026-07-29T12:00:00.000Z" }),
    ),
  });

  const principalMissingExpiry = baseScenario("principal-expiry-missing");
  cases.push({
    ...principalMissingExpiry,
    principals: principalMissingExpiry.principals.map(withoutConformanceExpiry),
  });

  const missingPrincipal = baseScenario("principal-missing");
  cases.push({ ...missingPrincipal, principals: [] });

  const principalRevision = baseScenario("principal-revision-mismatch");
  cases.push({
    ...principalRevision,
    context: {
      ...principalRevision.context,
      principalRefs: principalRevision.context.principalRefs.map((ref) =>
        Object.assign({}, ref, { evidenceRevision: "principal-evidence-revision-2" }),
      ),
    },
  });

  const duplicatePrincipalRef = baseScenario("principal-duplicate-ref");
  cases.push({
    ...duplicatePrincipalRef,
    context: {
      ...duplicatePrincipalRef.context,
      principalRefs: [
        ...duplicatePrincipalRef.context.principalRefs,
        ...duplicatePrincipalRef.context.principalRefs,
      ],
    },
  });

  const duplicatePrincipalFact = baseScenario("principal-duplicate-host-fact");
  cases.push({
    ...duplicatePrincipalFact,
    principals: [...duplicatePrincipalFact.principals, ...duplicatePrincipalFact.principals],
  });

  const membershipRequirement = {
    principalId: "principal-owner",
    groupId: "group-shared",
    provider: "provider-primary",
  } as const;
  const requiredMembership = baseScenario("membership-required-valid");
  const validMembership = {
    principalId: membershipRequirement.principalId,
    groupId: membershipRequirement.groupId,
    provider: membershipRequirement.provider,
    status: "active" as const,
    evidenceRevision: "membership-evidence-revision-1",
    hostFactsRevision: requiredMembership.context.hostFactsRevision,
    expiresAt: "2026-07-29T12:05:00.000Z",
  };
  const requiredMembershipScenario = {
    ...requiredMembership,
    stores: requiredMembership.stores.map((store) =>
      Object.assign({}, store, { requiredMembership: membershipRequirement }),
    ),
    memberships: [validMembership],
    context: {
      ...requiredMembership.context,
      membershipRefs: [
        {
          principalId: validMembership.principalId,
          groupId: validMembership.groupId,
          provider: validMembership.provider,
          evidenceRevision: validMembership.evidenceRevision,
          hostFactsRevision: validMembership.hostFactsRevision,
        },
      ],
    },
  } satisfies MemoryAuthorizationConformanceScenario;
  cases.push(requiredMembershipScenario);

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-expired",
    memberships: [
      {
        ...validMembership,
        expiresAt: "2026-07-29T12:00:00.000Z",
      },
    ],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-expiry-missing",
    memberships: [withoutConformanceExpiry(validMembership)],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-revoked",
    memberships: [{ ...validMembership, status: "revoked" }],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-removed",
    memberships: [],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-revision-mismatch",
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: requiredMembershipScenario.context.membershipRefs.map((ref) =>
        Object.assign({}, ref, { evidenceRevision: "membership-evidence-revision-2" }),
      ),
    },
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-provider-mismatch",
    memberships: [
      {
        ...validMembership,
        provider: "provider-secondary",
      },
    ],
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: requiredMembershipScenario.context.membershipRefs.map((ref) =>
        Object.assign({}, ref, { provider: "provider-secondary" }),
      ),
    },
  });

  const refreshedHostFactsRevision = "host-facts-revision-2";
  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-host-facts-revision-mismatch",
    context: {
      ...requiredMembershipScenario.context,
      hostFactsRevision: refreshedHostFactsRevision,
    },
    plan: {
      ...requiredMembershipScenario.plan,
      hostFactsRevision: refreshedHostFactsRevision,
    },
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-duplicate-ref",
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: [
        ...requiredMembershipScenario.context.membershipRefs,
        ...requiredMembershipScenario.context.membershipRefs,
      ],
    },
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-duplicate-host-fact",
    memberships: [validMembership, validMembership],
  });

  const membershipForUnverifiedPrincipal = {
    principalId: "principal-not-directly-verified",
    groupId: membershipRequirement.groupId,
    provider: validMembership.provider,
    status: "active" as const,
    evidenceRevision: "membership-evidence-revision-1",
    hostFactsRevision: validMembership.hostFactsRevision,
    expiresAt: "2026-07-29T12:05:00.000Z",
  };
  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-principal-not-directly-verified",
    stores: requiredMembershipScenario.stores.map((store) =>
      Object.assign({}, store, {
        requiredMembership: {
          principalId: membershipForUnverifiedPrincipal.principalId,
          groupId: membershipForUnverifiedPrincipal.groupId,
          provider: membershipForUnverifiedPrincipal.provider,
        },
      }),
    ),
    memberships: [membershipForUnverifiedPrincipal],
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: [
        {
          principalId: membershipForUnverifiedPrincipal.principalId,
          groupId: membershipForUnverifiedPrincipal.groupId,
          provider: membershipForUnverifiedPrincipal.provider,
          evidenceRevision: membershipForUnverifiedPrincipal.evidenceRevision,
          hostFactsRevision: membershipForUnverifiedPrincipal.hostFactsRevision,
        },
      ],
    },
  });

  const unrelatedStaleMembership = baseScenario("membership-unrelated-stale-is-harmless");
  cases.push({
    ...unrelatedStaleMembership,
    memberships: [
      {
        principalId: "principal-owner",
        groupId: "group-unrelated",
        provider: "provider-primary",
        status: "active",
        evidenceRevision: "membership-evidence-revision-1",
        hostFactsRevision: unrelatedStaleMembership.context.hostFactsRevision,
        expiresAt: "2026-07-29T12:00:00.000Z",
      },
    ],
    context: {
      ...unrelatedStaleMembership.context,
      membershipRefs: [
        {
          principalId: "principal-owner",
          groupId: "group-unrelated",
          provider: "provider-primary",
          evidenceRevision: "membership-evidence-revision-1",
          hostFactsRevision: unrelatedStaleMembership.context.hostFactsRevision,
        },
      ],
    },
  });

  const crossAgent = baseScenario("cross-agent-cell");
  cases.push({
    ...crossAgent,
    resources: crossAgent.resources.map((resource) =>
      Object.assign({}, resource, { agentId: "agent-b" }),
    ),
  });

  const staleContext = baseScenario("plan-context-revision");
  cases.push({
    ...staleContext,
    context: { ...staleContext.context, subjectRevision: "subject-revision-2" },
  });

  const staleRun = baseScenario("plan-run-binding");
  cases.push({
    ...staleRun,
    context: { ...staleRun.context, runId: "run-2" },
  });

  const staleSession = baseScenario("plan-session-binding");
  cases.push({
    ...staleSession,
    context: { ...staleSession.context, sessionId: "session-2" },
  });

  const expiredPlan = baseScenario("plan-expiry");
  cases.push({
    ...expiredPlan,
    plan: { ...expiredPlan.plan, expiresAt: "2026-07-29T11:59:59.000Z" },
  });

  const missingPlanExpiry = baseScenario("plan-expiry-missing");
  cases.push({
    ...missingPlanExpiry,
    plan: withoutConformanceExpiry(missingPlanExpiry.plan),
  });

  const staleHostFacts = baseScenario("plan-host-facts-revision");
  cases.push({
    ...staleHostFacts,
    plan: { ...staleHostFacts.plan, hostFactsRevision: "host-facts-revision-2" },
  });

  const audienceIntersection = baseScenario("delivery-audience-intersection");
  cases.push({
    ...audienceIntersection,
    context: {
      ...audienceIntersection.context,
      deliveryAudiences: [{ kind: "conversation", id: "conversation-b" }],
    },
  });

  const delegationIntersection = baseScenario("delegation-intersection");
  cases.push({
    ...delegationIntersection,
    context: {
      ...delegationIntersection.context,
      delegation: {
        allowedOperations: ["retrieve"],
        maximumAudiences: delegationIntersection.context.deliveryAudiences,
      },
    },
  });

  const lineage = baseScenario("lineage-requirements");
  cases.push({
    ...lineage,
    resources: lineage.resources.map((resource) =>
      Object.assign({}, resource, {
        requiredLineagePolicySetIds: ["lineage-1", "lineage-2"],
      }),
    ),
  });

  const prefilter = baseScenario("prefilter-superset");
  cases.push({
    ...prefilter,
    resources: [
      ...prefilter.resources,
      {
        resourceId: "resource-denied",
        agentId: "agent-b",
        storeId: "store-a",
        revision: "resource-revision-2",
        audiences: prefilter.context.deliveryAudiences,
      },
    ],
  });

  return cases;
}
