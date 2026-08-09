// Tailscale status helpers parse and validate status payloads from Tailscale.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { projectPairingConnectivityUrls } from "./pairing-connectivity-urls.js";

export type TailscaleStatusCommandResult = {
  code: number | null;
  stdout: string;
  errorCode?: string;
};

export type TailscaleStatusCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv },
) => Promise<TailscaleStatusCommandResult>;

const TAILSCALE_STATUS_COMMAND_CANDIDATES = [
  "tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
const TAILSCALE_STATUS_MAX_OUTPUT_BYTES = 1024 * 1024;

const TailscaleStatusSchema = z.object({
  BackendState: z.string().optional(),
  Self: z
    .object({
      DNSName: z.string().max(253).optional(),
      TailscaleIPs: z.array(z.string().max(45)).max(16).optional(),
      CapMap: z.record(z.string().max(128), z.array(z.unknown()).max(32)).optional(),
    })
    .optional(),
});

export type TailscaleConnectivityInspection =
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "login-required"; backendState: "NeedsLogin" | "NeedsMachineAuth" }
  | { status: "stopped"; backendState: "NoState" | "Stopped" }
  | { status: "starting"; backendState: "Starting" }
  | {
      status: "running";
      backendState: "Running";
      host?: string;
      serviceApproval?: "required" | "approved" | "unknown";
      serve:
        | { status: "route-configured"; readiness: "not-verified"; urls: string[] }
        | { status: "missing" | "unrelated" | "conflicting-root" | "unreadable" };
      funnel:
        | { status: "route-configured"; urls: string[] }
        | { status: "not-configured" | "unreadable" };
    };

const TailscaleServeTcpHandlerSchema = z.object({
  HTTPS: z.boolean().optional(),
});

const TailscaleServeWebServerSchema = z.object({
  Handlers: z.record(
    z.string(),
    z.object({
      Proxy: z.string().max(2048).optional(),
    }),
  ),
});

const TailscaleServeServiceSchema = z.object({
  TCP: z.record(z.string(), TailscaleServeTcpHandlerSchema).optional(),
  Web: z.record(z.string(), TailscaleServeWebServerSchema).optional(),
  Tun: z.boolean().optional(),
});

const TailscaleServeConfigSchema = TailscaleServeServiceSchema.extend({
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
  Services: z.record(z.string(), TailscaleServeServiceSchema).optional(),
});

function parsePossiblyNoisyStatus(raw: string): z.infer<typeof TailscaleStatusSchema> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  return safeParseJsonWithSchema(TailscaleStatusSchema, raw.slice(start, end + 1));
}

function extractTailnetHostFromStatusJson(raw: string): string | null {
  const parsed = parsePossiblyNoisyStatus(raw);
  const dns = parsed?.Self?.DNSName;
  if (dns && dns.length > 0) {
    return dns.replace(/\.$/, "");
  }
  const ips = parsed?.Self?.TailscaleIPs ?? [];
  return ips.length > 0 ? (ips[0] ?? null) : null;
}

function parseLoopbackProxyPort(proxy: string): number | null {
  const trimmed = proxy.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const normalized = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!(host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host))) {
      return null;
    }
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function collectServeGatewayUrls(
  config: z.infer<typeof TailscaleServeServiceSchema>,
  gatewayPort: number,
  acceptsHostPort: (hostPort: string) => boolean,
  expectedHost?: string,
): string[] {
  const urls: string[] = [];
  for (const [hostPort, webServer] of Object.entries(config.Web ?? {})) {
    const handler = webServer.Handlers["/"];
    if (
      !acceptsHostPort(hostPort) ||
      !handler?.Proxy ||
      parseLoopbackProxyPort(handler.Proxy) !== gatewayPort
    ) {
      continue;
    }
    try {
      const endpoint = new URL(`https://${hostPort}`);
      if (expectedHost && endpoint.hostname !== expectedHost) {
        continue;
      }
      const port = endpoint.port || "443";
      if (config.TCP?.[port]?.HTTPS !== true) {
        continue;
      }
      urls.push(`wss://${endpoint.host}`);
    } catch {
      continue;
    }
  }
  return projectPairingConnectivityUrls(urls);
}

function normalizeServiceName(serviceName: string | undefined): string | undefined {
  const trimmed = serviceName?.trim();
  return trimmed ? (trimmed.startsWith("svc:") ? trimmed : `svc:${trimmed}`) : undefined;
}

function hasPublishedConfig(config: z.infer<typeof TailscaleServeConfigSchema>): boolean {
  return (
    config.Tun === true ||
    Object.keys(config.TCP ?? {}).length > 0 ||
    Object.keys(config.Web ?? {}).length > 0 ||
    Object.keys(config.Services ?? {}).length > 0 ||
    Object.values(config.AllowFunnel ?? {}).some((enabled) => enabled)
  );
}

