#!/usr/bin/env bash
# HF-09 (2026.9.5 pins, 2026-09-23): restore the bundled-extension dependency overlay after any
# `npm install -g` of an openclaw core package (npm prunes undeclared
# packages from node_modules on every install).
#
# Stages the seven manifest-pinned direct packages with scripts disabled,
# copies only directories absent from the live core tree, and nests
# A2UI's zod@3 beneath @a2ui/lit and @a2ui/web_core so the root zod@4
# is never shadowed or replaced.  Safe to run under a live gateway:
# purely additive, touches no existing file.  Idempotent.
set -euo pipefail

ARG=${1:-}; [ "$ARG" = "--build-cache" ] && ARG=""
NM="${ARG:-${OPENCLAW_ROOT:-${HOME}/.npm-global/lib/node_modules/openclaw}}/node_modules"
[ -d "$NM" ] || { echo "no such core tree: $NM" >&2; exit 1; }

STAGE=$(mktemp -d /tmp/hf09-stage.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

# Prefer a pre-staged copy so a cutover does not depend on the npm registry being
# reachable at the moment of the overlay (build it with --build-cache).
CACHE=${HF09_STAGE:-${HOME}/.openclaw/hf09-stage-95.tgz}
stage_from_npm() {
  npm install --ignore-scripts --no-save --package-lock=false --prefix "$STAGE" \
    @a2ui/lit@0.10.3 @a2ui/web_core@0.10.7 @lit/context@1.1.6 lit@3.3.3 \
    mdast-util-from-markdown@2.0.3 jsonc-parser@3.3.1 markdown-it@15.0.2 \
    >/dev/null 2>&1
}
if [ "${1:-}" = "--build-cache" ]; then
  stage_from_npm || { echo "npm staging failed" >&2; exit 1; }
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
