// Tailscale status tests cover status parsing and validation.
import { describe, expect, it, vi } from "vitest";
import {
  inspectTailscaleConnectivityWithRunner,
  resolveConfiguredTailscaleGatewayUrlsWithRunner,
  resolveTailnetHostWithRunner,
  resolveTailscaleServeGatewayUrlsWithRunner,
} from "./tailscale-status.js";

describe("shared/tailscale-status", () => {
  it("distinguishes an unavailable CLI without parsing diagnostics", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("redacted"), { code: "ENOENT" });
    });

    await expect(inspectTailscaleConnectivityWithRunner(18789, run)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it.each([
    ["NeedsLogin", "login-required"],
    ["NeedsMachineAuth", "login-required"],
    ["NoState", "stopped"],
    ["Stopped", "stopped"],
    ["Starting", "starting"],
  ] as const)("maps BackendState %s to %s", async (backendState, status) => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ BackendState: backendState }),
    }));

    await expect(inspectTailscaleConnectivityWithRunner(18789, run)).resolves.toEqual({
      status,
      backendState,
    });
  });

  it("reports matching private Serve and public Funnel routes separately", async () => {
    const run = vi.fn(
      async (argv: string[], _opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => ({
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
          : JSON.stringify({
              BackendState: "Running",
              Self: { DNSName: "private.tail.ts.net." },
            }),
      }),
    );

    await expect(inspectTailscaleConnectivityWithRunner(18789, run)).resolves.toEqual({
      status: "running",
      backendState: "Running",
      host: "private.tail.ts.net",
      serve: {
        status: "route-configured",
        readiness: "not-verified",
        urls: ["wss://private.tail.ts.net"],
      },
      funnel: { status: "route-configured", urls: ["wss://public.tail.ts.net:8443"] },
    });
    expect(run.mock.calls[0]?.[1]?.env?.TERM).toBeTruthy();
  });

  it.each([
    ["missing", {}, { status: "missing" }],
    [
      "unrelated",
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "other.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
          },
        },
      },
      { status: "unrelated" },
    ],
    [
      "conflicting-root",
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "node.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "127.0.0.1:9999" } },
          },
        },
      },
      { status: "conflicting-root" },
    ],
    [
      "conflicting-root",
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "node.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
          },
        },
        AllowFunnel: { "node.tail.ts.net:443": true },
      },
      { status: "conflicting-root" },
    ],
  ])("classifies persistent Serve state as %s", async (_name, serveConfig, expected) => {
    const run = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify(serveConfig)
        : JSON.stringify({ BackendState: "Running", Self: { DNSName: "node.tail.ts.net." } }),
    }));

    const inspected = await inspectTailscaleConnectivityWithRunner(18789, run);
    expect(inspected).toMatchObject({ status: "running", serve: expected });
  });

  it("reports unreadable persistent Serve state without using diagnostics", async () => {
    const run = vi.fn(async (argv: string[]) =>
      argv.includes("serve")
        ? { code: 1, stdout: "", stderr: "AuthURL=https://secret.example.test" }
        : {
            code: 0,
            stdout: JSON.stringify({
              BackendState: "Running",
              Self: { DNSName: "node.tail.ts.net." },
            }),
          },
    );

    const inspected = await inspectTailscaleConnectivityWithRunner(18789, run);
    expect(inspected).toMatchObject({
      status: "running",
      serve: { status: "unreadable" },
      funnel: { status: "unreadable" },
    });
    expect(JSON.stringify(inspected)).not.toMatch(/AuthURL|secret|stderr|stdout/);
  });

  it.each([
    [undefined, "unknown"],
    [{}, "required"],
    [{ "service-host": [{ "svc:openclaw": ["100.100.100.100"] }] }, "approved"],
    [{ "service-host": [{ "svc:other": ["100.100.100.101"] }] }, "required"],
  ] as const)("projects named-Service approval as %s", async (capMap, serviceApproval) => {
    const run = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify({
            Services: {
              "svc:openclaw": {
                TCP: { "443": { HTTPS: true } },
                Web: {
                  "openclaw.tail.ts.net:443": {
                    Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
                  },
                },
              },
            },
          })
        : JSON.stringify({
            BackendState: "Running",
            Self: {
              DNSName: "node.tail.ts.net.",
              ...(capMap === undefined ? {} : { CapMap: capMap }),
            },
          }),
    }));

    const inspected = await inspectTailscaleConnectivityWithRunner(18789, run, "svc:openclaw");
    expect(inspected).toMatchObject({
      status: "running",
      serviceApproval,
      serve: {
        status: "route-configured",
        readiness: "not-verified",
        urls: ["wss://openclaw.tail.ts.net"],
      },
    });
  });

  it("tries supported Linux, Homebrew, and macOS CLI paths without mutating host state", async () => {
    const allowed = new Set(["status --json", "serve status --json"]);
    const run = vi.fn(async (argv: string[]) => {
      expect(allowed.has(argv.slice(1).join(" "))).toBe(true);
      if (argv[0] !== "/Applications/Tailscale.app/Contents/MacOS/Tailscale") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return {
        code: 0,
        stdout: argv.includes("serve")
          ? "{}"
          : JSON.stringify({ BackendState: "Running", Self: { DNSName: "node.tail.ts.net." } }),
      };
    });

    await expect(inspectTailscaleConnectivityWithRunner(18789, run)).resolves.toMatchObject({
      status: "running",
      serve: { status: "missing" },
    });
    expect(run.mock.calls.map(([argv]) => argv[0])).toEqual([
      "tailscale",
      "/usr/local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]);
  });

  it("sorts and bounds exact persistent routes after parsing the full structured payload", async () => {
    const hosts = Array.from(
      { length: 10 },
      (_, index) => `node.tail.ts.net:${String(8443 + index)}`,
    ).toReversed();
    const run = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify({
            TCP: Object.fromEntries(hosts.map((host) => [host.split(":").at(-1), { HTTPS: true }])),
            Web: Object.fromEntries(
              hosts.map((host) => [host, { Handlers: { "/": { Proxy: "127.0.0.1:18789" } } }]),
            ),
          })
        : JSON.stringify({ BackendState: "Running", Self: { DNSName: "node.tail.ts.net." } }),
    }));

    const inspected = await inspectTailscaleConnectivityWithRunner(18789, run);
    expect(
      inspected.status === "running" && inspected.serve.status === "route-configured"
        ? inspected.serve.urls
        : [],
    ).toEqual(
      hosts
        .map((host) => `wss://${host}`)
        .toSorted()
        .slice(0, 8),
    );
  });

  it("does not infer login state from command diagnostics", async () => {
    const run = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "NeedsLogin AuthURL=https://login.example.test",
    }));

    await expect(inspectTailscaleConnectivityWithRunner(18789, run)).resolves.toEqual({
      status: "error",
    });
  });

  it("returns null when no runner is provided", async () => {
    await expect(resolveTailnetHostWithRunner()).resolves.toBeNull();
  });

  it("prefers DNS names and trims trailing dots from status json", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'noise\n{"Self":{"DNSName":"mac.tail123.ts.net.","TailscaleIPs":["100.64.0.8"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("mac.tail123.ts.net");
    expect(run).toHaveBeenCalledWith(["tailscale", "status", "--json"], {
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    });
  });

  it("falls back across command candidates and then to the first tailscale ip", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("missing binary")).mockResolvedValueOnce({
      code: 0,
      stdout: '{"Self":{"TailscaleIPs":["100.64.0.9","fd7a::1"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.9");
    expect(run).toHaveBeenNthCalledWith(2, ["/usr/local/bin/tailscale", "status", "--json"], {
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    });
  });

  it("falls back to the first tailscale ip when DNSName is blank", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '{"Self":{"DNSName":"","TailscaleIPs":["100.64.0.10","fd7a::2"]}}',
    });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.10");
  });

  it("continues to later command candidates when earlier output has no usable host", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"Self":{}}' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"Self":{"DNSName":"backup.tail.ts.net."}}',
      });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("backup.tail.ts.net");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("continues when the first candidate returns success but malformed Self data", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"Self":"bad"}' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'prefix {"Self":{"TailscaleIPs":["100.64.0.11"]}} suffix',
      });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.11");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns null for non-zero exits, blank output, or invalid json", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: null, stdout: "boom" })
      .mockResolvedValueOnce({ code: 1, stdout: "boom" })
      .mockResolvedValueOnce({ code: 0, stdout: "   " });

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBeNull();

    const invalid = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "not-json",
    });
    await expect(resolveTailnetHostWithRunner(invalid)).resolves.toBeNull();
  });

  it("finds persistent HTTPS Serve routes that proxy the gateway root", async () => {
    const serveConfig = {
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "mac.tail.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8096" } },
        },
        "mac.tail.ts.net:8443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
        },
      },
    };
    const run = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify(serveConfig)
        : JSON.stringify({ BackendState: "Running" }),
    }));

    await expect(resolveTailscaleServeGatewayUrlsWithRunner(18789, run)).resolves.toEqual([
      "wss://mac.tail.ts.net:8443",
    ]);
    expect(run).toHaveBeenCalledWith(["tailscale", "serve", "status", "--json"], {
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    });
  });

  it("ignores non-root, non-HTTPS, and non-loopback Serve handlers", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        TCP: { "80": { HTTP: true }, "443": { HTTPS: true } },
        Web: {
          "mac.tail.ts.net:80": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
          },
          "mac.tail.ts.net:443": {
            Handlers: { "/openclaw": { Proxy: "http://127.0.0.1:18789" } },
          },
          "other.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "http://192.168.1.20:18789" } },
          },
        },
      }),
    });

    await expect(resolveTailscaleServeGatewayUrlsWithRunner(18789, run)).resolves.toEqual([]);
  });

  it("ignores load-balanced Tailscale Services and public Funnel routes", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: {
          "mac.tail.ts.net:443": {
            Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
          },
        },
        AllowFunnel: { "mac.tail.ts.net:443": true },
        Services: {
          "svc:openclaw": {
            TCP: { "443": { HTTPS: true } },
            Web: {
              "openclaw.tail.ts.net:443": {
                Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
              },
            },
          },
        },
      }),
    });

    await expect(resolveTailscaleServeGatewayUrlsWithRunner(18789, run)).resolves.toEqual([]);
  });

  it("requires the configured publication mode and exact service name", async () => {
    const serveConfig = {
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "node.tail.ts.net:443": {
          Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
        },
        "public.tail.ts.net:8443": {
          Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
        },
      },
      AllowFunnel: { "public.tail.ts.net:8443": true },
      Services: {
        "svc:openclaw": {
          TCP: { "443": { HTTPS: true } },
          Web: {
            "openclaw.tail.ts.net:443": {
              Handlers: { "/": { Proxy: "127.0.0.1:18789" } },
            },
          },
        },
      },
    };
    const run = vi.fn(async (argv: string[]) => ({
      code: 0,
      stdout: argv.includes("serve")
        ? JSON.stringify(serveConfig)
        : JSON.stringify({ BackendState: "Running" }),
    }));

    await expect(
      resolveConfiguredTailscaleGatewayUrlsWithRunner({ mode: "serve", gatewayPort: 18789 }, run),
    ).resolves.toEqual(["wss://node.tail.ts.net"]);
    await expect(
      resolveConfiguredTailscaleGatewayUrlsWithRunner({ mode: "funnel", gatewayPort: 18789 }, run),
    ).resolves.toEqual(["wss://public.tail.ts.net:8443"]);
    await expect(
      resolveConfiguredTailscaleGatewayUrlsWithRunner(
        { mode: "serve", gatewayPort: 18789, serviceName: "svc:openclaw" },
        run,
      ),
    ).resolves.toEqual(["wss://openclaw.tail.ts.net"]);
    await expect(
      resolveConfiguredTailscaleGatewayUrlsWithRunner(
        { mode: "serve", gatewayPort: 18789, serviceName: "svc:wrong" },
        run,
      ),
    ).resolves.toEqual([]);
  });
});
