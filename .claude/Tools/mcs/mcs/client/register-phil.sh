#!/bin/bash
# register-phil.sh — Register Phil's capabilities with MCS
#
# Run on TUF. Runs in heartbeat mode: re-registers every 4
# minutes to stay within the MCS 5-minute TTL.

set -euo pipefail

CAPS="gpu,filesystem,telegram,shell,web-search,messaging,ollama-cloud,ollama-local,docker,tailscale,notify-push"
NOTIFY_URL="http://100.72.120.118:18789"  # OpenClaw gateway on TUF via Tailscale

exec bun run "$HOME/.claude/Tools/mcs/client/agent-register.ts" \
  --agent phil \
  --caps "$CAPS" \
  --notify-url "$NOTIFY_URL" \
  --heartbeat
