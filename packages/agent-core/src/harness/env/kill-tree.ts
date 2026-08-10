// Agent Core module implements kill tree behavior.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;
const TASKKILL_COMPLETION_TIMEOUT_MS = 3000;
const PS_TIMEOUT_MS = 500;

export type KillProcessTreeOptions = {
  graceMs?: number;
  detached?: boolean;
  force?: boolean;
};

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if taskkill refuses or the process
 *   survives the grace period.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 *
 * Group kill (`process.kill(-pid, ...)`) is only used when the PID is verified
 * as its own process group leader, unless `detached: true` is explicitly passed.
 * This prevents accidentally signaling the gateway's process group when the
 * child shares its parent's group.
 *
 * - `detached: false`: skip group kill unconditionally and signal the PID plus
 *   its descendants individually instead.
 * - `detached: true`: use group kill unconditionally (trust caller).
 * - `detached` omitted: use group kill only when PID is the group leader.
 */
export function killProcessTree(pid: number, opts?: KillProcessTreeOptions): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    if (opts?.force === true) {
      signalProcessTreeWindows(pid, "SIGKILL");
      return;
    }
    const graceMs = normalizeGraceMs(opts?.graceMs);
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  const useGroupKill =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid));
  if (opts?.force === true) {
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);
  const tracked = signalProcessTreeUnix(pid, "SIGTERM", useGroupKill);
  setTimeout(() => {
    if (useGroupKill) {
      if (isProcessAlive(-pid) || isProcessAlive(pid)) {
        signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
      }
      return;
    }
    // A descendant that ignored SIGTERM outlives a root that did not, so the
    // root's own liveness cannot decide whether the tree still needs killing.
    const { tableAvailable, descendants, rootIdentity } = resolveUnixTree(pid, tracked, "force");
    if (!tableAvailable) {
      // Nothing can be enumerated on this host; degrade to the direct-PID
      // escalation this function performed before descendants were tracked.
      if (isProcessAlive(pid)) {
        signalUnixTargets(pid, "SIGKILL", []);
      }
      return;
    }
    // The root is re-signaled only when it is provably the same process, or
    // when no start time is available at all and liveness is the best evidence
    // there is — never when its identity provably changed.
    const shouldKillRoot =
      rootIdentity === "same" || (rootIdentity === "unknown" && isProcessAlive(pid));
    if (descendants.length === 0 && !shouldKillRoot) {
      return;
    }
    for (const target of descendants) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone, or not ours to signal.
      }
    }
    if (shouldKillRoot) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, graceMs).unref();
}

export function signalProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  opts?: { detached?: boolean; onComplete?: () => void },
): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    opts?.onComplete?.();
    return;
  }

  if (process.platform === "win32") {
    void signalProcessTreeWindowsAndWait(pid, signal).then(opts?.onComplete);
    return;
  }

  const useGroupKill =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid));
  signalProcessTreeUnix(pid, signal, useGroupKill);
  opts?.onComplete?.();
}

function normalizeGraceMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseProcessGroupId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const pgid = Number(value.trim());
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
}

function readProcessGroupIdFromPs(pid: number): number | undefined {
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
      timeout: 500,
    });
    if (res.error || res.status !== 0) {
      return undefined;
    }
    return parseProcessGroupId(res.stdout);
  } catch {
    return undefined;
  }
}

function readProcessGroupIdFromProc(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) {
      return undefined;
    }
    // After comm: state, ppid, pgrp. The command name may contain spaces or ')'.
    const fields = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/);
    return parseProcessGroupId(fields[2]);
  } catch {
    return undefined;
  }
}

/** Fail closed to direct-PID signaling when group ownership cannot be proved. */
function isProcessGroupLeader(pid: number): boolean {
  // Linux exposes the fact in procfs; avoid a synchronous child process on the common path.
  const procPgid = process.platform === "linux" ? readProcessGroupIdFromProc(pid) : undefined;
  const pgid = procPgid ?? readProcessGroupIdFromPs(pid);
  return pgid === pid;
}

/** One process, with a start token that distinguishes it from a later PID reuse. */
type ProcessTableEntry = { ppid: number; startToken: string };

function parseProcessTable(lines: Iterable<string>): Map<number, ProcessTableEntry> {
  const table = new Map<number, ProcessTableEntry>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = /\s+/;
    const [pidText, ppidText, ...rest] = trimmed.split(separator);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      continue;
    }
    table.set(pid, { ppid, startToken: rest.join(" ") });
  }
  return table;
}

