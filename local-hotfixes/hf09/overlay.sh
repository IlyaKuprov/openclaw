#!/usr/bin/env bash
# HF-09 (2026.9.5 pins, 2026-09-23): restore the bundled-extension dependency overlay after any
# `npm install -g` of an openclaw core package (npm prunes undeclared
# packages from node_modules on every install).
#
# Stages the locked dependency graph with scripts disabled, copies only
# directories absent from the stopped 2026.9.5 core tree, and nests A2UI's
# zod@3 beneath @a2ui/lit and @a2ui/web_core so root zod@4 stays untouched.
# The operator stops the Gateway before applying: package copies are not atomic.
set -euo pipefail

ROOT="${1:-${OPENCLAW_ROOT:-${HOME}/.npm-global/lib/node_modules/openclaw}}"
NM="$ROOT/node_modules"
if [ "${1:-}" != "--build-cache" ]; then
  [ -d "$NM" ] || { echo "no such core tree: $NM" >&2; exit 1; }
  node -e 'const p=require(process.argv[1]); if(p.version!=="2026.9.5") { console.error(`HF-09 requires OpenClaw 2026.9.5; found ${p.version}`); process.exit(1) }' "$ROOT/package.json"
fi

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STAGE=$(mktemp -d /tmp/hf09-stage.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

# Prefer a pre-staged copy so a cutover does not depend on the npm registry being
# reachable at the moment of the overlay (build it with --build-cache).
CACHE=${HF09_STAGE:-${HOME}/.openclaw/hf09-stage-95.tgz}
stage_from_npm() {
  cp "$HERE/package.json" "$HERE/package-lock.json" "$STAGE/"
  npm ci --ignore-scripts --no-audit --no-fund --prefix "$STAGE" >/dev/null
}
verify_stage() {
  node - "$STAGE" "$HERE/package-lock.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stage = process.argv[2];
const locked = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).packages;
const staged = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules/.package-lock.json'), 'utf8')).packages;
const names = Object.keys(locked).filter((name) => name.startsWith('node_modules/'));
const modules = path.join(stage, 'node_modules');
const present = fs.readdirSync(modules, { withFileTypes: true }).flatMap((entry) =>
  entry.name.startsWith('@')
    ? fs.readdirSync(path.join(modules, entry.name)).map((name) => `node_modules/${entry.name}/${name}`)
    : entry.isDirectory() && entry.name !== '.bin' ? [`node_modules/${entry.name}`] : []);
if (present.length !== names.length || present.some((name) => !locked[name]) ||
  Object.keys(staged).length !== names.length || names.some((name) =>
    locked[name].version !== staged[name]?.version ||
    locked[name].integrity !== staged[name]?.integrity ||
    !fs.existsSync(path.join(stage, name, 'package.json')))) {
  console.error('HF-09 stage does not match the locked dependency inventory');
  process.exit(1);
}
// Digest of the validated 2026.9.5 stage archive's file bytes and symlink targets.
// The hidden npm metadata is checked against the lock above, so omit its formatting.
const content = crypto.createHash('sha256');
function walk(dir = '') {
  for (const name of fs.readdirSync(path.join(modules, dir)).sort()) {
    const relative = path.join(dir, name);
    const absolute = path.join(modules, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) walk(relative);
    else if (relative !== '.package-lock.json') {
      content.update(relative).update('\0').update(stat.isSymbolicLink() ? 'L' : 'F').update('\0')
        .update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute)).update('\0');
    }
  }
}
walk();
if (content.digest('hex') !== '32660b60034b423470a8279c6d9989a85e62dc6683f9592b7dd7d34cae0b8029') {
  console.error('HF-09 stage contents differ from the validated dependency archive');
  process.exit(1);
}
NODE
}
if [ "${1:-}" = "--build-cache" ]; then
  stage_from_npm || { echo "npm staging failed" >&2; exit 1; }
  verify_stage
  mkdir -p "$(dirname "$CACHE")"
  tar -czf "$CACHE" -C "$STAGE" node_modules
  echo "HF-09 stage cache written: $CACHE ($(du -h "$CACHE" | cut -f1))"
  exit 0
fi
if [ -f "$CACHE" ]; then
  tar -xzf "$CACHE" -C "$STAGE" || { echo "stage cache unusable: $CACHE" >&2; exit 1; }
else
  stage_from_npm || { echo "npm staging failed and no cache at $CACHE" >&2; exit 1; }
fi
verify_stage

added=0
for d in "$STAGE"/node_modules/*/; do
  name=$(basename "$d")
  [ "$name" = ".bin" ] && continue
  if [ "${name#@}" != "$name" ]; then
    mkdir -p "$NM/$name"
    for sub in "$d"*/; do
      subname="$name/$(basename "$sub")"
      [ -d "$NM/$subname" ] || { cp -r "$sub" "$NM/$subname"; added=$((added+1)); }
    done
  else
    [ -d "$NM/$name" ] || { cp -r "$d" "$NM/$name"; added=$((added+1)); }
  fi
done

for p in @a2ui/lit @a2ui/web_core; do
  if [ -d "$NM/$p" ] && [ ! -d "$NM/$p/node_modules/zod" ]; then
    mkdir -p "$NM/$p/node_modules"
    cp -r "$STAGE/node_modules/zod" "$NM/$p/node_modules/zod"
  fi
done

cd "$(dirname "$NM")"
node -e 'Promise.all([import("lit"),import("jsonc-parser"),import("markdown-it"),import("@a2ui/lit"),import("@lit/context"),import("mdast-util-from-markdown")]).then(()=>console.log("HF-09 overlay OK (added '"$added"' dirs)")).catch(e=>{console.error("HF-09 overlay FAILED:",e.message);process.exit(1)})'
