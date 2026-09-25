# HF-09: restore bundled-extension dependencies after a core install

The 2026.9.5 package omits seven direct runtime packages used by canvas,
Memory Wiki, and oc-path. This script stages exactly the pinned versions with
npm lifecycle scripts disabled and copies only *missing* directories into the
installed OpenClaw core's `node_modules`; it does not rewrite manifests or
replace existing packages. The A2UI packages receive their own nested zod v3,
leaving root zod v4 untouched.

After an operator installs or upgrades a core package, stage an offline cache
in advance with `bash overlay.sh --build-cache` if package-registry access at
cutover is uncertain. Set `HF09_STAGE` to choose the cache file. While the
Gateway is stopped for an operator-controlled package swap, run
`bash overlay.sh /absolute/path/to/installed/openclaw` and require the
`HF-09 overlay OK` import check before restarting. The default installed core
location is `$OPENCLAW_ROOT`, else `$HOME/.npm-global/lib/node_modules/openclaw`.
The script may populate its cache from npm if no staged archive exists. No
part of this fork PR applies the overlay automatically.

This is a fork-local 2026.9.5 reapplication artifact, not an upstream
packaging change. The behavior and validation gate are described in the
operator's `HOTFIXES.md` HF-09 entry.
