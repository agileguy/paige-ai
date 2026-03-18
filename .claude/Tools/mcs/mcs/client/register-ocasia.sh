#!/bin/bash
# register-ocasia.sh — Register Ocasia's capabilities with MCS
#
# Run on Mac Mini. Can be called from OpenClaw startup hook or launchd.
# Runs in heartbeat mode: re-registers every 4 minutes to stay within
# the MCS 5-minute TTL.

set -euo pipefail

CAPS="camera,screen,filesystem,telegram,shell,web-search,coding-agent,github,pdf,image-gen,tts,cron,messaging,ollama-cloud,persistent-storage,tailscale,notify-push"
NOTIFY_URL="http://100.113.192.4:18789"  # OpenClaw gateway on Mac Mini

exec bun run "$HOME/.claude/Tools/mcs/client/agent-register.ts" \
  --agent ocasia \
  --caps "$CAPS" \
  --notify-url "$NOTIFY_URL" \
  --heartbeat
