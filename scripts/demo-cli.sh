#!/usr/bin/env bash
# demo-cli.sh — guard-railed Avalanche CLI wrapper for the isolated demo runtime.
#
# Forces RUN_CLI_E2E=1 so the CLI v1.9.6 baseDir resolves to ~/.avalanche-cli/e2e
# instead of the historical ~/.avalanche-cli state (verified in probe-001).
# The export below cannot be blanked out by the caller: it is set here, after
# the caller's environment is already in place. All demo-related CLI operations
# must go through this entry point.
#
# Usage: ./scripts/demo-cli.sh <avalanche args...>
set -euo pipefail

export RUN_CLI_E2E=1
exec avalanche "$@"
