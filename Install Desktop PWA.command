#!/bin/zsh
set -e

APP_DIR="${0:A:h}"
LABEL="com.local.claude-codex-router-ui"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
URL="http://127.0.0.1:4177"
NODE_VERSION="v22.13.1"
RUNTIME_ROOT="$HOME/Library/Application Support/ClaudeCodexRouter/runtime"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node(N) "$HOME"/.local/share/mise/installs/node/*/bin/node(N); do
    if [[ -x "$candidate" ]]; then print -r -- "$candidate"; return; fi
  done
}

install_local_node() {
  local machine arch archive checksum runtime_dir temp_dir
  machine="$(uname -m)"
  case "$machine" in
    arm64) arch="arm64"; checksum="97483ff4361d239a56d038c6335767a56a291e78c10f07446f463f05d9d19b89" ;;
    x86_64) arch="x64"; checksum="6fdcc8412d434664238b0651ebd5ad55d15a08598ff42dcb6d9cf1d434a6c4be" ;;
    *) return 1 ;;
  esac
  archive="node-$NODE_VERSION-darwin-$arch.tar.gz"
  runtime_dir="$RUNTIME_ROOT/node-$NODE_VERSION-darwin-$arch"
  if [[ -x "$runtime_dir/bin/node" ]]; then
    print -r -- "$runtime_dir/bin/node"
    return
  fi
  mkdir -p "$RUNTIME_ROOT"
  temp_dir="$(mktemp -d)"
  print -r -- "Node.js 18+ не знайдено. Завантажую pinned runtime $NODE_VERSION з nodejs.org…" >&2
  /usr/bin/curl -fL --retry 2 "https://nodejs.org/dist/$NODE_VERSION/$archive" -o "$temp_dir/$archive"
  print -r -- "$checksum  $temp_dir/$archive" | /usr/bin/shasum -a 256 -c - >/dev/null
  /usr/bin/tar -xzf "$temp_dir/$archive" -C "$RUNTIME_ROOT"
  /bin/rm -rf "$temp_dir"
  [[ -x "$runtime_dir/bin/node" ]] || return 1
  print -r -- "$runtime_dir/bin/node"
}

NODE_BIN="$(find_node || true)"

if [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]]; then
  NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
else
  NODE_MAJOR=0
fi

if [[ "$NODE_MAJOR" -lt 18 ]]; then
  NODE_BIN="$(install_local_node || true)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  osascript -e 'display alert "Router runtime could not be installed" message "Node.js download failed or this Mac architecture is unsupported. Check the network connection and run the installer again." as critical'
  exit 1
fi

if [[ ! -f "$APP_DIR/public/downloads/Claude-Codex-Router-UI.zip" ]]; then
  "$NODE_BIN" "$APP_DIR/scripts/build-portable-package.mjs" >/dev/null
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

plutil -create xml1 "$PLIST"
/usr/libexec/PlistBuddy -c "Add :Label string $LABEL" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $NODE_BIN" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $APP_DIR/server.mjs" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string --no-open" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string $APP_DIR" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProcessType string Background" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LOG_DIR/ClaudeCodexRouterUI.log" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LOG_DIR/ClaudeCodexRouterUI.error.log" "$PLIST"
chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  plutil -p "$PLIST"
  exit 0
fi

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

for attempt in {1..30}; do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  osascript -e 'display alert "Router did not start" message "Check ~/Library/Logs/ClaudeCodexRouterUI.error.log. Another app may already use port 4177." as critical'
  exit 1
fi

if [[ -d "/Applications/Google Chrome.app" ]]; then
  open -a "Google Chrome" "$URL"
else
  open "$URL"
fi

osascript -e 'display notification "Відкрий Setup from zero і пройди послідовні перевірки Claude → Codex." with title "Claude × Codex Router is running"'
