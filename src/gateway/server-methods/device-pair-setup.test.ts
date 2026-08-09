/**
 * Tests the device.pair.setupCode gateway method: it produces a connect setup
 * code + QR for non-terminal clients and never leaks the gateway credential.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  inspectPairingConnectivity: vi.fn(),
  planPairingConnectivity: vi.fn(),
  resolvePairingSetupFromConfig: vi.fn(),
  encodePairingSetupCode: vi.fn(),
  renderQrPngDataUrl: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveConfigSnapshotHash: vi.fn(),
  getRuntimeConfigAppliedHash: vi.fn(),
  hashRuntimeConfigValue: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveConfigSnapshotHash: mocks.resolveConfigSnapshotHash,
}));
vi.mock("../../config/runtime-snapshot.js", () => ({
  getRuntimeConfigAppliedHash: mocks.getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue: mocks.hashRuntimeConfigValue,
}));

vi.mock("../../pairing/connectivity.js", () => ({
  inspectPairingConnectivity: mocks.inspectPairingConnectivity,
  planPairingConnectivity: mocks.planPairingConnectivity,
}));

vi.mock("../../pairing/setup-code.js", () => ({
  resolvePairingSetupFromConfig: mocks.resolvePairingSetupFromConfig,
  encodePairingSetupCode: mocks.encodePairingSetupCode,
}));
vi.mock("../../media/qr-image.js", () => ({
  renderQrPngDataUrl: mocks.renderQrPngDataUrl,
}));
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

import { createCoreGatewayMethodDescriptors } from "../methods/core-descriptors.js";
import { devicePairSetupHandlers } from "./device-pair-setup.js";

function createOptions(
  params: Record<string, unknown>,
  config: Record<string, unknown> = {},
): {
  options: GatewayRequestHandlerOptions;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn();
  const options = {
    req: { type: "req", id: "req-1", method: "device.pair.setupCode", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: vi.fn(() => config),
      getResolvedAuth: vi.fn(() => ({
        mode: "token",
        token: "runtime-token",
        allowTailscale: false,
      })),
    },
  } as unknown as GatewayRequestHandlerOptions;
  return { options, respond };
}

const okResolution = {
  ok: true as const,
  payload: {
    url: "wss://gw.example:8443",
    urls: ["wss://gw.example:8443", "ws://192.168.1.20:18789"],
    bootstrapToken: "boot-123",
  },
  authLabel: "token" as const,
  urlSource: "remote",
  access: "full" as const,
  accessDowngraded: false,
};

describe("device.pair.setupCode", () => {
  beforeEach(() => {
    mocks.resolvePairingSetupFromConfig.mockReset();
    mocks.encodePairingSetupCode.mockReset();
    mocks.renderQrPngDataUrl.mockReset();
    mocks.runCommandWithTimeout.mockReset();
  });

  it("returns the setup code, QR data URL, and only an auth label", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(payload).toEqual({
      setupCode: "SETUP-CODE-XYZ",
      qrDataUrl: "data:image/png;base64,qr",
      gatewayUrl: "wss://gw.example:8443",
      gatewayUrls: ["wss://gw.example:8443", "ws://192.168.1.20:18789"],
      auth: "token",
      urlSource: "remote",
      access: "full",
    });
    // The bootstrap token only lives inside the (opaque) setup code, never as a field.
    expect(JSON.stringify(payload)).not.toContain("boot-123");
  });

  it("reports when plaintext transport limits a requested full-access code", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ...okResolution,
      access: "limited",
      accessDowngraded: true,
    });
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options, respond } = createOptions({ includeQr: false });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      access: "limited",
      accessDowngraded: true,
    });
  });

  it("preserves the configured device-pair public URL fallback", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options } = createOptions(
      {},
      {
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: " wss://gateway.example.com " } },
          },
        },
      },
    );
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ publicUrl: "wss://gateway.example.com" }),
    );
  });

  it("labels an explicit request URL separately from configured fallback", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options, respond } = createOptions({ publicUrl: "wss://request.example.com" });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ publicUrl: "wss://request.example.com" }),
    );
    expect(respond.mock.calls[0]?.[1]?.urlSource).toBe("request.publicUrl");
  });

  it("prefers the remote URL over the configured device-pair fallback", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options } = createOptions(
      { preferRemoteUrl: true },
      {
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: "wss://plugin.example.com" } },
          },
        },
      },
    );
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ publicUrl: undefined, preferRemoteUrl: true }),
    );
  });

  it("omits the QR when includeQr is false", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options, respond } = createOptions({ includeQr: false });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.renderQrPngDataUrl).not.toHaveBeenCalled();
    const [ok, payload] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(payload.qrDataUrl).toBeUndefined();
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
  });

  it("requests a node-only bootstrap profile for companion setup", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options } = createOptions({ includeQr: false, bootstrapProfile: "node" });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        bootstrapProfile: { roles: ["node"], scopes: [] },
      }),
    );
  });

  it("requests the limited mobile bootstrap profile when selected", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options } = createOptions({ includeQr: false, bootstrapProfile: "limited" });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        bootstrapProfile: {
          roles: ["node", "operator"],
          scopes: [
            "operator.approvals",
            "operator.questions",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
        },
      }),
    );
  });

  it("omits an oversized QR but still returns the setup code", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    // Exceed the result schema's qrDataUrl bound (16_384) so the response stays valid.
    mocks.renderQrPngDataUrl.mockResolvedValue(`data:image/png;base64,${"a".repeat(20_000)}`);

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok, payload] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(payload.qrDataUrl).toBeUndefined();
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
  });

  it("responds with an invalid-request error when setup cannot be resolved", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ok: false,
      error: "Gateway auth is not configured (no token or password).",
    });

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok, payload, error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain("Gateway auth is not configured");
    expect(mocks.encodePairingSetupCode).not.toHaveBeenCalled();
  });

  it("rejects unknown params before touching pairing helpers", async () => {
    const { options, respond } = createOptions({ bogus: true });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok] = expectDefined(respond.mock.calls[0], "respond.mock.calls[0] test invariant");
    expect(ok).toBe(false);
    expect(mocks.resolvePairingSetupFromConfig).not.toHaveBeenCalled();
  });

  it("keeps the setup code when optional QR rendering throws", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockRejectedValue(new Error("qr boom"));

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok, payload, error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
    expect(payload.qrDataUrl).toBeUndefined();
    expect(error).toBeUndefined();
  });
});

describe("device pairing connectivity preflight", () => {
  beforeEach(() => {
    mocks.inspectPairingConnectivity.mockReset();
    mocks.planPairingConnectivity.mockReset();
    mocks.resolvePairingSetupFromConfig.mockReset();
    mocks.encodePairingSetupCode.mockReset();
    mocks.renderQrPngDataUrl.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({ sourceConfig: {}, raw: null });
    mocks.resolveConfigSnapshotHash.mockReturnValue(null);
    mocks.getRuntimeConfigAppliedHash.mockReturnValue(null);
    mocks.hashRuntimeConfigValue.mockReturnValue("persisted-semantic-hash");
  });

  it("registers read-only admin methods without advertising them", () => {
    const descriptors = createCoreGatewayMethodDescriptors(devicePairSetupHandlers);
    for (const name of ["device.pair.connectivity.inspect", "device.pair.connectivity.plan"]) {
      expect(descriptors.find((descriptor) => descriptor.name === name)).toMatchObject({
        scope: "operator.admin",
        advertise: false,
      });
    }
  });

  it("returns typed inspect facts without issuing a setup code", async () => {
    const result = {
      configState: "pending",
      auth: "token",
      current: { status: "blocked", blocker: "route-unavailable" },
      lan: { status: "unavailable" },
      tailscale: { status: "unavailable" },
      publicUrl: { status: "not-configured" },
    };
    mocks.inspectPairingConnectivity.mockResolvedValue(result);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      sourceConfig: { gateway: { bind: "loopback" } },
      hash: "a".repeat(64),
    });
    mocks.resolveConfigSnapshotHash.mockReturnValue("a".repeat(64));
    mocks.getRuntimeConfigAppliedHash.mockReturnValue("active-semantic-hash");

    const activeConfig = { gateway: { bind: "lan", auth: { mode: "token", token: "secret" } } };
    const { options, respond } = createOptions({}, activeConfig);
    await expectDefined(
      devicePairSetupHandlers["device.pair.connectivity.inspect"],
      'devicePairSetupHandlers["device.pair.connectivity.inspect"] test invariant',
    )(options);

    expect(respond).toHaveBeenCalledWith(true, result, undefined);
    expect(mocks.inspectPairingConnectivity).toHaveBeenCalledWith(
      activeConfig,
      expect.objectContaining({ configHash: "a".repeat(64), configState: "pending" }),
    );
    expect(options.context.getRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(options.context.getResolvedAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePairingSetupFromConfig).not.toHaveBeenCalled();
    expect(mocks.encodePairingSetupCode).not.toHaveBeenCalled();
    expect(mocks.renderQrPngDataUrl).not.toHaveBeenCalled();
  });

  it("plans from a fresh inspection without issuing a setup code", async () => {
    const inspected = {
      configState: "pending",
      auth: "token",
      current: { status: "blocked", blocker: "route-unavailable" },
      lan: { status: "available", url: "ws://192.168.1.20:18789", requiresGatewayChange: true },
      tailscale: { status: "unavailable" },
      publicUrl: { status: "not-configured" },
    };
    const planned = {
      status: "confirmation-required",
      mode: "lan",
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
    mocks.inspectPairingConnectivity.mockResolvedValue(inspected);
    mocks.planPairingConnectivity.mockReturnValue(planned);

    const activeConfig = { gateway: { bind: "loopback" } };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      sourceConfig: { gateway: { bind: "lan" } },
      raw: "{}",
    });
    mocks.getRuntimeConfigAppliedHash.mockReturnValue("active-semantic-hash");
    const { options, respond } = createOptions({ mode: "lan" }, activeConfig);
    await expectDefined(
      devicePairSetupHandlers["device.pair.connectivity.plan"],
      'devicePairSetupHandlers["device.pair.connectivity.plan"] test invariant',
    )(options);

    expect(mocks.planPairingConnectivity).toHaveBeenCalledWith(inspected, { mode: "lan" });
    expect(mocks.inspectPairingConnectivity).toHaveBeenCalledWith(
      activeConfig,
      expect.objectContaining({ configState: "pending" }),
    );
    expect(options.context.getRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(options.context.getResolvedAuth).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, planned, undefined);
    expect(mocks.resolvePairingSetupFromConfig).not.toHaveBeenCalled();
  });

  it("uses the same active config contract for inspection and setup issuance", async () => {
    const activeConfig = {
      gateway: { bind: "lan", auth: { mode: "token", token: "secret" } },
    };
    const inspected = {
      configState: "applied",
      auth: "token",
      current: { status: "ready", urls: ["ws://192.168.1.20:18789"] },
      lan: { status: "available", url: "ws://192.168.1.20:18789", requiresGatewayChange: false },
      tailscale: { status: "unavailable" },
      publicUrl: { status: "not-configured" },
    };
    mocks.inspectPairingConnectivity.mockResolvedValue(inspected);
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.readConfigFileSnapshot.mockResolvedValue({ sourceConfig: activeConfig, raw: "{}" });
    mocks.getRuntimeConfigAppliedHash.mockReturnValue("active-semantic-hash");
    mocks.hashRuntimeConfigValue.mockReturnValue("active-semantic-hash");

    const inspectRequest = createOptions({}, activeConfig);
    await expectDefined(
      devicePairSetupHandlers["device.pair.connectivity.inspect"],
      'devicePairSetupHandlers["device.pair.connectivity.inspect"] test invariant',
    )(inspectRequest.options);
    const setupRequest = createOptions({ includeQr: false }, activeConfig);
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(setupRequest.options);

    expect(mocks.inspectPairingConnectivity).toHaveBeenCalledWith(activeConfig, expect.any(Object));
    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      activeConfig,
      expect.any(Object),
    );
    expect(inspectRequest.options.context.getRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(inspectRequest.options.context.getResolvedAuth).toHaveBeenCalledTimes(1);
    expect(setupRequest.options.context.getRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(setupRequest.options.context.getResolvedAuth).toHaveBeenCalledTimes(1);
  });

  it("uses the latest resolved active auth without inspecting SecretRefs", async () => {
    const activeConfig = {
      gateway: {
        bind: "lan",
        auth: {
          mode: "token",
          token: { source: "env", provider: "missing", id: "GATEWAY_TOKEN" },
          password: { source: "env", provider: "missing", id: "INACTIVE_PASSWORD" },
        },
      },
    };
    mocks.inspectPairingConnectivity.mockResolvedValue({
      configState: "pending",
      auth: "token",
      current: { status: "blocked", blocker: "route-unavailable" },
      lan: { status: "unavailable" },
      tailscale: { status: "unavailable" },
      publicUrl: { status: "not-configured" },
    });
    const { options } = createOptions({}, activeConfig);
    const getResolvedAuth = vi.mocked(options.context.getResolvedAuth);
    getResolvedAuth
      .mockReturnValueOnce({ mode: "token", token: "active-token", allowTailscale: false })
      .mockReturnValueOnce({ mode: "token", token: "rotated-token", allowTailscale: false });

    const inspect = expectDefined(
      devicePairSetupHandlers["device.pair.connectivity.inspect"],
      'devicePairSetupHandlers["device.pair.connectivity.inspect"] test invariant',
    );
    await inspect(options);
    await inspect(options);

    expect(mocks.inspectPairingConnectivity).toHaveBeenNthCalledWith(
      1,
      activeConfig,
      expect.objectContaining({ activeAuth: "token" }),
    );
    expect(mocks.inspectPairingConnectivity).toHaveBeenNthCalledWith(
      2,
      activeConfig,
      expect.objectContaining({ activeAuth: "token" }),
    );
    expect(getResolvedAuth).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.inspectPairingConnectivity.mock.calls)).not.toMatch(
      /active-token|rotated-token/,
    );
  });

  it("blocks setup before mint when the selected active auth is unavailable", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ok: false,
      error: "Gateway auth is not configured.",
    });
    const { options, respond } = createOptions(
      { includeQr: false },
      {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "missing", id: "GATEWAY_TOKEN" },
          },
        },
      },
    );
    vi.mocked(options.context.getResolvedAuth).mockReturnValue({
      mode: "token",
      allowTailscale: false,
    });

    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ activeAuth: "unavailable" }),
    );
    expect(mocks.encodePairingSetupCode).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  });
});
