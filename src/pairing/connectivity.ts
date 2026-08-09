// Pairing connectivity owns route, transport, and access planning before token issuance.
import os from "node:os";
import { isCarrierGradeNatIpv4Address } from "@openclaw/net-policy/ip";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
  isFullAccessPairingConnectivityUrl,
  isPairingCleartextAllowedHost,
  isPrivatePairingLanHost,
  normalizePairingConnectivityHost,
  projectPairingConnectivityUrls,
} from "../shared/pairing-connectivity-urls.js";
import {
  inspectTailscaleConnectivityWithRunner,
  resolveConfiguredTailscaleGatewayUrlsWithRunner,
  selectTailscaleGatewayUrls,
  type TailscaleConnectivityInspection,
} from "../shared/tailscale-status.js";

type PairingConnectivityMode = "lan" | "tailscale" | "public";
export type PairingConnectivityAuth = "token" | "password" | "missing" | "unavailable" | "invalid";
type PairingConnectivityConfigState = "applied" | "pending" | "unknown";
type PairingSetupAccess = "full" | "limited" | "node";
type PairingConnectivityBlocker =
  | "gateway-auth-required"
  | "gateway-auth-unavailable"
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
type PairingConnectivityChange = "expose-gateway-on-local-network" | "enable-tailscale-serve";
type PairingConnectivityExposure = "same-host" | "local-network" | "tailnet" | "public-internet";
type PairingConnectivitySource =
  | "manual"
  | "remote"
  | "tailscale-serve"
  | "tailscale-funnel"
  | "lan"
  | "tailnet"
  | "custom";

type PairingConnectivityCommandResult = {
  code: number | null;
  stdout: string;
  errorCode?: string;
};

