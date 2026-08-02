import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";

function warningIntegrityProjection(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const warning = value as Record<string, unknown>;
  if (typeof warning.acknowledgementId === "string") {
    return { decision: "warn", acknowledgementId: warning.acknowledgementId };
  }
  const reason = warning.reason;
  const findings = Array.isArray(warning.findings) ? warning.findings : undefined;
  return {
    decision: "warn",
    reason,
    ...(findings && findings.length > 0 ? { findings } : {}),
  };
}

function integrityProjection(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(integrityProjection);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      key === "installPolicyWarning"
        ? warningIntegrityProjection(child)
        : integrityProjection(child),
    ]),
  );
}

function replayIdentityProjection(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(replayIdentityProjection);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "planIntegrity" && key !== "installPolicyWarning")
      .map(([key, child]) => [key, replayIdentityProjection(child)]),
  );
}

// Policy evaluation supplies an acknowledgement id bound to the complete warning while replacing
// only its exact staging source path. Older warning objects remain bound byte-for-byte.
export function stableStringifyClawPlanIntegrity(value: unknown): string {
  return stableStringify(integrityProjection(value));
}

export function digestClawPlanIntegrity(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringifyClawPlanIntegrity(value)).digest("hex")}`;
}

// Warning acknowledgement may only remove or replace installPolicyWarning.
// Every other part of a rebuilt plan must still match the reviewed plan.
export function stableStringifyClawPlanReplayIdentity(value: unknown): string {
  return stableStringify(replayIdentityProjection(value));
}
