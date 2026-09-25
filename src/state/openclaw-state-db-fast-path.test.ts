import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  isOpenClawStateSchemaFastPathEligible,
  registerOpenClawStateAuditIntegrityVerifier,
} from "./openclaw-state-db-fast-path.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

/** Rewrite the stored CREATE INDEX text in place; equal widths keep the file well formed. */
function repointIndexColumn(
  databasePath: string,
  indexName: string,
  fromColumn: string,
  toColumn: string,
): void {
  if (fromColumn.length !== toColumn.length) {
    throw new Error("Rewriting the schema in place requires equal-width column names");
  }
  const buffer = readFileSync(databasePath);
  const named = buffer.indexOf(Buffer.from(indexName, "latin1"));
  const target = buffer.indexOf(Buffer.from(`(${fromColumn}`, "latin1"), named);
  if (named < 0 || target < 0) {
    throw new Error(`Could not locate ${indexName}(${fromColumn}) in ${databasePath}`);
  }
  buffer.write(`(${toColumn}`, target, "latin1");
  writeFileSync(databasePath, buffer);
}

/**
 * Detach an index from the rows it indexes while leaving the canonical schema
 * text intact: rebuild it against a decoy column of the same width, then
 * restore the declaration. No page is damaged, so quick_check and the
 * canonical index contract both still pass and only the table-scoped
 * integrity_check can see the mismatch.
 */
function corruptIndexContent(
  databasePath: string,
  indexName: string,
  canonicalColumn: string,
  decoyColumn: string,
): void {
  repointIndexColumn(databasePath, indexName, canonicalColumn, decoyColumn);
  const rebuild = new DatabaseSync(databasePath);
  try {
    rebuild.exec(`REINDEX ${indexName};`);
    rebuild.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    rebuild.close();
  }
  repointIndexColumn(databasePath, indexName, decoyColumn, canonicalColumn);
}

describe("state schema fast-path integrity proof", () => {
  it.each([
    {
      name: "refuses audit ledger index corruption without a background verifier",
      index: "idx_audit_events_direction_sequence",
      from: "direction",
      to: "channel  ",
      refused: true,
    },
    {
      name: "refuses a corrupt non-ledger table on every open",
      index: "idx_state_leases_owner",
      from: "owner",
      to: "scope",
      refused: true,
    },
  ])("$name", ({ index, from, to, refused }) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-fast-path-integrity-") };
    const opened = openOpenClawStateDatabase({ env });
    const pathname = realpathSync(opened.path);
    opened.db.exec(`
      INSERT INTO audit_events (
        event_id, source_id, source_sequence, occurred_at, kind, action, status,
        actor_type, actor_id, direction, channel
      ) VALUES
        ('event-1', 'source-1', 1, 1, 'message', 'send', 'ok', 'system', 'talos', 'inbound', 'slack'),
        ('event-2', 'source-2', 2, 2, 'message', 'send', 'ok', 'system', 'talos', 'outbound', 'discord');
      INSERT INTO state_leases (scope, lease_key, owner, created_at, updated_at) VALUES
        ('scope-a', 'key-1', 'owner-1', 1, 1),
        ('scope-b', 'key-2', 'owner-2', 2, 2);
    `);
    closeOpenClawStateDatabaseForTest();
    // The rewrite targets the main database file, so fold the WAL back in first.
    const checkpoint = new DatabaseSync(pathname);
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    checkpoint.close();

    corruptIndexContent(pathname, index, from, to);

    const database = new DatabaseSync(pathname);
    try {
      // The whole-file page structure stays provable; only index content drifted.
      expect(database.prepare("PRAGMA quick_check;").all()).toEqual([{ quick_check: "ok" }]);
      // The background verifier keeps the full proof and still sees the damage.
      expect(() => assertSqliteIntegrity(database, pathname)).toThrow(
        new RegExp(`integrity_check failed for .*${index}`, "u"),
      );
      if (refused) {
        expect(() => isOpenClawStateSchemaFastPathEligible(database, pathname)).toThrow(
          new RegExp(`integrity_check failed for .*${index}`, "u"),
        );
      }
      const unrelatedVerifier = registerOpenClawStateAuditIntegrityVerifier(`${pathname}.other`);
      try {
        expect(() => isOpenClawStateSchemaFastPathEligible(database, pathname)).toThrow(
          new RegExp(`integrity_check failed for .*${index}`, "u"),
        );
      } finally {
        unrelatedVerifier();
      }
      const unregister = registerOpenClawStateAuditIntegrityVerifier(pathname);
      try {
        if (index.startsWith("idx_audit_events")) {
          expect(isOpenClawStateSchemaFastPathEligible(database, pathname)).toBe(true);
        } else {
          expect(() => isOpenClawStateSchemaFastPathEligible(database, pathname)).toThrow(
            new RegExp(`integrity_check failed for .*${index}`, "u"),
          );
        }
      } finally {
        unregister();
      }
    } finally {
      database.close();
    }
    if (index.startsWith("idx_audit_events")) {
      // The real direct-local open detects the failed proof, rebuilds the canonical
      // index in its existing repair path, and verifies the result before exposure.
      const repaired = openOpenClawStateDatabase({ env });
      expect(() => assertSqliteIntegrity(repaired.db, pathname)).not.toThrow();
      expect(
        repaired.db.prepare("SELECT event_id FROM audit_events ORDER BY event_id").all(),
      ).toEqual([{ event_id: "event-1" }, { event_id: "event-2" }]);
    }
  });
});

