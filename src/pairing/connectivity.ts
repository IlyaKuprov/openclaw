// Pairing connectivity owns route, transport, and access planning before token issuance.
import os from "node:os";
import {
  isCarrierGradeNatIpv4Address,
  isIpv4Address,
  isIpv6Address,
  isLoopbackIpAddress,
  isRfc1918Ipv4Address,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import {
  assertExplicitGatewayAuthModeWhenBothConfigured,
  hasAmbiguousGatewayAuthModeConfig,
} from "../gateway/auth-mode-policy.js";
import { resolveAdvertisedLanHost } from "../infra/advertised-lan-host.js";
import {
  pickMatchingExternalInterfaceAddress,
  safeNetworkInterfaces,
} from "../infra/network-interfaces.js";
import {
  deviceBootstrapProfilesEqual,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
import { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
import {
  inspectTailscaleConnectivityWithRunner,
  resolveTailnetHostWithRunner,
  resolveTailscalePublishedHost,
  resolveTailscaleServeGatewayUrlsWithRunner,
  type TailscaleConnectivityInspection,
} from "../shared/tailscale-status.js";

export type PairingConnectivityMode = "lan" | "tailscale" | "public";
export type PairingConnectivityAuth = "token" | "password" | "missing" | "invalid";
export type PairingSetupAccess = "full" | "limited" | "node";
export type PairingConnectivityBlocker =
  | "gateway-auth-required"
  | "gateway-auth-invalid"
  | "route-unavailable"
  | "route-insecure"
  | "lan-unavailable"
  | "tailscale-unavailable"
  | "tailscale-login-required"
  | "tailscale-not-running"
  | "tailscale-starting"
  | "tailscale-status-error"
  | "tailscale-serve-required"
  | "public-url-required"
  | "public-url-invalid"
  | "public-url-insecure";
export type PairingConnectivityChange =
  | "expose-gateway-on-local-network"
  | "enable-tailscale-serve";
export type PairingConnectivityExposure =
  | "same-host"
  | "local-network"
  | "tailnet"
  | "public-internet";
export type PairingConnectivitySource =
  | "manual"
  | "remote"
  | "tailscale-serve"
  | "tailscale-funnel"
  | "lan"
  | "tailnet"
  | "custom";

export type PairingConnectivityCommandResult = {
  code: number | null;
  stdout: string;
  errorCode?: string;
};

export type PairingConnectivityCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv },
) => Promise<PairingConnectivityCommandResult>;

type PairingConnectivityReadyRoute = {
  status: "ready";
  urls: string[];
  source: PairingConnectivitySource;
  exposure: PairingConnectivityExposure;
  access: PairingSetupAccess;
  accessDowngraded: boolean;
};

export type PairingConnectivityInspection = {
  configHash?: string;
  auth: PairingConnectivityAuth;
  current:
    | PairingConnectivityReadyRoute
    | { status: "blocked"; blocker: PairingConnectivityBlocker };
  lan:
    | { status: "available"; url: string; requiresGatewayChange: boolean }
    | { status: "unavailable" };
  tailscale: TailscaleConnectivityInspection;
  publicUrl:
    | { status: "ready"; url: string }
    | { status: "not-configured" }
    | { status: "invalid" };
};

export type PairingConnectivityPlan =
  | {
      status: "blocked";
      mode: PairingConnectivityMode;
      configHash?: string;
      auth: PairingConnectivityAuth;
      blocker: PairingConnectivityBlocker;
      changes: PairingConnectivityChange[];
    }
  | {
      status: "confirmation-required";
      mode: PairingConnectivityMode;
      configHash?: string;
      urls: string[];
      exposure: PairingConnectivityExposure;
      auth: "token" | "password";
      access: PairingSetupAccess;
      accessDowngraded: boolean;
      changes: PairingConnectivityChange[];
      restartRequired: boolean;
      preservesCurrentRoute: boolean;
    };

export type PairingSetupConnectivityResolution =
  | {
      ok: true;
      urls: string[];
      authLabel: "token" | "password";
      urlSource: string;
      access: PairingSetupAccess;
      accessDowngraded: boolean;
      bootstrapProfile: DeviceBootstrapProfileInput;
    }
  | { ok: false; error: string };

export type ResolvePairingSetupConnectivityOptions = {
  env?: NodeJS.ProcessEnv;
  publicUrl?: string;
  preferRemoteUrl?: boolean;
  forceSecure?: boolean;
  bootstrapProfile?: DeviceBootstrapProfileInput;
  runCommandWithTimeout?: PairingConnectivityCommandRunner;
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
};

const PAIRING_SETUP_MAX_URLS = 8;
const GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE = /^(?:https?|wss?):(?!\/\/)/i;
const SCHEME_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\//;

function normalizeMobilePairingHost(host: string): string {
  let normalized = normalizeLowercaseStringOrEmpty(host);
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  const zoneIndex = normalized.indexOf("%");
  return zoneIndex >= 0 ? normalized.slice(0, zoneIndex) : normalized;
}

function isPrivateLanHost(host: string): boolean {
  const normalized = normalizeMobilePairingHost(host);
  if (normalized.endsWith(".local") || isRfc1918Ipv4Address(normalized)) {
    return true;
  }
  const parsed = parseCanonicalIpAddress(normalized);
  if (!parsed) {
    return false;
  }
  if (isIpv4Address(parsed)) {
    const normalizedIp = parsed.toString();
    return normalizedIp.startsWith("169.254.") && !isCarrierGradeNatIpv4Address(normalizedIp);
  }
  if (!isIpv6Address(parsed)) {
    return false;
  }
  const normalizedIp = normalizeLowercaseStringOrEmpty(parsed.toString());
  return (
    normalizedIp.startsWith("fe80:") ||
    normalizedIp.startsWith("fc") ||
    normalizedIp.startsWith("fd")
  );
}

function isMobilePairingCleartextAllowedHost(host: string): boolean {
  const normalized = normalizeMobilePairingHost(host);
  return (
    normalized === "localhost" ||
    isLoopbackIpAddress(normalized) ||
    normalized === "10.0.2.2" ||
    isPrivateLanHost(normalized)
  );
}

function isFullAccessMobilePairingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = normalizeMobilePairingHost(parsed.hostname);
    return (
      parsed.protocol === "wss:" ||
      (parsed.protocol === "ws:" && (host === "localhost" || isLoopbackIpAddress(host)))
    );
  } catch {
    return false;
  }
}

