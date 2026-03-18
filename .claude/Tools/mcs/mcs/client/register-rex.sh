#!/bin/bash
# register-rex.sh — Register Rex's capabilities with MCS
#
# Run on Boss (100.118.219.82). Can be called from OpenClaw startup hook
# or systemd. Runs in heartbeat mode: re-registers every 4 minutes to
# stay within the MCS 5-minute TTL.

set -euo pipefail

CAPS="screen,filesystem,telegram,shell,gpu,cron,messaging,ollama-cloud,persistent-storage,docker,tailscale,notify-push"
NOTIFY_URL="http://100.118.219.82:18789"  # OpenClaw gateway on Boss

exec bun run "$HOME/.claude/Tools/mcs/client/agent-register.ts" \
  --agent rex \
  --caps "$CAPS" \
  --notify-url "$NOTIFY_URL" \
  --heartbeat
