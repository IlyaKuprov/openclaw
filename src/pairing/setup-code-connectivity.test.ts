import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateDevicePairSetupCodeResult } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(() => ({ token: "bootstrap-token" })),
}));

const { resolvePairingSetupConnectivityFromConfig } = await import("./connectivity.js");
const { encodePairingSetupCode, resolvePairingSetupFromConfig } = await import("./setup-code.js");
const { issueDeviceBootstrapToken: issueDeviceBootstrapTokenMock } =
  await import("../infra/device-bootstrap.js");

describe("pairing setup connectivity issuance", () => {
  beforeEach(() => {
    vi.mocked(issueDeviceBootstrapTokenMock).mockClear();
  });

  it("revalidates the exact Tailscale route before issuing a token", async () => {
    const serveRoute = {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "gateway.tail.ts.net:443": {
          Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
        },
      },
    };
    let serveChecks = 0;
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify(serveChecks++ === 0 ? serveRoute : {})
        : JSON.stringify({ BackendState: "Running" }),
    }));
    const config = {
      gateway: {
        tailscale: { mode: "serve" as const },
        auth: { mode: "token" as const, token: "token" },
      },
    };

    await expect(
      resolvePairingSetupConnectivityFromConfig(config, { runCommandWithTimeout }),
    ).resolves.toMatchObject({ ok: true, urls: ["wss://gateway.tail.ts.net"] });
    await expect(
      resolvePairingSetupFromConfig(config, { runCommandWithTimeout }),
    ).resolves.toMatchObject({ ok: false });
    expect(issueDeviceBootstrapTokenMock).not.toHaveBeenCalled();
  });

  it("rechecks active auth immediately before token issuance", async () => {
    const config: OpenClawConfig = {
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.10",
        auth: {
          mode: "token",
          token: { source: "env", provider: "missing", id: "GATEWAY_TOKEN" },
        },
      },
    };

    await expect(
      resolvePairingSetupFromConfig(config, {
        activeAuth: "token",
        getActiveAuth: () => "unavailable",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Gateway auth changed before setup-code issuance.",
    });
    expect(issueDeviceBootstrapTokenMock).not.toHaveBeenCalled();
  });

  it("uses resolved Gateway auth without executing the active config SecretRef", async () => {
    const config: OpenClawConfig = {
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.10",
        auth: {
          mode: "token",
          token: { source: "exec", provider: "missing", id: "GATEWAY_TOKEN" },
        },
      },
    };

    await expect(
      resolvePairingSetupFromConfig(config, {
        activeAuth: "token",
        getActiveAuth: () => "token",
      }),
    ).resolves.toMatchObject({ ok: true, authLabel: "token" });
    expect(issueDeviceBootstrapTokenMock).toHaveBeenCalledTimes(1);
  });

  it("issues a protocol-valid setup payload from the deterministic first eight routes", async () => {
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
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          tailscale: { mode: "serve" },
          auth: { mode: "token", token: "token" },
        },
      },
      { runCommandWithTimeout },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    const expectedUrls = routeHosts
      .toSorted()
      .slice(0, 8)
      .map((host) => `wss://${host.replace(":443", "")}`);
    expect(resolved.payload.urls).toEqual(expectedUrls);
    expect(
      validateDevicePairSetupCodeResult({
        setupCode: encodePairingSetupCode(resolved.payload),
        gatewayUrl: resolved.payload.url,
        gatewayUrls: resolved.payload.urls,
        auth: resolved.authLabel,
        urlSource: resolved.urlSource,
        access: resolved.access,
      }),
    ).toBe(true);
  });
});
