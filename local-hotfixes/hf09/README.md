# HF-09: restore bundled-extension dependencies after a core install

The 2026.9.5 package omits seven direct runtime packages used by canvas,
Memory Wiki, and oc-path. The checked-in `package-lock.json` records the
complete 58-package graph from the validated 2026.9.5 stage archive, including
npm's original registry integrity values. The script uses `npm ci` with
lifecycle scripts disabled and copies only _missing_ directories into the
installed OpenClaw core's `node_modules`; it does not rewrite manifests or
replace existing packages. The A2UI packages receive their own nested zod v3,
leaving root zod v4 untouched.

Before installing the 2026.9.5 core, stage an offline cache with
`bash overlay.sh --build-cache` if package-registry access at cutover is uncertain;
cache building does not require an installed core. Set `HF09_STAGE` to choose the cache file. While the
Gateway is stopped for an operator-controlled package swap, run
`bash overlay.sh /absolute/path/to/installed/openclaw` and require the
`HF-09 overlay OK` import check before restarting. The default installed core
location is `$OPENCLAW_ROOT`, else `$HOME/.npm-global/lib/node_modules/openclaw`.
The script verifies the staged package inventory against the lock and hashes its
file contents and symlink targets against the validated stage archive before any
copy. It may populate the stage from npm if no cached archive exists. Application rejects core versions other
than 2026.9.5; do not reapply this graph after upgrading to a different release.
Package copies are not atomic, so do not run the apply path while the Gateway is
active. No part of this fork PR applies the overlay automatically.

This is a fork-local 2026.9.5 reapplication artifact, not an upstream
packaging change. The behavior and validation gate are described in the
operator's `HOTFIXES.md` HF-09 entry.
