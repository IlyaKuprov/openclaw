// Setup-code issuance revalidates canonical connectivity immediately before minting.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { materializeGatewayAuthSecretRefs } from "../gateway/auth-config-utils.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import {
  resolvePairingSetupConnectivityFromConfig,
  type ResolvePairingSetupConnectivityOptions,
} from "./connectivity.js";

type PairingSetupPayload = {
  url: string;
  urls?: string[];
  bootstrapToken: string;
};

type ResolvePairingSetupOptions = ResolvePairingSetupConnectivityOptions & {
  pairingBaseDir?: string;
};

type PairingSetupResolution =
  | {
      ok: true;
      payload: PairingSetupPayload;
      authLabel: "token" | "password";
      urlSource: string;
      access: "full" | "limited" | "node";
      accessDowngraded: boolean;
    }
  | { ok: false; error: string };

export function encodePairingSetupCode(payload: PairingSetupPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function resolvePairingSetupFromConfig(
  cfg: OpenClawConfig,
  options: ResolvePairingSetupOptions = {},
): Promise<PairingSetupResolution> {
  assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
  const env = options.env ?? process.env;
  const cfgForAuth = await materializeGatewayAuthSecretRefs({
    cfg,
    env,
    mode: cfg.gateway?.auth?.mode,
    hasTokenOverride: false,
    hasPasswordOverride: false,
    hasTokenFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN)),
    hasPasswordFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD)),
  });
  const resolved = await resolvePairingSetupConnectivityFromConfig(cfgForAuth, options);
  if (!resolved.ok) {
    return resolved;
  }
  const [url] = resolved.urls;
  if (!url) {
    return { ok: false, error: "Gateway URL unavailable." };
  }
  const issued = await issueDeviceBootstrapToken({
    baseDir: options.pairingBaseDir,
    profile: resolved.bootstrapProfile,
  });
  return {
    ok: true,
    payload: {
      url,
      ...(resolved.urls.length > 1 ? { urls: resolved.urls } : {}),
      bootstrapToken: issued.token,
    },
    authLabel: resolved.authLabel,
    urlSource: resolved.urlSource,
    access: resolved.access,
    accessDowngraded: resolved.accessDowngraded,
  };
}
