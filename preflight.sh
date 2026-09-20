#!/usr/bin/env bash
# Check omp, models, the readyset extension and the task set before a long run. Changes nothing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node harness/preflight.mjs "$@"
