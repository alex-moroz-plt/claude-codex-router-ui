#!/bin/zsh
set -e

LABEL="com.local.claude-codex-router-ui"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
if [[ -f "$PLIST" ]]; then
  unlink "$PLIST"
fi

osascript -e 'display notification "Background server removed. The routing config and backups were kept." with title "Claude × Codex Router"'
