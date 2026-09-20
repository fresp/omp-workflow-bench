#!/usr/bin/env bash
# Stage 2: grade every run (hidden tests, diff, scope, grounding) and write one bundle per run.
#   ./compile.sh [--label L] [--force]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node harness/compile.mjs "$@"
