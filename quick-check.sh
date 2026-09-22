#!/usr/bin/env bash
# Quick check: pass/fail a wave of readyset changes against a baseline label's /plan arm.
#   ./quick-check.sh --label <new> [--baseline v0.12]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node harness/quick-check.mjs "$@"
