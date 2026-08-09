// Pairing connectivity tests pin the non-secret planning contract before setup-code issuance.
import { describe, expect, it, vi } from "vitest";
import {
  validateDevicePairConnectivityInspectResult,
  validateDevicePairConnectivityPlanResult,
} from "../../packages/gateway-protocol/src/index.js";
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
      configState: "pending",
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
      configState: "pending",
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

  it("uses the exact configured Tailscale route and caps every public projection", async () => {
    const routeHosts = Array.from(
      { length: 10 },
      (_, index) => `gateway-${String(index).padStart(2, "0")}.tail.ts.net:443`,
    ).toReversed();
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: Object.fromEntries(
              routeHosts.map((host) => [host, { Handlers: { "/": { Proxy: "127.0.0.1:18789" } } }]),
            ),
          })
        : JSON.stringify({ BackendState: "Running" }),
    }));
    const inspect = await inspectPairingConnectivity(
      {
        gateway: {
          tailscale: { mode: "serve" },
          auth: { mode: "token", token: "token" },
        },
      },
      { runCommandWithTimeout, networkInterfaces: () => ({}) },
    );
    const plan = planPairingConnectivity(inspect, { mode: "tailscale" });

    expect(inspect.current).toMatchObject({ status: "ready" });
    expect(inspect.current.status === "ready" ? inspect.current.urls : []).toEqual(
      routeHosts
        .toSorted()
        .slice(0, 8)
        .map((host) => `wss://${host.replace(":443", "")}`),
    );
    expect(inspect.tailscale).toMatchObject({
      status: "running",
      serve: { status: "ready", urls: expect.any(Array) },
    });
    expect(plan).toMatchObject({ status: "confirmation-required" });
    expect(validateDevicePairConnectivityInspectResult(inspect)).toBe(true);
    expect(validateDevicePairConnectivityPlanResult(plan)).toBe(true);
  });

  it.each([
    ["serve", "wss://private.tail.ts.net"],
    ["funnel", "wss://public.tail.ts.net:8443"],
  ] as const)(
    "selects only the configured %s route for current connectivity",
    async (mode, url) => {
      const runCommandWithTimeout = vi.fn(async (argv: string[]) => ({
        code: 0,
        stdout: argv.includes("serve")
          ? JSON.stringify({
              TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
              Web: {
                "private.tail.ts.net:443": {
                  Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
                },
                "public.tail.ts.net:8443": {
                  Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
                },
              },
              AllowFunnel: { "public.tail.ts.net:8443": true },
            })
          : JSON.stringify({ BackendState: "Running" }),
      }));

      const inspect = await inspectPairingConnectivity(
        {
          gateway: {
            tailscale: { mode },
            auth: { mode: "token", token: "token" },
          },
        },
        { runCommandWithTimeout, networkInterfaces: () => ({}) },
      );
      expect(inspect.current).toMatchObject({ status: "ready", urls: [url] });
    },
  );

  it("does not fall back from a named service to node Serve routes", async () => {
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify({
            TCP: { "443": { HTTPS: true } },
            Web: {
              "private.tail.ts.net:443": {
                Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
              },
            },
            Services: {
              "svc:other": {
                TCP: { "443": { HTTPS: true } },
                Web: {
                  "other.tail.ts.net:443": {
                    Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
                  },
                },
              },
            },
          })
        : JSON.stringify({ BackendState: "Running" }),
    }));
    const inspect = await inspectPairingConnectivity(
      {
        gateway: {
          tailscale: { mode: "serve", serviceName: "svc:openclaw" },
          auth: { mode: "token", token: "token" },
        },
      },
      { runCommandWithTimeout, networkInterfaces: () => ({}) },
    );

    expect(inspect.current).toEqual({ status: "blocked", blocker: "route-unavailable" });
    expect(planPairingConnectivity(inspect, { mode: "tailscale" })).toMatchObject({
      status: "blocked",
      blocker: "tailscale-serve-required",
    });
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

  it("keeps LAN and Public selectable when the optional Tailscale branch is unavailable", async () => {
    const inspect = await inspectPairingConnectivity(tokenConfig, {
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
      runCommandWithTimeout: vi.fn(async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    });

    expect(inspect.tailscale).toEqual({ status: "unavailable" });
    expect(planPairingConnectivity(inspect, { mode: "lan" })).toMatchObject({
      status: "confirmation-required",
      mode: "lan",
    });
    expect(
      planPairingConnectivity(inspect, {
        mode: "public",
        publicUrl: "wss://gateway.example.com",
      }),
    ).toMatchObject({ status: "confirmation-required", mode: "public" });
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

  it("keeps unavailable active auth typed and blocks every plan without leaking config refs", async () => {
    const inspect = await inspectPairingConnectivity(
      {
        gateway: {
          bind: "loopback",
          auth: {
            mode: "token",
            token: { source: "env", provider: "missing", id: "GATEWAY_TOKEN" },
          },
        },
      },
      {
        activeAuth: "unavailable",
        networkInterfaces: () => ({}),
        runCommandWithTimeout: vi.fn(async () => ({ code: 1, stdout: "" })),
      },
    );

    expect(inspect).toMatchObject({
      auth: "unavailable",
      current: { status: "blocked", blocker: "gateway-auth-unavailable" },
    });
    for (const request of [
      { mode: "lan" as const },
      { mode: "tailscale" as const },
      { mode: "public" as const, publicUrl: "wss://gateway.example.com" },
    ]) {
      expect(planPairingConnectivity(inspect, request)).toMatchObject({
        status: "blocked",
        blocker: "gateway-auth-unavailable",
      });
    }
    expect(JSON.stringify(inspect)).not.toMatch(
      /GATEWAY_TOKEN|provider|SecretRef|bootstrapToken|setupCode|stdout|stderr/,
    );
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