function describeSecureMobilePairingFix(source?: string): string {
  const sourceNote = source ? ` Resolved source: ${source}.` : "";
  return (
    "Tailscale and public mobile pairing require a secure gateway URL (wss://) or Tailscale Serve/Funnel." +
    sourceNote +
    " Fix: use a private LAN address, prefer gateway.tailscale.mode=serve, or set " +
    "gateway.remote.url / plugins.entries.device-pair.config.publicUrl to a wss:// URL. " +
    "ws:// is only valid for localhost, private LAN addresses, .local hosts, or the Android emulator."
  );
}

function validateMobilePairingUrl(url: string, source?: string): string | null {
  try {
    const parsed = new URL(url);
    const protocol =
      parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
    return protocol === "wss:" ||
      (protocol === "ws:" && isMobilePairingCleartextAllowedHost(parsed.hostname))
      ? null
      : describeSecureMobilePairingFix(source);
  } catch {
    return "Resolved mobile pairing URL is invalid.";
  }
}

function parseNormalizedGatewayUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || !parsed.hostname) {
      return null;
    }
    const scheme = parsed.protocol.slice(0, -1);
    const normalizedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
    if (normalizedScheme !== "ws" && normalizedScheme !== "wss") {
      return null;
    }
    return `${normalizedScheme}://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

function normalizeUrl(raw: string, schemeFallback: "ws" | "wss"): string | null {
  const trimmed = raw.trim();
  if (!trimmed || GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE.test(trimmed)) {
    return null;
  }
  const parsed = parseNormalizedGatewayUrl(trimmed);
  if (parsed) {
    return parsed;
  }
  if (trimmed.includes("://") || SCHEME_LIKE_PATH_RE.test(trimmed)) {
    return null;
  }
  const hostPort = normalizeOptionalString(trimmed.split("/", 1)[0]) ?? "";
  return hostPort ? parseNormalizedGatewayUrl(`${schemeFallback}://${hostPort}`) : null;
}

function normalizeOperatorPublicUrl(
  raw: string | undefined,
):
  | { ok: true; url: string }
  | { ok: false; blocker: "public-url-required" | "public-url-invalid" | "public-url-insecure" } {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return { ok: false, blocker: "public-url-required" };
  }
  const authorityStart = trimmed.indexOf("://") + 3;
  if (authorityStart < 3 || /[/?#]/.test(trimmed.slice(authorityStart))) {
    return { ok: false, blocker: "public-url-invalid" };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "wss:") {
      return { ok: false, blocker: "public-url-insecure" };
    }
    if (
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      return { ok: false, blocker: "public-url-invalid" };
    }
    return {
      ok: true,
      url: `wss://${parsed.hostname}${parsed.port && parsed.port !== "443" ? `:${parsed.port}` : ""}`,
    };
  } catch {
    return { ok: false, blocker: "public-url-invalid" };
  }
}

