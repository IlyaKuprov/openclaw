import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isOpenClawStateAuditIntegrityVerifierRegistered } from "./openclaw-state-audit-verifier-registration.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

const deferredAuditIntegrityDatabases = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDeferredAuditIntegrity"),
  () => new WeakSet<DatabaseSync>(),
);

/** Remember a handle whose audit index proof belongs to the active verifier. */
export function markOpenClawStateAuditIntegrityDeferred(database: DatabaseSync): void {
  deferredAuditIntegrityDatabases.add(database);
}

/** On verifier retirement, require a full proof before any cached-handle reuse. */
export function assertOpenClawStateAuditIntegrity(
  database: OpenClawStateDatabase | undefined,
  recordFailure: (pathname: string, error: Error) => void,
): void {
  if (
    !database ||
    !database.db.isOpen ||
    !deferredAuditIntegrityDatabases.has(database.db) ||
    isOpenClawStateAuditIntegrityVerifierRegistered(database.path)
  ) {
    return;
  }
  try {
    assertSqliteIntegrity(database.db, database.path);
    deferredAuditIntegrityDatabases.delete(database.db);
  } catch (error) {
    if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      recordFailure(database.path, error);
    }
    throw error;
  }
}
