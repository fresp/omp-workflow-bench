#!/usr/bin/env bash
# Exercise the whole pipeline (run → compile → judge → report) against a fake omp and a fake LLM.
# No model calls, no tokens. Use it after editing the harness.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tmp="$(mktemp -d)"
touch "$tmp/ext.ts"
export BENCH_FAKE_LLM=1 BENCH_OMP_BIN="$PWD/harness/test/fake-omp.mjs" BENCH_READYSET_EXT="$tmp/ext.ts" BENCH_WORK_DIR="$tmp/work" BENCH_IDLE_SECONDS=2
export BENCH_QUICKCHECK_JSON='{"userEditsPreserved": true}'
prev_latest="$(cat results/LATEST 2>/dev/null || true)"
rm -rf results/_smoke
# T03 runs with --dirty-workspace so compile emits userEditsPreserved; T01/T04 exercise the
# normal path. The readyset arm gets the fake CONTEXT.md markers via fake-omp.
node harness/run.mjs T01 T04 --reps 1 --label _smoke --models fake/model --arms plan,readyset-fast
node harness/run.mjs T03 --reps 1 --label _smoke --models fake/model --arms plan,readyset-fast --dirty-workspace
node harness/compile.mjs --label _smoke
node harness/judge.mjs --label _smoke
node harness/report.mjs --label _smoke
node harness/quick-check.mjs --label _smoke --baseline _smoke
python3 - <<'EOF'
import json
c = json.load(open('results/_smoke/T03-discount-rounding-bug/readyset-fast__fake_model__r1/compiled.json'))
assert c['userEditsPreserved'] is True, c.get('userEditsPreserved')
assert c['mechanisms']['measurable'] is True
assert c['review']['triggersFired'] == ['diff-size'], c['review']
qc = open('results/_smoke/quick-check.md').read()
assert 'user edits preserved' in qc, qc
print('part-6 assertions: userEditsPreserved:true, markers parsed, quick-check.md written')
EOF
test -s results/_smoke/quick-check.md && echo "quick-check OK → results/_smoke/quick-check.md"
test -s results/_smoke/report.md && echo "offline smoke OK → results/_smoke/report.md"
rm -rf "$tmp"
if [[ -n "$prev_latest" ]]; then echo "$prev_latest" > results/LATEST; else rm -f results/LATEST; fi