function resolveScheme(cfg: OpenClawConfig, forceSecure?: boolean): "ws" | "wss" {
  return forceSecure || cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}

function resolvePairingSetupAccess(profile: DeviceBootstrapProfileInput): PairingSetupAccess {
  if (deviceBootstrapProfilesEqual(profile, FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE)) {
    return "full";
  }
  return deviceBootstrapProfilesEqual(profile, NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE)
    ? "node"
    : "limited";
}

function resolvePairingAuth(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): PairingConnectivityAuth {
  if (hasAmbiguousGatewayAuthModeConfig(cfg)) {
    return "invalid";
  }
  const mode = cfg.gateway?.auth?.mode;
  const defaults = cfg.secrets?.defaults;
  const tokenRef = resolveSecretInputRef({ value: cfg.gateway?.auth?.token, defaults }).ref;
  const passwordRef = resolveSecretInputRef({ value: cfg.gateway?.auth?.password, defaults }).ref;
  const envToken = Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN));
  const envPassword = Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD));
  const token = Boolean(tokenRef) || Boolean(normalizeSecretInputString(cfg.gateway?.auth?.token));
  const password =
    Boolean(passwordRef) || Boolean(normalizeSecretInputString(cfg.gateway?.auth?.password));
  if (mode === "token") {
    return envToken || token ? "token" : "missing";
  }
  if (mode === "password") {
    return envPassword || password ? "password" : "missing";
  }
  if (envToken) {
    return "token";
  }
  if (envPassword) {
    return "password";
  }
  return token ? "token" : password ? "password" : "missing";
}

function pickTailnetIpv4(networkInterfaces: () => ReturnType<typeof os.networkInterfaces>) {
  return (
    pickMatchingExternalInterfaceAddress(safeNetworkInterfaces(networkInterfaces), {
      family: "IPv4",
      matches: isCarrierGradeNatIpv4Address,
    }) ?? null
  );
}

async function resolveGatewayUrl(
  cfg: OpenClawConfig,
  opts: Required<Pick<ResolvePairingSetupConnectivityOptions, "env" | "networkInterfaces">> &
    Omit<ResolvePairingSetupConnectivityOptions, "env" | "networkInterfaces" | "bootstrapProfile">,
): Promise<{ url?: string; source?: string; error?: string }> {
  const scheme = resolveScheme(cfg, opts.forceSecure);
  const port = resolveGatewayPort(cfg, opts.env);
  if (normalizeOptionalString(opts.publicUrl)) {
    const url = normalizeUrl(opts.publicUrl ?? "", scheme);
    return url
      ? { url, source: "plugins.entries.device-pair.config.publicUrl" }
      : { error: "Configured publicUrl is invalid." };
  }
  const remoteRaw = normalizeOptionalString(cfg.gateway?.remote?.url);
  const remoteUrl = remoteRaw ? normalizeUrl(remoteRaw, scheme) : null;
  if (remoteRaw && !remoteUrl) {
    return { error: "Configured gateway.remote.url is invalid." };
  }
  if (opts.preferRemoteUrl && remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const host = await resolveTailnetHostWithRunner(opts.runCommandWithTimeout);
    if (!host) {
      return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
    }
    const publishedHost = resolveTailscalePublishedHost({
      tailscaleMode,
      tailnetHost: host,
      serviceName: cfg.gateway?.tailscale?.serviceName,
    });
    return publishedHost
      ? { url: `wss://${publishedHost}`, source: `gateway.tailscale.mode=${tailscaleMode}` }
      : {
          error:
            "Tailscale Serve serviceName is configured, but Service MagicDNS could not be derived.",
        };
  }
  if (remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }
  const advertisedLanHost =
    cfg.gateway?.bind === "lan"
      ? await resolveAdvertisedLanHost({
          networkInterfaces: opts.networkInterfaces,
          runCommandWithTimeout: opts.runCommandWithTimeout,
        })
      : null;
  const bindResult = resolveGatewayBindUrl({
    bind: cfg.gateway?.bind,
    customBindHost: cfg.gateway?.customBindHost,
    scheme,
    port,
    pickTailnetHost: () => pickTailnetIpv4(opts.networkInterfaces),
    pickLanHost: () => advertisedLanHost,
  });
  return (
    bindResult ?? {
      error:
        "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
    }
  );
}

