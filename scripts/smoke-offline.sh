#!/usr/bin/env bash
# Exercise the whole pipeline (run → compile → judge → report) against a fake omp and a fake LLM.
# No model calls, no tokens. Use it after editing the harness.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tmp="$(mktemp -d)"
touch "$tmp/ext.ts"
export BENCH_FAKE_LLM=1 BENCH_OMP_BIN="$PWD/harness/test/fake-omp.mjs" BENCH_READYSET_EXT="$tmp/ext.ts" BENCH_WORK_DIR="$tmp/work" BENCH_IDLE_SECONDS=2
prev_latest="$(cat results/LATEST 2>/dev/null || true)"
rm -rf results/_smoke
node harness/run.mjs T01 T04 --reps 1 --label _smoke --models fake/model --arms plan,readyset-fast
node harness/compile.mjs --label _smoke
node harness/judge.mjs --label _smoke
node harness/report.mjs --label _smoke
test -s results/_smoke/report.md && echo "offline smoke OK → results/_smoke/report.md"
rm -rf "$tmp"
if [[ -n "$prev_latest" ]]; then echo "$prev_latest" > results/LATEST; else rm -f results/LATEST; fi
