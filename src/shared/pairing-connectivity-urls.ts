import {
  isCarrierGradeNatIpv4Address,
  isIpv4Address,
  isIpv6Address,
  isLoopbackIpAddress,
  isRfc1918Ipv4Address,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MAX_PAIRING_CONNECTIVITY_URLS = 8;
const MAX_PAIRING_CONNECTIVITY_URL_LENGTH = 2048;

export function normalizePairingConnectivityHost(host: string): string {
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

export function isPrivatePairingLanHost(host: string): boolean {
  const normalized = normalizePairingConnectivityHost(host);
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

export function isPairingCleartextAllowedHost(host: string): boolean {
  const normalized = normalizePairingConnectivityHost(host);
  return (
    normalized === "localhost" ||
    isLoopbackIpAddress(normalized) ||
    normalized === "10.0.2.2" ||
    isPrivatePairingLanHost(normalized)
  );
}

export function isFullAccessPairingConnectivityUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = normalizePairingConnectivityHost(parsed.hostname);
    return (
      parsed.protocol === "wss:" ||
      (parsed.protocol === "ws:" && (host === "localhost" || isLoopbackIpAddress(host)))
    );
  } catch {
    return false;
  }
}

function normalizePairingConnectivityOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === "ws:" && !isPairingCleartextAllowedHost(parsed.hostname))
    ) {
      return null;
    }
    const origin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    return origin.length <= MAX_PAIRING_CONNECTIVITY_URL_LENGTH ? origin : null;
  } catch {
    return null;
  }
}

export function projectPairingConnectivityUrls(urls: Iterable<string>): string[] {
  return [
    ...new Set(
      [...urls]
        .map(normalizePairingConnectivityOrigin)
        .filter((url): url is string => url !== null),
    ),
  ]
    .toSorted()
    .slice(0, MAX_PAIRING_CONNECTIVITY_URLS);
}