function exposureForRoute(url: string, source: string): PairingConnectivityExposure {
  if (source === "gateway.bind=lan") {
    return "local-network";
  }
  if (source === "gateway.bind=tailnet" || source === "gateway.tailscale.mode=serve") {
    return "tailnet";
  }
  if (source === "gateway.tailscale.mode=funnel" || source === "gateway.remote.url") {
    return "public-internet";
  }
  try {
    const parsed = new URL(url);
    const host = normalizeMobilePairingHost(parsed.hostname);
    if (host === "localhost" || isLoopbackIpAddress(host)) {
      return "same-host";
    }
    return isPrivateLanHost(host) ? "local-network" : "public-internet";
  } catch {
    return "public-internet";
  }
}

function semanticSource(source: string): PairingConnectivitySource {
  if (source === "gateway.remote.url") {
    return "remote";
  }
  if (source === "gateway.tailscale.mode=serve") {
    return "tailscale-serve";
  }
  if (source === "gateway.tailscale.mode=funnel") {
    return "tailscale-funnel";
  }
  if (source === "gateway.bind=lan") {
    return "lan";
  }
  if (source === "gateway.bind=tailnet") {
    return "tailnet";
  }
  if (source === "gateway.bind=custom") {
    return "custom";
  }
  return "manual";
}

export async function resolvePairingSetupConnectivityFromConfig(
  cfg: OpenClawConfig,
  options: ResolvePairingSetupConnectivityOptions = {},
): Promise<PairingSetupConnectivityResolution> {
  assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
  const env = options.env ?? process.env;
  const auth = resolvePairingAuth(cfg, env);
  if (auth === "invalid") {
    return { ok: false, error: "Gateway auth mode is ambiguous." };
  }
  if (auth === "missing") {
    return { ok: false, error: "Gateway auth is not configured (no token or password)." };
  }
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces;
  const route = await resolveGatewayUrl(cfg, { ...options, env, networkInterfaces });
  if (!route.url) {
    return { ok: false, error: route.error ?? "Gateway URL unavailable." };
  }
  const routeError = validateMobilePairingUrl(route.url, route.source);
  if (routeError) {
    return { ok: false, error: routeError };
  }
  const urls = [route.url];
  if (route.source === "gateway.bind=lan") {
    for (const url of await resolveTailscaleServeGatewayUrlsWithRunner(
      resolveGatewayPort(cfg, env),
      options.runCommandWithTimeout,
    )) {
      if (!validateMobilePairingUrl(url, "tailscale serve status")) {
        urls.push(url);
      }
    }
  }
  const uniqueUrls = [...new Set(urls)].slice(0, PAIRING_SETUP_MAX_URLS);
  const requestedProfile = options.bootstrapProfile ?? FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE;
  const accessDowngraded =
    deviceBootstrapProfilesEqual(requestedProfile, FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE) &&
    uniqueUrls.some((url) => !isFullAccessMobilePairingUrl(url));
  const bootstrapProfile = accessDowngraded ? PAIRING_SETUP_BOOTSTRAP_PROFILE : requestedProfile;
  return {
    ok: true,
    urls: uniqueUrls,
    authLabel: auth,
    urlSource: route.source ?? "unknown",
    access: resolvePairingSetupAccess(bootstrapProfile),
    accessDowngraded,
    bootstrapProfile,
  };
}

function currentBlocker(error: string | undefined): PairingConnectivityBlocker {
  return error?.includes("secure gateway URL") ? "route-insecure" : "route-unavailable";
}

