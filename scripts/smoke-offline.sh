#!/usr/bin/env bash
# Exercise the whole pipeline (run → compile → judge → report) against a fake omp and a fake LLM.
# No model calls, no tokens. Use it after editing the harness.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tmp="$(mktemp -d)"
# A minimal extension tree at a neutral path: stageExtension copies src/extensions, src/lib and
# src/skill, so the fake extension must live inside that shape.
mkdir -p "$tmp/fake-ext/src/extensions" "$tmp/fake-ext/src/lib" "$tmp/fake-ext/src/skill"
touch "$tmp/fake-ext/src/extensions/ext.ts" "$tmp/fake-ext/src/skill/SKILL.md"
export BENCH_FAKE_LLM=1 BENCH_OMP_BIN="$PWD/harness/test/fake-omp.mjs" BENCH_READYSET_EXT="$tmp/fake-ext/src/extensions/ext.ts" BENCH_WORK_DIR="$tmp/work" BENCH_IDLE_SECONDS=2
export BENCH_QUICKCHECK_JSON='{"userEditsPreserved": true}'
# The fake omp must run inside the same bwrap wrapper the real arm drivers build: qc-1's omp died
# with "Config overlay not found" because the sandbox mounts the cell's output dir at a neutral
# path, and the smoke passed only because sandboxArgs() skips sandboxing for a .mjs binary.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/bwrap" <<'SH'
#!/usr/bin/env bash
# Recording stub for the offline smoke: the fake omp sees the same in-sandbox paths the real one
# would (/run/cell/…), translated back to the host cell dir — the harness's sandboxArgs binds the
# cell there, and the recorded prefix is where the /run/cell assertion reads it from.
# NOTE: for .mjs the payload is launched via node — bash cannot exec a script argv directly, and real
# bwrap would not run the payload at all (useSandbox skips .mjs outside the smoke).
printf '%s\n' "$*" >> "${BENCH_BWRAP_LOG:?BENCH_BWRAP_LOG unset}"
args=()
skip=0
cell_host=
last_flag=
last_arg=
for a in "$@"; do
  # consume the wrapper's own leading options (--ro-bind/--bind pairs, --dev/--proc/--tmpfs pairs,
  # --chdir, --unshare-pid), remembering the cell mount's host side; then run whatever remains
  if (( skip > 0 )); then
    if [[ "$last_flag" == "--ro-bind" && "$a" == "/run/cell" ]]; then cell_host="$last_arg"; fi
    last_arg="$a"; skip=$((skip - 1)); continue
  fi
  case "$a" in
    --ro-bind|--bind) skip=2; last_flag="$a"; continue ;;
    --dev|--proc|--tmpfs|--chdir) skip=1; last_flag="$a"; continue ;;
    --unshare-pid) continue ;;
  esac
  args+=("$a")
done
if [[ -n "$cell_host" ]]; then
  # rewrite /run/cell/… payload args back to the host cell dir (no confinement in the stub)
  rewritten=()
  for a in "${args[@]}"; do
    [[ "$a" == /run/cell/* ]] && a="$cell_host${a#/run/cell}"
    rewritten+=("$a")
  done
  args=("${rewritten[@]}")
fi
if [[ "${args[0]:-}" == *.mjs ]]; then exec node "${args[@]}"; else exec "${args[@]}"; fi
SH
chmod +x "$tmp/bin/bwrap"
export BENCH_BWRAP_LOG="$tmp/bwrap.log"
export BENCH_BWRAP_BIN="$tmp/bin/bwrap"
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
import json, os
c = json.load(open('results/_smoke/T03-discount-rounding-bug/readyset-fast__fake_model__r1/compiled.json'))
assert c['userEditsPreserved'] is True, c.get('userEditsPreserved')
detail = c['userEditsDetail']
assert isinstance(detail, list) and len(detail) == 3, detail
assert all(d['pass'] for d in detail), detail
assert {d['kind'] for d in detail} == {'expected-touch', 'unexpected-touch', 'untracked'}, detail
assert c['mechanisms']['measurable'] is True
assert c['mechanisms']['outsideRepo'] == 0 and c['mechanisms']['outsideRepoTmp'] == 0, c['mechanisms']
assert c['review']['triggersFired'] == ['diff-size'], c['review']
qc = open('results/_smoke/quick-check.md').read()
assert 'user edits preserved' in qc, qc
assert 'outside-repo hits at the gate' in qc, qc
rep = open('results/_smoke/report.md').read()
for row in ('outside-repo hits at the gate', '/tmp hits at the gate', 'escape tripwire hits, extension-src', 'escape tripwire hits, other'):
    assert row in rep, f'missing report row: {row}'
# The fake omp really ran through the bwrap wrapper, i.e. the cell mount made it into the prefix the
# arms build — this is the assertion that would have caught qc-1 offline.
log = open(os.environ['BENCH_BWRAP_LOG']).read()
assert '/run/cell' in log, log[:2000]
print('part-6 assertions: userEditsPreserved:true (3/3 kinds), markers parsed, gate outsideRepo/outsideRepoTmp, new report rows, quick-check.md written, cell mount at /run/cell')
EOF
test -s results/_smoke/quick-check.md && echo "quick-check OK → results/_smoke/quick-check.md"
test -s results/_smoke/report.md && echo "offline smoke OK → results/_smoke/report.md"
rm -rf "$tmp"
if [[ -n "$prev_latest" ]]; then echo "$prev_latest" > results/LATEST; else rm -f results/LATEST; fi
