# HF-09: restore bundled-extension dependencies after a core install

The 2026.9.5 package omits seven direct runtime packages used by canvas,
Memory Wiki, and oc-path. The checked-in `package-lock.json` records the
complete 58-package graph from the validated 2026.9.5 stage archive, including
npm's original registry integrity values. The script uses `npm ci` with
lifecycle scripts disabled and installs missing package directories through
same-filesystem temporary copies and renames. On reapplication, it restores
incomplete package directories from the verified stage (including scoped and
nested zod packages), but leaves complete and different-version packages alone.
A2UI packages receive their own nested zod v3 only when their installed
versions match the validated stage; different installed versions remain
untouched. An absent or non-v4 root zod rejects application before any mutation,
and staged zod is never copied into the root.

Before installing the 2026.9.5 core, stage an offline cache with
`bash overlay.sh --build-cache` if package-registry access at cutover is uncertain;
cache building does not require an installed core. A failed cache rebuild leaves
the previous archive intact; the replacement is renamed into place only after
tar succeeds. Set `HF09_STAGE` to choose the cache file. While the
Gateway is stopped for an operator-controlled package swap, run
`bash overlay.sh /absolute/path/to/installed/openclaw` and require the
`HF-09 overlay OK` import check before restarting. The default installed core
location is `$OPENCLAW_ROOT`, else `$HOME/.npm-global/lib/node_modules/openclaw`.
The script verifies the staged package inventory against the lock and hashes its
file contents and symlink targets against the validated stage archive before any
copy. It may populate the stage from npm if no cached archive exists. Application rejects core versions other
than 2026.9.5; do not reapply this graph after upgrading to a different release.
Each package directory is installed by rename, but reapplication and recovery
are not an atomic transaction across the full dependency graph: do not run the
apply path while the Gateway is active. No part of this fork PR applies the
overlay automatically.

This is a fork-local 2026.9.5 reapplication artifact, not an upstream
packaging change. The behavior and validation gate are described in the
operator's `HOTFIXES.md` HF-09 entry.
