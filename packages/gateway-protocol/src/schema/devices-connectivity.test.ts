import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  DevicePairConnectivityInspectResultSchema,
  DevicePairConnectivityPlanParamsSchema,
  DevicePairConnectivityPlanResultSchema,
} from "./devices.js";

describe("device pairing connectivity schemas", () => {
  it("accepts bounded non-secret inspect and plan payloads", () => {
    const validateInspect = Compile(DevicePairConnectivityInspectResultSchema);
    const validatePlan = Compile(DevicePairConnectivityPlanResultSchema);
    const inspect = {
      configHash: "a".repeat(64),
      configState: "pending",
      auth: "token",
      current: { status: "blocked", blocker: "route-unavailable" },
      lan: { status: "available", url: "ws://192.168.1.20:18789", requiresGatewayChange: true },
      tailscale: { status: "unavailable" },
      publicUrl: { status: "not-configured" },
    };
    const plan = {
      status: "confirmation-required",
      mode: "lan",
      configHash: "a".repeat(64),
      configState: "pending",
      urls: ["ws://192.168.1.20:18789"],
      exposure: "local-network",
      auth: "token",
      access: "limited",
      accessDowngraded: true,
      changes: ["expose-gateway-on-local-network"],
      restartRequired: true,
      preservesCurrentRoute: false,
    };

    expect(validateInspect.Check(inspect)).toBe(true);
    expect(validatePlan.Check(plan)).toBe(true);
    expect(JSON.stringify({ inspect, plan })).not.toMatch(
      /bootstrapToken|setupCode|qrDataUrl|AuthURL|stdout|stderr/,
    );
  });

  it("rejects unbounded and credential-bearing public URLs", () => {
    const validateParams = Compile(DevicePairConnectivityPlanParamsSchema);
    expect(validateParams.Check({ mode: "public", publicUrl: "wss://gateway.example.com" })).toBe(
      true,
    );
    expect(validateParams.Check({ mode: "public", publicUrl: "x".repeat(2049) })).toBe(false);
    expect(
      validateParams.Check({ mode: "public", publicUrl: "wss://user:pass@gateway.example.com" }),
    ).toBe(true);
  });

  it("caps advertised URL arrays", () => {
    const validatePlan = Compile(DevicePairConnectivityPlanResultSchema);
    const result = {
      status: "confirmation-required",
      mode: "tailscale",
      configState: "unknown",
      urls: Array.from({ length: 9 }, (_, index) => `wss://gateway-${index}.example.com`),
      exposure: "tailnet",
      auth: "token",
      access: "full",
      accessDowngraded: false,
      changes: [],
      restartRequired: false,
      preservesCurrentRoute: true,
    };
    expect(validatePlan.Check(result)).toBe(false);
  });

  it("accepts unavailable auth without accepting credential diagnostics", () => {
    const validateInspect = Compile(DevicePairConnectivityInspectResultSchema);
    const result = {
      configState: "unknown",
      auth: "unavailable",
      current: { status: "blocked", blocker: "gateway-auth-unavailable" },
      lan: { status: "unavailable" },
      tailscale: { status: "unavailable" },
      publicUrl: { status: "not-configured" },
    };
    expect(validateInspect.Check(result)).toBe(true);
    for (const field of ["secretRef", "provider", "token", "password", "stderr"]) {
      expect(validateInspect.Check({ ...result, [field]: "redacted" })).toBe(false);
    }
  });

  it("accepts bounded manual Tailscale recovery and rejects executable or diagnostic fields", () => {
    const validatePlan = Compile(DevicePairConnectivityPlanResultSchema);
    const plan = {
      status: "blocked",
      mode: "tailscale",
      configState: "applied",
      auth: "token",
      blocker: "tailscale-serve-required",
      changes: [],
      action: { kind: "retry", target: "gateway-host", execution: "manual", resumable: true },
    };
    expect(validatePlan.Check(plan)).toBe(true);
    for (const field of ["href", "argv", "stdout", "stderr", "AuthURL", "rawConfig"]) {
      expect(validatePlan.Check({ ...plan, action: { ...plan.action, [field]: "redacted" } })).toBe(
        false,
      );
    }
    expect(validatePlan.Check({ ...plan, changes: ["enable-tailscale-serve"] })).toBe(false);
  });

  it("accepts typed persistent Tailscale route and service-approval states", () => {
    const validateInspect = Compile(DevicePairConnectivityInspectResultSchema);
    const base = {
      configState: "applied",
      auth: "token",
      current: { status: "blocked", blocker: "route-unavailable" },
      lan: { status: "unavailable" },
      publicUrl: { status: "not-configured" },
    };
    expect(
      validateInspect.Check({
        ...base,
        tailscale: {
          status: "running",
          backendState: "Running",
          host: "node.tail.ts.net",
          serviceApproval: "unknown",
          serve: { status: "unreadable" },
          funnel: { status: "unreadable" },
        },
      }),
    ).toBe(true);
    expect(
      validateInspect.Check({
        ...base,
        tailscale: {
          status: "running",
          backendState: "Running",
          host: "node.tail.ts.net",
          serviceApproval: "approved",
          serve: {
            status: "route-configured",
            readiness: "not-verified",
            urls: ["wss://node.tail.ts.net"],
          },
          funnel: { status: "not-configured" },
        },
      }),
    ).toBe(true);
  });
});
