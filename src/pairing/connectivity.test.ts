// Pairing connectivity tests pin the non-secret planning contract before setup-code issuance.
import { describe, expect, it, vi } from "vitest";
import { FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import {
  inspectPairingConnectivity,
  planPairingConnectivity,
  resolvePairingSetupConnectivityFromConfig,
} from "./connectivity.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(() => {
    throw new Error("connectivity planning must not mint a bootstrap token");
  }),
}));

const tokenConfig = {
  gateway: {
    bind: "loopback" as const,
    auth: { mode: "token" as const, token: "top-secret-token" },
  },
};

describe("pairing connectivity", () => {
  it("inspects and plans LAN exposure without returning or minting secrets", async () => {
    const inspect = await inspectPairingConnectivity(tokenConfig, {
      configHash: "a".repeat(64),
      networkInterfaces: () => ({
        en0: [
          {
            address: "192.168.1.20",
            family: "IPv4",
            internal: false,
            netmask: "255.255.255.0",
            mac: "00:00:00:00:00:00",
            cidr: "192.168.1.20/24",
          },
        ],
      }),
      runCommandWithTimeout: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    });
    const plan = planPairingConnectivity(inspect, { mode: "lan" });

    expect(plan).toEqual({
      status: "confirmation-required",
      mode: "lan",
      configHash: "a".repeat(64),
      urls: ["ws://192.168.1.20:18789"],
      exposure: "local-network",
      auth: "token",
      access: "limited",
      accessDowngraded: true,
      changes: ["expose-gateway-on-local-network"],
      restartRequired: true,
      preservesCurrentRoute: false,
    });
    const serialized = JSON.stringify({ inspect, plan });
    expect(serialized).not.toContain("top-secret-token");
    expect(serialized).not.toMatch(
      /bootstrapToken|setupCode|qrDataUrl|password|SecretRef|AuthURL|stdout|stderr/,
    );
  });

  it("requires an operator-provided origin-only wss URL for public planning", async () => {
    const inspect = await inspectPairingConnectivity(tokenConfig, {
      networkInterfaces: () => ({}),
      runCommandWithTimeout: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    });

    expect(planPairingConnectivity(inspect, { mode: "public" })).toMatchObject({
      status: "blocked",
      blocker: "public-url-required",
    });
    for (const publicUrl of [
      "ws://gateway.example.com",
      "wss://user:pass@gateway.example.com",
      "wss://gateway.example.com/path",
      "wss://gateway.example.com?token=secret",
      "wss://gateway.example.com/#fragment",
    ]) {
      expect(planPairingConnectivity(inspect, { mode: "public", publicUrl })).toMatchObject({
        status: "blocked",
      });
    }
    expect(
      planPairingConnectivity(inspect, {
        mode: "public",
        publicUrl: "wss://gateway.example.com:443",
      }),
    ).toMatchObject({
      status: "confirmation-required",
      urls: ["wss://gateway.example.com"],
      exposure: "public-internet",
      changes: [],
      restartRequired: false,
    });
  });

  it("reports ambiguous configured auth without exposing either credential", async () => {
    const inspect = await inspectPairingConnectivity(
      {
        gateway: {
          bind: "loopback",
          auth: { token: "token-secret", password: "password-secret" },
        },
      },
      {
        networkInterfaces: () => ({}),
        runCommandWithTimeout: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
      },
    );

    expect(inspect).toMatchObject({
      auth: "invalid",
      current: { status: "blocked", blocker: "gateway-auth-invalid" },
    });
    expect(JSON.stringify(inspect)).not.toMatch(/token-secret|password-secret/);
  });

  it("keeps the setup resolver policy identical for LAN downgrade and secure public access", async () => {
    const runCommandWithTimeout = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
    const lan = await resolvePairingSetupConnectivityFromConfig(
      {
        gateway: {
          bind: "lan",
          auth: { mode: "token", token: "token" },
        },
      },
      {
        networkInterfaces: () => ({
          en0: [
            {
              address: "192.168.1.20",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              mac: "00:00:00:00:00:00",
              cidr: "192.168.1.20/24",
            },
          ],
        }),
        runCommandWithTimeout,
      },
    );
    expect(lan).toMatchObject({
      ok: true,
      urls: ["ws://192.168.1.20:18789"],
      access: "limited",
      accessDowngraded: true,
    });
    if (lan.ok) {
      expect(lan.bootstrapProfile).not.toEqual(FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE);
    }

    await expect(
      resolvePairingSetupConnectivityFromConfig(tokenConfig, {
        publicUrl: "wss://gateway.example.com",
      }),
    ).resolves.toMatchObject({
      ok: true,
      urls: ["wss://gateway.example.com"],
      access: "full",
      accessDowngraded: false,
      bootstrapProfile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
  });
});
