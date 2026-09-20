#!/usr/bin/env bash
# Stage 3: blind pairwise LLM judging, then the report (results/<label>/report.md).
#   ./bench.sh [--label L]              judge (resumable) + report
#   ./bench.sh --report-only [--label L]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [[ "${1:-}" == "--report-only" ]]; then shift; exec node harness/report.mjs "$@"; fi
node harness/judge.mjs "$@"
exec node harness/report.mjs "$@"