function readProcessTableFromProc(): Map<number, ProcessTableEntry> | undefined {
  try {
    const lines: string[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const commEnd = stat.lastIndexOf(")");
        if (commEnd < 0) {
          continue;
        }
        // After comm the fields are positional: state, ppid, ... starttime.
        // The command name may itself contain spaces or ')'.
        const fields = stat
          .slice(commEnd + 1)
          .trim()
          .split(/\s+/);
        lines.push(`${entry} ${fields[1] ?? ""} ${fields[19] ?? ""}`);
      } catch {
        // The process exited while the snapshot was being taken.
      }
    }
    return parseProcessTable(lines);
  } catch {
    return undefined;
  }
}

function readProcessTableFromPs(): Map<number, ProcessTableEntry> | undefined {
  // `timeout` alone only signals the child and keeps waiting for it, so a `ps`
  // that ignores SIGTERM would block this synchronous call indefinitely.
  const runPs = (format: string) =>
    spawnSync("ps", ["-eo", format], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: PS_TIMEOUT_MS,
    });
  try {
    const withStart = runPs("pid=,ppid=,lstart=");
    const res =
      !withStart.error && withStart.status === 0 && typeof withStart.stdout === "string"
        ? withStart
        : runPs("pid=,ppid=");
    if (res.error || res.status !== 0 || typeof res.stdout !== "string") {
      return undefined;
    }
    return parseProcessTable(res.stdout.split("\n"));
  } catch {
    return undefined;
  }
}

function readProcessTable(): Map<number, ProcessTableEntry> | undefined {
  return (
    (process.platform === "linux" ? readProcessTableFromProc() : undefined) ??
    readProcessTableFromPs()
  );
}

