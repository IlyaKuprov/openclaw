import {
  deferOpenClawAgentPostCommitPublication,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveStateDir } from "../paths.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";

export function captureLifecycleDatabaseScope<T extends ResolvedSqliteReadScope>(scope: T): T {
  const env = { ...(scope.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  return {
    ...scope,
    env,
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions({ ...scope, env })),
  };
}

export async function withCommittedHistoryMaintenance<T>(
  { agentId, env, storePath }: { agentId?: string; env?: NodeJS.ProcessEnv; storePath: string },
  run: (
    recordCommit: (database: OpenClawAgentDatabase) => void,
    markCommitted: () => void,
  ) => Promise<T>,
  options: { scheduleNext?: boolean } = {},
): Promise<T> {
  let committed = false;
  try {
    return await run(
      (database) => {
        deferOpenClawAgentPostCommitPublication(database, () => {
          committed = true;
        });
      },
      () => {
        committed = true;
      },
    );
  } finally {
    // A partial commit still needs maintenance, but only after archive publication and
    // lifecycle-owner cleanup finish. Rejected preparation or rollback creates no pressure.
    if (committed && options.scheduleNext !== false) {
      kickSessionHistoryDiskBudgetMaintenance({ agentId, env, storePath, force: true });
    }
  }
}
