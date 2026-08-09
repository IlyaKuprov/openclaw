import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveConnectivity: vi.fn(),
  issueToken: vi.fn(),
}));

vi.mock("./connectivity.js", () => ({
  resolvePairingSetupConnectivityFromConfig: mocks.resolveConnectivity,
}));
vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: mocks.issueToken,
}));

const { resolvePairingSetupFromConfig } = await import("./setup-code.js");

describe("pairing setup issuance", () => {
  it("does not issue a token when connectivity has no usable URL", async () => {
    mocks.resolveConnectivity.mockResolvedValue({
      ok: true,
      urls: [],
      authLabel: "token",
      urlSource: "manual",
      access: "full",
      accessDowngraded: false,
      bootstrapProfile: { roles: ["operator"], scopes: ["operator.admin"] },
    });

    await expect(
      resolvePairingSetupFromConfig(
        { gateway: { auth: { mode: "token", token: "configured" } } },
        { env: {} },
      ),
    ).resolves.toEqual({ ok: false, error: "Gateway URL unavailable." });
    expect(mocks.issueToken).not.toHaveBeenCalled();
  });
});