function collectDescendants(
  pid: number,
  table: Map<number, ProcessTableEntry>,
): Array<{ pid: number; startToken: string }> {
  const children = new Map<number, number[]>();
  for (const [candidate, entry] of table) {
    const siblings = children.get(entry.ppid);
    if (siblings) {
      siblings.push(candidate);
    } else {
      children.set(entry.ppid, [candidate]);
    }
  }
  const descendants: Array<{ pid: number; startToken: string }> = [];
  const seen = new Set<number>([pid]);
  // The array iterator walks entries appended during the loop, which keeps this
  // linear; shift() would make a runaway high-fanout tree quadratic and stall
  // the caller's event loop while it is being cleaned up.
  const queue = [pid];
  for (const current of queue) {
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      descendants.push({ pid: child, startToken: table.get(child)?.startToken ?? "" });
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * What one termination sequence remembers about the tree it signaled. SIGTERM
 * can end the root while a descendant ignores it; that descendant is reparented
 * to init and can no longer be found from the root, so the force phase would
 * have nothing to signal without this. It belongs to the sequence and dies with
 * it: a PID the kernel hands to an unrelated process later carries no memory of
 * the tree that used it before.
 */
type TrackedTree = { rootStartToken: string; entries: Array<{ pid: number; startToken: string }> };

/**
 * Live descendants of a PID that does not lead its own process group: the ones
 * visible now, plus the ones this sequence signaled earlier that are still
 * provably the same process.
 *
 * `tableAvailable` distinguishes "this host cannot enumerate processes" from
 * "the tree is empty"; the caller must not read the latter into the former, or
 * a child that ignored SIGTERM never gets its SIGKILL. Identity is carried by a
 * start token, and a PID is only re-signaled across the grace window when that
 * token is non-empty on both sides: some `ps` builds cannot report a start time,
 * and treating two empty tokens as a match would let a recycled PID inherit a
 * pending SIGKILL.
 */
function resolveUnixTree(
  pid: number,
  tracked: TrackedTree | undefined,
  phase: "initial" | "force",
): {
  tableAvailable: boolean;
  descendants: number[];
  rootIdentity: "same" | "changed" | "unknown";
  tracked: TrackedTree | undefined;
} {
  const table = readProcessTable();
  if (!table) {
    return { tableAvailable: false, descendants: [], rootIdentity: "unknown", tracked };
  }
  const rootStartToken = table.get(pid)?.startToken;
  const trackedRootToken = tracked?.rootStartToken ?? "";
  const rootIdentity: "same" | "changed" | "unknown" =
    rootStartToken === undefined
      ? "changed"
      : rootStartToken === "" || trackedRootToken === ""
        ? "unknown"
        : trackedRootToken === rootStartToken
          ? "same"
          : "changed";
  // The tree may only be walked from a root this sequence can vouch for. On the
  // first pass that is the PID just handed to us; afterwards it must still be
  // provably the same process. An identity that was never established is not a
  // licence to traverse — the PID may since have gone to a stranger, and its
  // children are not ours to kill.
  const mayTraverseRoot = phase === "initial" || rootIdentity === "same";
  const discovered = mayTraverseRoot ? collectDescendants(pid, table) : [];
  const merged = new Map(discovered.map((entry) => [entry.pid, entry] as const));
  for (const entry of tracked?.entries ?? []) {
    if (merged.has(entry.pid)) {
      continue;
    }
    const current = table.get(entry.pid);
    if (!current || !entry.startToken || current.startToken !== entry.startToken) {
      // Gone, unidentifiable, or now an unrelated process.
      continue;
    }
    merged.set(entry.pid, entry);
    // A descendant that outlived SIGTERM keeps forking. Those children appear
    // in no earlier snapshot and cannot be reached from a root that has since
    // died, so the only way to them is a rescan from the survivor itself.
    for (const late of collectDescendants(entry.pid, table)) {
      if (!merged.has(late.pid)) {
        merged.set(late.pid, late);
      }
    }
  }
  const entries = [...merged.values()];
  return {
    tableAvailable: true,
    descendants: entries.map((entry) => entry.pid),
    rootIdentity,
    tracked: {
      rootStartToken: tracked?.rootStartToken || (rootStartToken ?? ""),
      // Only identifiable entries are worth remembering: an unidentifiable one
      // could not be safely signaled later anyway.
      entries: entries.filter((entry) => entry.startToken !== ""),
    },
  };
}

function signalUnixTargets(pid: number, signal: "SIGTERM" | "SIGKILL", targets: number[]): void {
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch {
      // Already gone, or not ours to signal.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/** Returns what the caller must remember to escalate this same tree later. */
function signalProcessTreeUnix(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  useGroupKill: boolean,
): TrackedTree | undefined {
  if (useGroupKill) {
    try {
      process.kill(-pid, signal);
      return undefined;
    } catch {
      // Process group does not exist or we lack permission; try direct pid.
    }
  }

  // Without group kill this is the only way descendants are reached. Signaling
  // the direct PID alone leaves everything the child forked running, reparented
  // to init with its output already closed, so a timed-out run keeps consuming
  // the machine and can never deliver a result.
  const resolved = resolveUnixTree(pid, undefined, "initial");
  signalUnixTargets(pid, signal, resolved.descendants);
  return resolved.tracked;
}

function runTaskkill(args: string[], onExit?: (code: number | null) => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(completionTimer);
      onExit?.(code);
      resolve();
    };
    const completionTimer = setTimeout(() => finish(null), TASKKILL_COMPLETION_TIMEOUT_MS);
    completionTimer.unref?.();
    try {
      const child = spawn("taskkill", args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      // A failed spawn emits error before a close with a negative errno. Only
      // taskkill's first actual outcome may authorize immediate escalation.
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
    } catch {
      // Ignore taskkill spawn failures.
      finish(null);
    }
  });
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  let forced = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const forceKill = () => {
    if (forced) {
      return;
    }
    // Latch before probing: a later live PID could belong to a reused,
    // unrelated Windows process tree.
    forced = true;
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    if (!isProcessAlive(pid)) {
      return;
    }
    signalProcessTreeWindows(pid, "SIGKILL");
  };

  signalProcessTreeWindows(pid, "SIGTERM", (code) => {
    if (code !== null && code !== 0) {
      forceKill();
    }
  });

  graceTimer = setTimeout(forceKill, graceMs);
  graceTimer.unref();
}

function signalProcessTreeWindows(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  onExit?: (code: number | null) => void,
): void {
  void signalProcessTreeWindowsAndWait(pid, signal, onExit);
}

function signalProcessTreeWindowsAndWait(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  onExit?: (code: number | null) => void,
): Promise<void> {
  const args =
    signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  return runTaskkill(args, onExit);
}
