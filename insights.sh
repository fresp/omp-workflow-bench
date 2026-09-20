#!/usr/bin/env bash
# Stage 4: improvement digest → results/<label>/improve.md. Reads only; no LLM calls.
#   ./insights.sh [--label L]      (defaults to the latest run)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node harness/insights.mjs "$@"
