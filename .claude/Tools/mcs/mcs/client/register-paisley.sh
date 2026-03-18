#!/bin/bash
# register-paisley.sh — Register Paisley's capabilities with MCS
#
# Run on MacBook (local). Runs in heartbeat mode: re-registers every 4
# minutes to stay within the MCS 5-minute TTL.

set -euo pipefail

CAPS="filesystem,telegram,shell,web-search,github,calendar,messaging,ollama-cloud,tailscale,notify-push"
NOTIFY_URL="http://100.94.64.48:9876"  # Webhook listener via Tailscale (mac VM)

exec bun run "$HOME/.claude/Tools/mcs/client/agent-register.ts" \
  --agent paisley \
  --caps "$CAPS" \
  --notify-url "$NOTIFY_URL" \
  --heartbeat
