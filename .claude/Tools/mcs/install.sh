#!/bin/bash
# MCS Install Script — Run on Mac Mini
# Creates directories, generates keys, installs launchd service
# Idempotent: safe to run multiple times. Use --force to reload an existing install.

set -euo pipefail

MCS_DIR="$HOME/.mcs"
PLIST_NAME="com.pai.mcs"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
MCS_SRC="$HOME/.claude/Tools/mcs"

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=true
      ;;
    --help|-h)
      echo "Usage: install.sh [--force]"
      echo ""
      echo "Options:"
      echo "  --force   Reinstall and reload even if MCS is already installed"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: install.sh [--force]" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Detect existing installation
# ---------------------------------------------------------------------------

IS_INSTALLED=false
if launchctl list 2>/dev/null | grep -q "$PLIST_NAME"; then
  IS_INSTALLED=true
fi

if [ "$IS_INSTALLED" = "true" ] && [ "$FORCE" = "false" ]; then
  echo "MCS already installed (service $PLIST_NAME is loaded)."
  echo ""
  echo "Status:  launchctl list | grep $PLIST_NAME"
  echo "Logs:    tail -f $MCS_DIR/logs/mcs.log"
  echo "Health:  curl http://localhost:7700/health"
  echo ""
  echo "To reinstall: $0 --force"
  exit 0
fi

if [ "$FORCE" = "true" ] && [ "$IS_INSTALLED" = "true" ]; then
  echo "Installing MCS... (forced reinstall)"
else
  echo "Installing MCS..."
fi

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------

mkdir -p "$MCS_DIR/logs" "$MCS_DIR/backups"
echo "  Created: $MCS_DIR/logs and $MCS_DIR/backups"

# ---------------------------------------------------------------------------
# Generate MCS keys — only add missing keys, never overwrite existing ones
# ---------------------------------------------------------------------------

ENV_FILE="$HOME/.claude/.env"
touch "$ENV_FILE"

KEYS_ADDED=false

for agent in OCASIA REX MOLLY PAISLEY DAN; do
  KEY_VAR="MCS_KEY_${agent}"
  if ! grep -q "^${KEY_VAR}=" "$ENV_FILE" 2>/dev/null; then
    KEY=$(openssl rand -hex 32)
    echo "${KEY_VAR}=${KEY}" >> "$ENV_FILE"
    echo "  Generated: $KEY_VAR"
    KEYS_ADDED=true
  fi
done

if ! grep -q "^MCS_ADMIN_SECRET=" "$ENV_FILE" 2>/dev/null; then
  ADMIN_KEY=$(openssl rand -hex 32)
  echo "MCS_ADMIN_SECRET=${ADMIN_KEY}" >> "$ENV_FILE"
  echo "  Generated: MCS_ADMIN_SECRET"
  KEYS_ADDED=true
fi

if [ "$KEYS_ADDED" = "true" ]; then
  echo "  Keys written to $ENV_FILE"
else
  echo "  Keys already present in $ENV_FILE — skipping generation"
fi

# ---------------------------------------------------------------------------
# Install (or update) launchd plist
# ---------------------------------------------------------------------------

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>${MCS_SRC}/server.ts</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${MCS_DIR}/logs/mcs.log</string>
  <key>StandardErrorPath</key>
  <string>${MCS_DIR}/logs/mcs.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

echo "  Plist written: $PLIST_PATH"

# ---------------------------------------------------------------------------
# Load (or reload) service
# ---------------------------------------------------------------------------

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "MCS installed and started"
echo "  Service: $PLIST_NAME"
echo "  Logs:    $MCS_DIR/logs/"
echo "  DB:      $MCS_DIR/mcs.db"
echo "  Health:  curl http://localhost:7700/health"
echo ""
echo "To check service status:"
echo "  launchctl list | grep $PLIST_NAME"
echo ""
echo "To tail logs:"
echo "  tail -f $MCS_DIR/logs/mcs.log"

# ---------------------------------------------------------------------------
# Ocasia agent registration launchd service
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Ocasia agent registration launchd service
# ---------------------------------------------------------------------------

AGENT_PLIST_NAME="com.pai.mcs-agent-ocasia"
AGENT_PLIST_PATH="$HOME/Library/LaunchAgents/${AGENT_PLIST_NAME}.plist"

cat > "$AGENT_PLIST_PATH" << AGENT_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>${MCS_SRC}/client/agent-register.ts</string>
    <string>--agent</string>
    <string>ocasia</string>
    <string>--caps</string>
    <string>camera,screen,filesystem,telegram,shell,web-search,coding-agent,github,pdf,image-gen,tts,cron,messaging,ollama-cloud,persistent-storage,tailscale,notify-push</string>
    <string>--notify-url</string>
    <string>http://100.113.192.4:18789</string>
    <string>--heartbeat</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${MCS_DIR}/logs/agent-ocasia.log</string>
  <key>StandardErrorPath</key>
  <string>${MCS_DIR}/logs/agent-ocasia.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
AGENT_PLIST

echo ""
echo "  Agent plist written: $AGENT_PLIST_PATH"

launchctl unload "$AGENT_PLIST_PATH" 2>/dev/null || true
launchctl load "$AGENT_PLIST_PATH"

echo ""
echo "Ocasia agent registration service installed"
echo "  Service: $AGENT_PLIST_NAME"
echo "  Logs:    $MCS_DIR/logs/agent-ocasia.log"
echo ""
echo "To check agent service status:"
echo "  launchctl list | grep $AGENT_PLIST_NAME"
echo ""
echo "To tail agent logs:"
echo "  tail -f $MCS_DIR/logs/agent-ocasia.log"
