#!/bin/bash
# register-molly.sh — Register Molly's capabilities with MCS
#
# Run on Pi 5 (100.76.206.8). Can be called from Moltis startup hook
# or systemd. Runs in heartbeat mode: re-registers every 4 minutes to
# stay within the MCS 5-minute TTL.

set -euo pipefail

CAPS="filesystem,telegram,shell,ollama-local,ollama-cloud,messaging,low-power,tailscale,notify-push"
NOTIFY_URL="http://100.76.206.8:13131"  # Moltis gateway on Pi 5

exec bun run "$HOME/.claude/Tools/mcs/client/agent-register.ts" \
  --agent molly \
  --caps "$CAPS" \
  --notify-url "$NOTIFY_URL" \
  --heartbeat