function hasConflictingRoot(params: {
  config: z.infer<typeof TailscaleServeServiceSchema>;
  gatewayPort: number;
  acceptsHostPort: (hostPort: string) => boolean;
  expectedHost?: string;
}): boolean {
  if (params.config.Tun === true) {
    return true;
  }
  for (const [hostPort, webServer] of Object.entries(params.config.Web ?? {})) {
    let endpoint: URL;
    try {
      endpoint = new URL(`https://${hostPort}`);
    } catch {
      continue;
    }
    if (params.expectedHost && endpoint.hostname !== params.expectedHost) {
      continue;
    }
    const root = webServer.Handlers["/"];
    if (!root) {
      continue;
    }
    const port = endpoint.port || "443";
    return (
      !params.acceptsHostPort(hostPort) ||
      params.config.TCP?.[port]?.HTTPS !== true ||
      !root.Proxy ||
      parseLoopbackProxyPort(root.Proxy) !== params.gatewayPort
    );
  }
  return false;
}

function resolveServiceApproval(
  parsedStatus: z.infer<typeof TailscaleStatusSchema> | null,
  serviceName: string | undefined,
): "required" | "approved" | "unknown" | undefined {
  const normalized = normalizeServiceName(serviceName);
  if (!normalized) {
    return undefined;
  }
  const capMap = parsedStatus?.Self?.CapMap;
  if (!capMap) {
    return "unknown";
  }
  for (const entry of capMap["service-host"] ?? []) {
    if (isRecord(entry) && Array.isArray(entry[normalized]) && entry[normalized].length > 0) {
      return "approved";
    }
  }
  return "required";
}

function extractPublishedGatewayUrls(
  raw: string,
  gatewayPort: number,
  host?: string,
  serviceName?: string,
): {
  serve:
    | { status: "route-configured"; readiness: "not-verified"; urls: string[] }
    | { status: "missing" | "unrelated" | "conflicting-root" };
  funnel: { status: "route-configured"; urls: string[] } | { status: "not-configured" };
} | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  const parsed = safeParseJsonWithSchema(TailscaleServeConfigSchema, raw.slice(start, end + 1));
  if (!parsed) {
    return null;
  }
  const normalizedServiceName = normalizeServiceName(serviceName);
  const expectedHost = normalizedServiceName
    ? (resolveTailscalePublishedHost({
        tailscaleMode: "serve",
        tailnetHost: host ?? null,
        serviceName: normalizedServiceName,
      }) ?? undefined)
    : host;
  const funnelHosts = parsed.AllowFunnel ?? {};
  const selected = normalizedServiceName ? parsed.Services?.[normalizedServiceName] : parsed;
  const acceptsServeHostPort = normalizedServiceName
    ? () => true
    : (hostPort: string) => funnelHosts[hostPort] !== true;
  const serveUrls = selected
    ? collectServeGatewayUrls(selected, gatewayPort, acceptsServeHostPort, expectedHost)
    : [];
  const serve = serveUrls.length
    ? ({ status: "route-configured", readiness: "not-verified", urls: serveUrls } as const)
    : selected &&
        hasConflictingRoot({
          config: selected,
          gatewayPort,
          acceptsHostPort: acceptsServeHostPort,
          ...(expectedHost ? { expectedHost } : {}),
        })
      ? ({ status: "conflicting-root" } as const)
      : hasPublishedConfig(parsed)
        ? ({ status: "unrelated" } as const)
        : ({ status: "missing" } as const);
  if (normalizedServiceName) {
    return {
      serve,
      funnel: { status: "not-configured" },
    };
  }
  const funnelUrls = collectServeGatewayUrls(
    parsed,
    gatewayPort,
    (hostPort) => funnelHosts[hostPort] === true,
  );
  return {
    serve,
    funnel: funnelUrls.length
      ? { status: "route-configured", urls: funnelUrls }
      : { status: "not-configured" },
  };
}

function extractServeGatewayUrls(raw: string, gatewayPort: number): string[] {
  const published = extractPublishedGatewayUrls(raw, gatewayPort);
  return published?.serve.status === "route-configured" ? published.serve.urls : [];
}

function tailscaleCommandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return env.TERM?.trim() ? env : { ...env, TERM: "dumb" };
}

function commandErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function runTailscaleCandidate(
  candidate: string,
  args: string[],
  runCommandWithTimeout: TailscaleStatusCommandRunner,
): Promise<TailscaleStatusCommandResult> {
  return await runCommandWithTimeout([candidate, ...args], {
    timeoutMs: 5000,
    maxOutputBytes: TAILSCALE_STATUS_MAX_OUTPUT_BYTES,
    env: tailscaleCommandEnv(),
  });
}