export async function inspectPairingConnectivity(
  cfg: OpenClawConfig,
  options: {
    configHash?: string;
    configuredPublicUrl?: string;
    env?: NodeJS.ProcessEnv;
    runCommandWithTimeout?: PairingConnectivityCommandRunner;
    networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
  } = {},
): Promise<PairingConnectivityInspection> {
  const env = options.env ?? process.env;
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces;
  const auth = resolvePairingAuth(cfg, env);
  const port = resolveGatewayPort(cfg, env);
  const [currentResolution, lanHost, tailscale] = await Promise.all([
    resolvePairingSetupConnectivityFromConfig(cfg, {
      env,
      publicUrl: options.configuredPublicUrl,
      runCommandWithTimeout: options.runCommandWithTimeout,
      networkInterfaces,
    }).catch(() => ({ ok: false as const, error: "invalid" })),
    resolveAdvertisedLanHost({
      networkInterfaces,
      runCommandWithTimeout: options.runCommandWithTimeout,
    }),
    inspectTailscaleConnectivityWithRunner(port, options.runCommandWithTimeout),
  ]);
  const configuredPublic = normalizeOptionalString(options.configuredPublicUrl);
  const strictPublic = configuredPublic ? normalizeOperatorPublicUrl(configuredPublic) : undefined;
  const current =
    currentResolution.ok && auth !== "missing" && auth !== "invalid"
      ? {
          status: "ready" as const,
          urls: currentResolution.urls,
          source: semanticSource(currentResolution.urlSource),
          exposure: exposureForRoute(currentResolution.urls[0] ?? "", currentResolution.urlSource),
          access: currentResolution.access,
          accessDowngraded: currentResolution.accessDowngraded,
        }
      : {
          status: "blocked" as const,
          blocker:
            auth === "missing"
              ? ("gateway-auth-required" as const)
              : auth === "invalid"
                ? ("gateway-auth-invalid" as const)
                : currentBlocker(currentResolution.ok ? undefined : currentResolution.error),
        };
  return {
    ...(options.configHash ? { configHash: options.configHash } : {}),
    auth,
    current,
    lan: lanHost
      ? {
          status: "available",
          url: `${resolveScheme(cfg)}://${lanHost}:${port}`,
          requiresGatewayChange: cfg.gateway?.bind !== "lan",
        }
      : { status: "unavailable" },
    tailscale,
    publicUrl: !configuredPublic
      ? { status: "not-configured" }
      : strictPublic?.ok
        ? { status: "ready", url: strictPublic.url }
        : { status: "invalid" },
  };
}

function blockedPlan(
  inspect: PairingConnectivityInspection,
  mode: PairingConnectivityMode,
  blocker: PairingConnectivityBlocker,
  changes: PairingConnectivityChange[] = [],
): PairingConnectivityPlan {
  return {
    status: "blocked",
    mode,
    ...(inspect.configHash ? { configHash: inspect.configHash } : {}),
    auth: inspect.auth,
    blocker,
    changes,
  };
}

export function planPairingConnectivity(
  inspect: PairingConnectivityInspection,
  request: { mode: PairingConnectivityMode; publicUrl?: string },
): PairingConnectivityPlan {
  if (inspect.auth === "missing" || inspect.auth === "invalid") {
    return blockedPlan(
      inspect,
      request.mode,
      inspect.auth === "missing" ? "gateway-auth-required" : "gateway-auth-invalid",
    );
  }
  let urls: string[];
  let exposure: PairingConnectivityExposure;
  let changes: PairingConnectivityChange[] = [];
  let restartRequired = false;
  if (request.mode === "lan") {
    if (inspect.lan.status !== "available") {
      return blockedPlan(inspect, request.mode, "lan-unavailable");
    }
    urls = [inspect.lan.url];
    exposure = "local-network";
    if (inspect.lan.requiresGatewayChange) {
      changes = ["expose-gateway-on-local-network"];
      restartRequired = true;
    }
  } else if (request.mode === "tailscale") {
    const tailscale = inspect.tailscale;
    if (tailscale.status === "unavailable") {
      return blockedPlan(inspect, request.mode, "tailscale-unavailable");
    }
    if (tailscale.status === "login-required") {
      return blockedPlan(inspect, request.mode, "tailscale-login-required");
    }
    if (tailscale.status === "stopped") {
      return blockedPlan(inspect, request.mode, "tailscale-not-running");
    }
    if (tailscale.status === "starting") {
      return blockedPlan(inspect, request.mode, "tailscale-starting");
    }
    if (tailscale.status === "error") {
      return blockedPlan(inspect, request.mode, "tailscale-status-error");
    }
    if (tailscale.serve.status !== "ready") {
      return blockedPlan(inspect, request.mode, "tailscale-serve-required", [
        "enable-tailscale-serve",
      ]);
    }
    urls = tailscale.serve.urls;
    exposure = "tailnet";
  } else {
    const publicUrl = normalizeOperatorPublicUrl(request.publicUrl);
    if (!publicUrl.ok) {
      return blockedPlan(inspect, request.mode, publicUrl.blocker);
    }
    urls = [publicUrl.url];
    exposure = "public-internet";
  }
  const accessDowngraded = urls.some((url) => !isFullAccessMobilePairingUrl(url));
  return {
    status: "confirmation-required",
    mode: request.mode,
    ...(inspect.configHash ? { configHash: inspect.configHash } : {}),
    urls,
    exposure,
    auth: inspect.auth,
    access: accessDowngraded ? "limited" : "full",
    accessDowngraded,
    changes,
    restartRequired,
    preservesCurrentRoute: !restartRequired,
  };
}
