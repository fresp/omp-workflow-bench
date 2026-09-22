#!/usr/bin/env bash
# Stage 3: blind pairwise LLM judging, then the report (results/<label>/report.md).
#   ./bench.sh [--label L] [--judges a,b] [--length-matched]   judge (resumable) + report
#   ./bench.sh --report-only [--label L]
#
# A label's judgments/ must come from one roster. Re-judging with a different --judges set is
# refused unless --force, because two rosters on one label is why v0.12 ended up with 2 judges at
# 144 verdicts and 2 at 12 (see report.md Run health → judges with low coverage).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [[ "${1:-}" == "--report-only" ]]; then shift; exec node harness/report.mjs "$@"; fi

label=""
judges=""
force=0
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
	case "${args[$i]}" in
		--label) label="${args[$((i + 1))]:-}" ;;
		--judges) judges="${args[$((i + 1))]:-}" ;;
		--force) force=1 ;;
	esac
done
[[ -z "$label" ]] && label="$(cat results/LATEST 2>/dev/null || true)"

jdir="results/$label/judgments"
if [[ -n "$label" && -d "$jdir" && -n "$judges" && $force -eq 0 ]]; then
	existing="$(node -e '
const fs=require("fs"),p=process.argv[1];
const seen=new Set();
for(const d of fs.readdirSync(p,{withFileTypes:true})){if(!d.isDirectory())continue;
 for(const f of fs.readdirSync(p+"/"+d.name)){if(!f.endsWith(".json"))continue;
  try{const j=JSON.parse(fs.readFileSync(p+"/"+d.name+"/"+f,"utf8"));if(j.judge)seen.add(j.judge);}catch{}}}
console.log([...seen].sort().join(","));
' "$jdir")"
	if [[ -n "$existing" && "$existing" != "$judges" ]]; then
		echo "refusing to judge label '$label' with a different roster." >&2
		echo "  recorded: $existing" >&2
		echo "  requested: $judges" >&2
		echo "Pass --force to judge anyway (this mixes rosters on one label)." >&2
		exit 4
	fi
fi

node harness/judge.mjs "$@"
exec node harness/report.mjs "$@"
