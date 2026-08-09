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
});