/** Inspects local Tailscale backend and published-route state without mutation or diagnostics. */
export async function inspectTailscaleConnectivityWithRunner(
  gatewayPort: number,
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
  serviceName?: string,
): Promise<TailscaleConnectivityInspection> {
  if (!runCommandWithTimeout) {
    return { status: "unavailable" };
  }
  let sawNonMissingFailure = false;
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    let statusResult: TailscaleStatusCommandResult;
    try {
      statusResult = await runTailscaleCandidate(
        candidate,
        ["status", "--json"],
        runCommandWithTimeout,
      );
    } catch (error) {
      if (commandErrorCode(error) !== "ENOENT") {
        sawNonMissingFailure = true;
      }
      continue;
    }
    if (statusResult.errorCode === "ENOENT") {
      continue;
    }
    if (statusResult.code !== 0) {
      sawNonMissingFailure = true;
      continue;
    }
    const parsed = parsePossiblyNoisyStatus(statusResult.stdout);
    const backendState = parsed?.BackendState;
    if (backendState === "NeedsLogin" || backendState === "NeedsMachineAuth") {
      return { status: "login-required", backendState };
    }
    if (backendState === "NoState" || backendState === "Stopped") {
      return { status: "stopped", backendState };
    }
    if (backendState === "Starting") {
      return { status: "starting", backendState };
    }
    if (backendState !== "Running") {
      return { status: "error" };
    }
    const host = extractTailnetHostFromStatusJson(statusResult.stdout);
    const serviceApproval = resolveServiceApproval(parsed, serviceName);
    let serveResult: TailscaleStatusCommandResult;
    try {
      serveResult = await runTailscaleCandidate(
        candidate,
        ["serve", "status", "--json"],
        runCommandWithTimeout,
      );
    } catch {
      return {
        status: "running",
        backendState,
        ...(host ? { host } : {}),
        ...(serviceApproval ? { serviceApproval } : {}),
        serve: { status: "unreadable" },
        funnel: { status: "unreadable" },
      };
    }
    const published =
      serveResult.code === 0
        ? extractPublishedGatewayUrls(
            serveResult.stdout,
            gatewayPort,
            host ?? undefined,
            serviceName,
          )
        : null;
    return {
      status: "running",
      backendState,
      ...(host ? { host } : {}),
      ...(serviceApproval ? { serviceApproval } : {}),
      serve: published?.serve ?? { status: "unreadable" },
      funnel: published?.funnel ?? { status: "unreadable" },
    };
  }
  return sawNonMissingFailure ? { status: "error" } : { status: "unavailable" };
}

export async function resolveConfiguredTailscaleGatewayUrlsWithRunner(
  params: { mode: "serve" | "funnel"; gatewayPort: number; serviceName?: string },
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string[]> {
  const inspected = await inspectTailscaleConnectivityWithRunner(
    params.gatewayPort,
    runCommandWithTimeout,
    params.mode === "serve" ? params.serviceName : undefined,
  );
  return selectTailscaleGatewayUrls(inspected, params.mode);
}

export function selectTailscaleGatewayUrls(
  inspection: TailscaleConnectivityInspection,
  mode: "serve" | "funnel",
): string[] {
  if (inspection.status !== "running") {
    return [];
  }
  const route = mode === "serve" ? inspection.serve : inspection.funnel;
  return route.status === "route-configured" ? route.urls : [];
}

/** Resolves the host published to clients for tailnet or Tailscale Serve gateway modes. */
export function resolveTailscalePublishedHost(params: {
  tailscaleMode: string;
  tailnetHost: string | null;
  serviceName?: string | null;
}): string | null {
  const tailnetHost = params.tailnetHost?.trim();
  if (!tailnetHost) {
    return null;
  }
  const serviceName =
    params.tailscaleMode === "serve" ? params.serviceName?.trim() || undefined : undefined;
  if (!serviceName) {
    return tailnetHost;
  }
  // Tailscale Serve service names compose with DNS hosts, not raw tailnet IP addresses.
  if (/^[\d.:]+$/.test(tailnetHost)) {
    return null;
  }
  const bareServiceName = serviceName.replace(/^svc:/, "");
  const tailnetSuffix = tailnetHost.split(".").slice(1).join(".");
  return tailnetSuffix ? `${bareServiceName}.${tailnetSuffix}` : null;
}

/** Runs known Tailscale status commands and returns the first DNS name or tailnet IP found. */
export async function resolveTailnetHostWithRunner(
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string | null> {
  if (!runCommandWithTimeout) {
    return null;
  }
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([candidate, "status", "--json"], {
        timeoutMs: 5000,
        maxOutputBytes: TAILSCALE_STATUS_MAX_OUTPUT_BYTES,
      });
      if (result.code !== 0) {
        continue;
      }
      const raw = result.stdout.trim();
      if (!raw) {
        continue;
      }
      const host = extractTailnetHostFromStatusJson(raw);
      if (host) {
        return host;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Finds persistent HTTPS Serve routes whose root proxy targets this gateway port. */
export async function resolveTailscaleServeGatewayUrlsWithRunner(
  gatewayPort: number,
  runCommandWithTimeout?: TailscaleStatusCommandRunner,
): Promise<string[]> {
  if (!runCommandWithTimeout) {
    return [];
  }
  for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) {
    try {
      const result = await runCommandWithTimeout([candidate, "serve", "status", "--json"], {
        timeoutMs: 5000,
        maxOutputBytes: TAILSCALE_STATUS_MAX_OUTPUT_BYTES,
      });
      if (result.code !== 0 || !result.stdout.trim()) {
        continue;
      }
      const urls = extractServeGatewayUrls(result.stdout, gatewayPort);
      if (urls.length > 0) {
        return urls;
      }
    } catch {
      continue;
    }
  }
  return [];
}