type PairingConnectivityCommandRunner = (
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

type PairingConnectivityInspection = {
  configHash?: string;
  configState: PairingConnectivityConfigState;
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

type PairingConnectivityPlan =
  | {
      status: "blocked";
      mode: PairingConnectivityMode;
      configHash?: string;
      configState: PairingConnectivityConfigState;
      auth: PairingConnectivityAuth;
      blocker: PairingConnectivityBlocker;
      changes: PairingConnectivityChange[];
    }
  | {
      status: "confirmation-required";
      mode: PairingConnectivityMode;
      configHash?: string;
      configState: PairingConnectivityConfigState;
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

type InternalPairingConnectivityOptions = ResolvePairingSetupConnectivityOptions & {
  activeAuth?: PairingConnectivityAuth;
};

const GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE = /^(?:https?|wss?):(?!\/\/)/i;
const SCHEME_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\//;

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
      (protocol === "ws:" && isPairingCleartextAllowedHost(parsed.hostname))
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
): Promise<{ url?: string; urls?: string[]; source?: string; error?: string }> {
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
    const urls = await resolveConfiguredTailscaleGatewayUrlsWithRunner(
      {
        mode: tailscaleMode,
        gatewayPort: port,
        ...(tailscaleMode === "serve" && cfg.gateway?.tailscale?.serviceName
          ? { serviceName: cfg.gateway.tailscale.serviceName }
          : {}),
      },
      opts.runCommandWithTimeout,
    );
    return urls[0]
      ? { url: urls[0], urls, source: `gateway.tailscale.mode=${tailscaleMode}` }
      : { error: `Configured Tailscale ${tailscaleMode} route is not available.` };
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
    const host = normalizePairingConnectivityHost(parsed.hostname);
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "same-host";
    }
    return isPrivatePairingLanHost(host) ? "local-network" : "public-internet";
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

async function resolvePairingSetupConnectivity(
  cfg: OpenClawConfig,
  options: InternalPairingConnectivityOptions,
): Promise<PairingSetupConnectivityResolution> {
  if (!options.activeAuth) {
    assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
  }
  const env = options.env ?? process.env;
  const auth = options.activeAuth ?? resolvePairingAuth(cfg, env);
  if (auth === "invalid") {
    return { ok: false, error: "Gateway auth mode is ambiguous." };
  }
  if (auth === "unavailable") {
    return { ok: false, error: "Gateway auth is configured but unavailable." };
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
  const uniqueUrls = projectPairingConnectivityUrls(route.urls ?? [route.url]).filter(
    (url) => !validateMobilePairingUrl(url, route.source),
  );
  if (uniqueUrls.length === 0) {
    return { ok: false, error: "Gateway URL unavailable." };
  }
  const requestedProfile = options.bootstrapProfile ?? FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE;
  const accessDowngraded =
    deviceBootstrapProfilesEqual(requestedProfile, FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE) &&
    uniqueUrls.some((url) => !isFullAccessPairingConnectivityUrl(url));
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

export async function resolvePairingSetupConnectivityFromConfig(
  cfg: OpenClawConfig,
  options: ResolvePairingSetupConnectivityOptions = {},
): Promise<PairingSetupConnectivityResolution> {
  return await resolvePairingSetupConnectivity(cfg, options);
}

export async function resolveActivePairingSetupConnectivity(
  cfg: OpenClawConfig,
  activeAuth: PairingConnectivityAuth,
  options: ResolvePairingSetupConnectivityOptions = {},
): Promise<PairingSetupConnectivityResolution> {
  return await resolvePairingSetupConnectivity(cfg, { ...options, activeAuth });
}

function currentBlocker(error: string | undefined): PairingConnectivityBlocker {
  return error?.includes("secure gateway URL") ? "route-insecure" : "route-unavailable";
}

export async function inspectPairingConnectivity(
  cfg: OpenClawConfig,
  options: {
    configHash?: string;
    configState?: PairingConnectivityConfigState;
    activeAuth?: PairingConnectivityAuth;
    configuredPublicUrl?: string;
    env?: NodeJS.ProcessEnv;
    runCommandWithTimeout?: PairingConnectivityCommandRunner;
    networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
  } = {},
): Promise<PairingConnectivityInspection> {
  const env = options.env ?? process.env;
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces;
  const auth = options.activeAuth ?? resolvePairingAuth(cfg, env);
  const port = resolveGatewayPort(cfg, env);
  const [currentResolution, lanHost, tailscale] = await Promise.all([
    resolvePairingSetupConnectivity(cfg, {
      env,
      activeAuth: auth,
      publicUrl: options.configuredPublicUrl,
      runCommandWithTimeout: options.runCommandWithTimeout,
      networkInterfaces,
    }).catch(() => ({ ok: false as const, error: "invalid" })),
    resolveAdvertisedLanHost({
      networkInterfaces,
      runCommandWithTimeout: options.runCommandWithTimeout,
    }),
    inspectTailscaleConnectivityWithRunner(
      port,
      options.runCommandWithTimeout,
      cfg.gateway?.tailscale?.mode === "serve" ? cfg.gateway.tailscale.serviceName : undefined,
    ),
  ]);
  const configuredPublic = normalizeOptionalString(options.configuredPublicUrl);
  const strictPublic = configuredPublic ? normalizeOperatorPublicUrl(configuredPublic) : undefined;
  const current =
    currentResolution.ok && auth !== "missing" && auth !== "unavailable" && auth !== "invalid"
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
              : auth === "unavailable"
                ? ("gateway-auth-unavailable" as const)
                : auth === "invalid"
                  ? ("gateway-auth-invalid" as const)
                  : currentBlocker(currentResolution.ok ? undefined : currentResolution.error),
        };
  return {
    ...(options.configHash ? { configHash: options.configHash } : {}),
    configState: options.configState ?? "unknown",
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
    configState: inspect.configState,
    auth: inspect.auth,
    blocker,
    changes,
  };
}

export function planPairingConnectivity(
  inspect: PairingConnectivityInspection,
  request: { mode: PairingConnectivityMode; publicUrl?: string },
): PairingConnectivityPlan {
  if (inspect.auth === "missing" || inspect.auth === "unavailable" || inspect.auth === "invalid") {
    return blockedPlan(
      inspect,
      request.mode,
      inspect.auth === "missing"
        ? "gateway-auth-required"
        : inspect.auth === "unavailable"
          ? "gateway-auth-unavailable"
          : "gateway-auth-invalid",
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
    urls = projectPairingConnectivityUrls([inspect.lan.url]);
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
    const tailscaleUrls = selectTailscaleGatewayUrls(tailscale, "serve");
    if (tailscaleUrls.length === 0) {
      return blockedPlan(inspect, request.mode, "tailscale-serve-required", [
        "enable-tailscale-serve",
      ]);
    }
    urls = projectPairingConnectivityUrls(tailscaleUrls);
    exposure = "tailnet";
  } else {
    const publicUrl = normalizeOperatorPublicUrl(request.publicUrl);
    if (!publicUrl.ok) {
      return blockedPlan(inspect, request.mode, publicUrl.blocker);
    }
    urls = projectPairingConnectivityUrls([publicUrl.url]);
    exposure = "public-internet";
  }
  const accessDowngraded = urls.some((url) => !isFullAccessPairingConnectivityUrl(url));
  return {
    status: "confirmation-required",
    mode: request.mode,
    ...(inspect.configHash ? { configHash: inspect.configHash } : {}),
    configState: inspect.configState,
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
