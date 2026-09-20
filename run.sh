#!/usr/bin/env bash
# Stage 1: run the matrix (tasks × models.txt × reps × {/plan, /readyset}). Resumable.
#   ./run.sh                     everything, new label (timestamp)
#   ./run.sh T01 T04 --reps 1    a subset
#   ./run.sh --label 2026-09-20-10-00   resume an interrupted run
#   ./run.sh --dry-run           just print the cells
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node harness/run.mjs "$@"
