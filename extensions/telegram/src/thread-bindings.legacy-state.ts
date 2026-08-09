// Telegram thread-binding record shape, keys, and legacy sidecar reader.
//
// Split from `thread-bindings.ts`, which also value-loads the ACP session graph,
// the session-binding registry, and the send runtime. Doctor enumeration
// cold-loads this module to plan the legacy-state import, so it stays a leaf.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const STORE_VERSION = 1;
export const TELEGRAM_THREAD_BINDINGS_NAMESPACE = "telegram.thread-bindings";
export const TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES = 5_000;

export type TelegramBindingTargetKind = "subagent" | "acp";

export type TelegramThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: TelegramBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};

type StoredTelegramBindingState = {
  version: number;
  bindings: TelegramThreadBindingRecord[];
};

export function resolveTelegramThreadBindingsPath(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "telegram", `thread-bindings-${accountId}.json`);
}

export function resolveStoredBindingKey(params: {
  accountId: string;
  conversationId: string;
}): string {
  return createHash("sha256")
    .update(`${params.accountId}\0${params.conversationId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function normalizeMetadataForStore(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const serialized = JSON.stringify(metadata);
  if (!serialized) {
    return undefined;
  }
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function sanitizeStoredBinding(
  accountId: string,
  entry: Partial<TelegramThreadBindingRecord> | null | undefined,
): TelegramThreadBindingRecord | null {
  const conversationId = normalizeOptionalString(entry?.conversationId);
  const targetSessionKey = normalizeOptionalString(entry?.targetSessionKey) ?? "";
  const targetKind = entry?.targetKind === "subagent" ? "subagent" : "acp";
  if (!conversationId || !targetSessionKey) {
    return null;
  }
  const boundAt =
    typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt)
      ? Math.floor(entry.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
      ? Math.floor(entry.lastActivityAt)
      : boundAt;
  const record: TelegramThreadBindingRecord = {
    accountId,
    conversationId,
    targetSessionKey,
    targetKind,
    boundAt,
    lastActivityAt,
  };
  if (typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)) {
    record.idleTimeoutMs = Math.max(0, Math.floor(entry.idleTimeoutMs));
  }
  if (typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)) {
    record.maxAgeMs = Math.max(0, Math.floor(entry.maxAgeMs));
  }
  if (typeof entry?.agentId === "string" && entry.agentId.trim()) {
    record.agentId = entry.agentId.trim();
  }
  if (typeof entry?.label === "string" && entry.label.trim()) {
    record.label = entry.label.trim();
  }
  if (typeof entry?.boundBy === "string" && entry.boundBy.trim()) {
    record.boundBy = entry.boundBy.trim();
  }
  const metadata = normalizeMetadataForStore(
    entry?.metadata && typeof entry.metadata === "object" ? { ...entry.metadata } : undefined,
  );
  if (metadata) {
    record.metadata = metadata;
  }
  return record;
}

// A torn or foreign sidecar yields no plan, exactly as a missing file does; the
// runtime store is authoritative once doctor has migrated.
export function readLegacyBindingsFile(
  filePath: string,
  accountId: string,
): TelegramThreadBindingRecord[] {
  let parsed: StoredTelegramBindingState;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StoredTelegramBindingState;
  } catch {
    return [];
  }
  if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
    return [];
  }
  const bindings: TelegramThreadBindingRecord[] = [];
  for (const entry of parsed.bindings) {
    const record = sanitizeStoredBinding(accountId, entry);
    if (record) {
      bindings.push(record);
    }
  }
  return bindings;
}

export function listTelegramLegacyThreadBindingEntries(params: {
  accountId: string;
  persistedPath?: string;
}): Array<{ key: string; value: TelegramThreadBindingRecord }> {
  const bindings = readLegacyBindingsFile(
    params.persistedPath ?? resolveTelegramThreadBindingsPath(params.accountId),
    params.accountId,
  );
  return bindings.map((value) => ({ key: resolveStoredBindingKey(value), value }));
}
