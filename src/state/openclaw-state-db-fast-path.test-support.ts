import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

/** Equal-width schema rewrite keeps the database file structurally valid. */
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

/** Rebuild an index against a decoy, then restore its canonical declaration. */
export function corruptIndexContent(
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

export function prepareCorruptAuditIndex(env: NodeJS.ProcessEnv): string {
  const opened = openOpenClawStateDatabase({ env });
  const pathname = realpathSync(opened.path);
  opened.db.exec(`
    INSERT INTO audit_events (
      event_id, source_id, source_sequence, occurred_at, kind, action, status,
      actor_type, actor_id, direction, channel
    ) VALUES
      ('event-1', 'source-1', 1, 1, 'message', 'send', 'ok', 'system', 'talos', 'inbound', 'slack'),
      ('event-2', 'source-2', 2, 2, 'message', 'send', 'ok', 'system', 'talos', 'outbound', 'discord');
  `);
  closeOpenClawStateDatabaseForTest();
  const checkpoint = new DatabaseSync(pathname);
  checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  checkpoint.close();
  corruptIndexContent(pathname, "idx_audit_events_direction_sequence", "direction", "channel  ");
  return pathname;
}
