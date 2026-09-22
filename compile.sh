#!/usr/bin/env bash
# Stage 2: grade every run (hidden tests, diff, scope, grounding) and write one bundle per run.
# Then verify the canonical token totals against omp's client counters (warns, never fails).
#   ./compile.sh [--label L] [--force]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
node harness/compile.mjs "$@"
exec node scripts/check-tokens.mjs "$@"