describe("state schema fast-path failure settlement", () => {
  it.each([
    {
      name: "retains repair after successful rollback",
      rollbackFails: false,
      undefinedError: false,
    },
    {
      name: "preserves the original error after native close",
      rollbackFails: true,
      undefinedError: false,
    },
    {
      name: "preserves undefined rejection after native close",
      rollbackFails: true,
      undefinedError: true,
    },
  ])("$name", ({ rollbackFails, undefinedError }) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-fast-path-settlement-") };
    const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
    closeOpenClawStateDatabaseForTest();
    const original = undefinedError ? undefined : new Error("synthetic fast-path COMMIT failure");
    const rollbackError = new Error("synthetic fast-path ROLLBACK failure");
    // oxlint-disable-next-line typescript/unbound-method -- Fault injection forwards the native method with its exact database receiver.
    const exec = DatabaseSync.prototype.exec;
    // oxlint-disable-next-line typescript/unbound-method -- Native close is called with its exact database receiver below.
    const close = DatabaseSync.prototype.close;
    const events: Array<{ phase: "commit" | "rollback" | "close" | "fallback"; isOpen: boolean }> =
      [];
    const selected = new Set<DatabaseSync>();
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (!selected.size && sql === "BEGIN" && this.location() === pathname) {
        selected.add(this);
      }
      if (selected.has(this)) {
        if (!injected && sql === "COMMIT") {
          injected = true;
          events.push({ phase: "commit", isOpen: this.isOpen });
          // oxlint-disable-next-line typescript/only-throw-error -- The public opener must preserve an undefined rejection too.
          throw original;
        }
        if (injected && sql === "ROLLBACK") {
          events.push({ phase: "rollback", isOpen: this.isOpen });
          if (rollbackFails) {
            throw rollbackError;
          }
        }
        if (sql === "PRAGMA foreign_keys = OFF;") {
          events.push({ phase: "fallback", isOpen: this.isOpen });
        }
      }
      Reflect.apply(exec, this, [sql]);
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      Reflect.apply(close, this, []);
      if (selected.has(this)) {
        events.push({ phase: "close", isOpen: this.isOpen });
      }
    });
    let result:
      | { status: "fulfilled"; database: ReturnType<typeof openOpenClawStateDatabase> }
      | { status: "rejected"; error: unknown };
    try {
      result = { status: "fulfilled", database: openOpenClawStateDatabase({ env }) };
    } catch (error) {
      result = { status: "rejected", error };
    }
    expect(injected).toBe(true);
    if (rollbackFails) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error("Expected the failed native rollback to refuse opening");
      }
      expect(result.error).toBe(original);
      expect([...selected].map((database) => database.isOpen)).toEqual([false]);
      expect(events).toEqual([
        { phase: "commit", isOpen: true },
        { phase: "rollback", isOpen: true },
        { phase: "close", isOpen: false },
      ]);
    } else {
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") {
        throw new Error("Expected successful rollback to retain the schema repair fallback");
      }
      expect(result.database.db.isOpen).toBe(true);
      expect(events).toEqual([
        { phase: "commit", isOpen: true },
        { phase: "rollback", isOpen: true },
        { phase: "fallback", isOpen: true },
      ]);
    }
  });
});
