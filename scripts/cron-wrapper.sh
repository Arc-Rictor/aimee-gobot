#!/usr/bin/env bash
# cron-wrapper.sh — sets up PATH and runs bun scripts from the gobot directory
# Usage: cron-wrapper.sh <script-name>  (e.g. heartbeat:discord, reflection:discord)

set -euo pipefail

# Cron has a minimal PATH — add bun, node, etc.
export PATH="/home/aimee/.bun/bin:/home/aimee/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin"

# Load any env vars from .env
GOBOT_DIR="/home/aimee/gobot"
cd "$GOBOT_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

SCRIPT_NAME="${1:?Usage: cron-wrapper.sh <script-name>}"

echo "--- $(date -u '+%Y-%m-%d %H:%M:%S UTC') running: $SCRIPT_NAME ---"
timeout 900 bun run "$SCRIPT_NAME"
EXIT_CODE=$?
if [ $EXIT_CODE -eq 124 ]; then
  echo "TIMEOUT: $SCRIPT_NAME exceeded 15 minutes"
fi
exit $EXIT_CODE
