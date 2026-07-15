#!/bin/zsh
set -e

APP_DIR="${0:A:h}"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN=""
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/share/mise/installs/node/*/bin/node(N); do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; fi
  done
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  osascript -e 'display alert "Node.js not found" message "Install Node.js 18 or newer, then build the portable installer again." as critical'
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  osascript -e 'display alert "Node.js is too old" message "Install Node.js 18 or newer, then build the portable installer again." as critical'
  exit 1
fi

"$NODE_BIN" "$APP_DIR/scripts/build-portable-package.mjs"
open -R "$APP_DIR/public/downloads/Claude-Codex-Router-UI.zip"
