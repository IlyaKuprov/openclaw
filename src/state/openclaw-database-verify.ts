import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  applyOpenClawDatabaseVerificationResults,
  collectOpenClawDatabaseVerifyTargets,
  OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS,
  OPENCLAW_DATABASE_VERIFY_INTERVAL_MS,
  runDatabaseVerifyWorker,
  terminateDatabaseVerifyWorker,
} from "./openclaw-database-verify.impl.js";
import { registerOpenClawStateAuditIntegrityVerifier } from "./openclaw-state-audit-verifier-registration.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const log = createSubsystemLogger("state/database-verify");
const MAX_STATE_AUDIT_VERIFIER_FAILURES = 3;

/** Register the Gateway-owned integrity verifier; arm its worker after startup settles. */
export function startOpenClawDatabaseIntegrityVerifier(options: { env: NodeJS.ProcessEnv }): {
  syncStatePath: () => void;
  arm: () => void;
  stop: () => Promise<void>;
} {
  let activeWorker: ChildProcess | undefined;
  let activeRun: Promise<void> | undefined;
  let stopped = false;
  let armed = false;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let statePath = path.resolve(resolveOpenClawStateSqlitePath(options.env));
  let unregisterStateAuditVerifier = registerOpenClawStateAuditIntegrityVerifier(statePath);

  const schedule = (delayMs: number) => {
    timer = setTimeout(() => {
      activeRun = run();
    }, delayMs);
    timer.unref?.();
  };
  const run = async () => {
    timer = undefined;
    try {
      const targets = collectOpenClawDatabaseVerifyTargets(options);
      if (targets.length > 0) {
        const results = await runDatabaseVerifyWorker(targets, {
          onWorker: (worker) => {
            activeWorker = worker;
          },
        });
        if (!stopped) {
          await applyOpenClawDatabaseVerificationResults({ ...options, results, targets });
          const stateTarget = targets.find((target) => target.kind === "state");
          if (
            stateTarget &&
            !results.some((result) => result.path === stateTarget.path && result.ok)
          ) {
            throw new Error("state database audit integrity verification did not pass");
          }
        }
      }
      consecutiveFailures = 0;
    } catch (error) {
      if (!stopped) {
        consecutiveFailures += 1;
        log.error("database integrity verifier failed", { error: String(error) });
        if (consecutiveFailures === MAX_STATE_AUDIT_VERIFIER_FAILURES) {
          unregisterStateAuditVerifier();
          log.error("state audit index deferral disabled after repeated verifier failures");
        }
      }
    } finally {
      activeWorker = undefined;
      if (!stopped) {
        schedule(
          consecutiveFailures > 0 && consecutiveFailures < MAX_STATE_AUDIT_VERIFIER_FAILURES
            ? OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS
            : OPENCLAW_DATABASE_VERIFY_INTERVAL_MS,
        );
      }
    }
  };

  return {
    syncStatePath: () => {
      if (stopped || armed) {
        return;
      }
      const selected = path.resolve(resolveOpenClawStateSqlitePath(options.env));
      if (selected !== statePath) {
        // Register the new physical target before releasing the old one.
        const unregisterSelected = registerOpenClawStateAuditIntegrityVerifier(selected);
        unregisterStateAuditVerifier();
        unregisterStateAuditVerifier = unregisterSelected;
        statePath = selected;
      }
    },
    arm: () => {
      if (!stopped && !armed) {
        armed = true;
        schedule(OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS);
      }
    },
    stop: async () => {
      if (stopped) {
        return await activeRun;
      }
      stopped = true;
      unregisterStateAuditVerifier();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        if (activeWorker) {
          await terminateDatabaseVerifyWorker(activeWorker);
        }
      } finally {
        // Worker exit can precede async confirmation and result application.
        await activeRun;
      }
    },
  };
}
