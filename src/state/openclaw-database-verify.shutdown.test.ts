import { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createDeferredCore } from "../shared/deferred.js";
import type * as VerifierImplementation from "./openclaw-database-verify.impl.js";
import { startOpenClawDatabaseIntegrityVerifier } from "./openclaw-database-verify.js";
import type { OpenClawDatabaseVerifyResult } from "./openclaw-database-verify.worker.js";
import { prepareCorruptAuditIndex } from "./openclaw-state-db-fast-path.test-support.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const mocks = vi.hoisted(() => ({
  collectOpenClawDatabaseVerifyTargets:
    vi.fn<typeof VerifierImplementation.collectOpenClawDatabaseVerifyTargets>(),
  runDatabaseVerifyWorker: vi.fn<typeof VerifierImplementation.runDatabaseVerifyWorker>(),
  terminateDatabaseVerifyWorker:
    vi.fn<typeof VerifierImplementation.terminateDatabaseVerifyWorker>(),
  applyOpenClawDatabaseVerificationResults:
    vi.fn<typeof VerifierImplementation.applyOpenClawDatabaseVerificationResults>(),
}));

vi.mock("./openclaw-database-verify.impl.js", () => ({
  ...mocks,
  OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS: 1,
  OPENCLAW_DATABASE_VERIFY_INTERVAL_MS: 100,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe("database verifier shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.collectOpenClawDatabaseVerifyTargets.mockReturnValue([
      { kind: "state", label: "synthetic state", path: "synthetic.sqlite" },
    ]);
    mocks.terminateDatabaseVerifyWorker.mockResolvedValue(undefined);
    mocks.applyOpenClawDatabaseVerificationResults.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["fork failure", "worker exit", "IPC failure"])(
    "stops deferring audit indexes after repeated %s with a cached state handle",
    async (failure) => {
      const env = { OPENCLAW_STATE_DIR: dirs.make("state-verifier-failure-") };
      const pathname = prepareCorruptAuditIndex(env);
      mocks.collectOpenClawDatabaseVerifyTargets.mockReturnValue([
        { kind: "state", label: "state", path: pathname },
      ]);
      mocks.runDatabaseVerifyWorker.mockRejectedValue(new Error(failure));
      const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
      try {
        const opened = openOpenClawStateDatabase({ env });
        expect(() => assertSqliteIntegrity(opened.db, pathname)).toThrow(/integrity_check failed/u);
        await vi.advanceTimersByTimeAsync(3);
        expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(3);
        expect(() => withExistingOpenClawStateDatabaseReadOnly(() => undefined, { env })).toThrow(
          /integrity_check failed/u,
        );
        expect(() => openOpenClawStateDatabase({ env })).toThrow(/integrity_check failed/u);
      } finally {
        await verifier.stop();
      }
    },
  );

  it.each(["missing", "inconclusive"] as const)(
    "suspends deferral when state verification is %s despite a successful worker exit",
    async (outcome) => {
      const env = { OPENCLAW_STATE_DIR: dirs.make("state-verifier-incomplete-") };
      const pathname = prepareCorruptAuditIndex(env);
      mocks.collectOpenClawDatabaseVerifyTargets.mockReturnValue([
        { kind: "state", label: "state", path: pathname },
      ]);
      mocks.runDatabaseVerifyWorker.mockResolvedValue(
        outcome === "missing" ? [] : [{ path: pathname, ok: false, terminal: false }],
      );
      const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
      try {
        openOpenClawStateDatabase({ env });
        await vi.advanceTimersByTimeAsync(3);
        expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(3);
        expect(() => openOpenClawStateDatabase({ env })).toThrow(/integrity_check failed/u);
      } finally {
        await verifier.stop();
      }
    },
  );

  it("recovers after a transient worker failure without suspending audit deferral", async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-verifier-transient-") };
    const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
    closeOpenClawStateDatabaseForTest();
    mocks.collectOpenClawDatabaseVerifyTargets.mockReturnValue([
      { kind: "state", label: "state", path: pathname },
    ]);
    mocks.runDatabaseVerifyWorker
      .mockRejectedValueOnce(new Error("transient IPC failure"))
      .mockResolvedValue([{ path: pathname, ok: true }]);
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      const opened = openOpenClawStateDatabase({ env });
      await vi.advanceTimersByTimeAsync(1);
      expect(openOpenClawStateDatabase({ env }).db).toBe(opened.db);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
      expect(openOpenClawStateDatabase({ env }).db).toBe(opened.db);
      await vi.advanceTimersByTimeAsync(3);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledTimes(2);
    } finally {
      await verifier.stop();
    }
  });

  it("keeps healthy startup off the full-check path and proves a cached handle once on stop", async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-verifier-healthy-") };
    const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
    closeOpenClawStateDatabaseForTest();
    mocks.collectOpenClawDatabaseVerifyTargets.mockReturnValue([
      { kind: "state", label: "state", path: pathname },
    ]);
    mocks.runDatabaseVerifyWorker.mockResolvedValue([{ path: pathname, ok: true }]);
    // oxlint-disable-next-line typescript/unbound-method -- Forward the native method with its exact receiver.
    const prepare = DatabaseSync.prototype.prepare;
    let fullChecks = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "PRAGMA integrity_check;") {
        fullChecks += 1;
      }
      return prepare.call(this, sql);
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env });
    try {
      const opened = openOpenClawStateDatabase({ env });
      expect(fullChecks).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
      expect(openOpenClawStateDatabase({ env }).db).toBe(opened.db);
      expect(fullChecks).toBe(0);
      await vi.advanceTimersByTimeAsync(3);
      expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
    } finally {
      try {
        await verifier.stop();
        openOpenClawStateDatabase({ env });
        expect(fullChecks).toBe(1);
        openOpenClawStateDatabase({ env });
        expect(fullChecks).toBe(1);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it.each(["fulfilled", "rejected"] as const)(
    "joins %s result application after the child has exited",
    async (outcome) => {
      const application = createDeferredCore();
      const entered = createDeferredCore();
      mocks.runDatabaseVerifyWorker.mockResolvedValue([]);
      mocks.applyOpenClawDatabaseVerificationResults.mockImplementation(() => {
        entered.resolve();
        return application.promise;
      });
      const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
      await vi.advanceTimersByTimeAsync(1);
      await entered.promise;
      let stopped = false;
      const stopping = verifier.stop().then(() => {
        stopped = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(stopped).toBe(false);
        expect(mocks.runDatabaseVerifyWorker).toHaveBeenCalledOnce();
        expect(mocks.terminateDatabaseVerifyWorker).not.toHaveBeenCalled();
      } finally {
        if (outcome === "rejected") {
          application.reject(new Error("synthetic confirmation failure"));
        } else {
          application.resolve();
        }
        await stopping;
      }
      expect(stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("joins the running turn after termination and skips results received during stop", async () => {
    const results = createDeferredCore<OpenClawDatabaseVerifyResult[]>();
    const child = new ChildProcess();
    mocks.runDatabaseVerifyWorker.mockImplementation((_targets, options) => {
      options?.onWorker?.(child);
      return results.promise;
    });
    const verifier = startOpenClawDatabaseIntegrityVerifier({ env: {} });
    await vi.advanceTimersByTimeAsync(1);
    let stopped = false;
    const stopping = verifier.stop().then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.terminateDatabaseVerifyWorker).toHaveBeenCalledWith(child);
      expect(stopped).toBe(false);
    } finally {
      results.resolve([]);
      await stopping;
    }
    expect(mocks.applyOpenClawDatabaseVerificationResults).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
