# Claude × Codex Router UI

Local macOS control panel for configuring and managing a global Claude Code → Codex routing policy.

Claude itself stays controlled by the active Claude window. The model, effort, and thinking settings selected in Claude are not overridden by this app. The router controls when Codex is delegated to, when a plan is audited, and which Codex model/effort is used for those calls.

The **Task & token history** tab reads local `~/.claude/projects` and `~/.codex/sessions` logs. Token numbers are client-side technical counters, not billing totals or exact corporate subscription usage. The same tab can install a local decision logger for `Claude-only / delegated / audit` routing decisions.

## Install from npm

The package is published as a macOS developer tool with no `postinstall` side effects. Installing it from npm does not modify `~/.claude`, add a LaunchAgent, or install the Claude/Codex bridge plugin. Local system changes happen only after an explicit command.

Run once without installing globally:

```bash
npx @alex_moroz/claude-codex-router start
```

Install the local background panel:

```bash
npm i -g @alex_moroz/claude-codex-router
claude-codex-router install
```

Available commands:

```bash
claude-codex-router start          # foreground server at http://127.0.0.1:4177
claude-codex-router install        # install/repair the macOS LaunchAgent and open the UI
claude-codex-router uninstall      # remove only the background service
claude-codex-router open           # open the UI
claude-codex-router doctor         # print local Claude/Codex/plugin/routing status
claude-codex-router build-portable # build a ZIP installer for another Mac
```

## Install as a desktop PWA on macOS

1. Open `Install Desktop PWA.command`.
2. If Node.js 18+ is missing, the bootstrapper downloads pinned Node.js `v22.13.1` from `nodejs.org`, verifies its SHA-256, and stores it under `~/Library/Application Support/ClaudeCodexRouter/runtime`. It does not use `sudo` and does not change the system Node installation.
3. The script installs a small local background service and opens the panel in Chrome.
4. Open **Setup from zero** and complete the six checks.
5. When setup is ready, press **Install app** and confirm the browser prompt.

After that, **AI Router** appears in Launchpad/Dock and opens as a standalone window. The background service starts at macOS login, so the shortcut can always reach the local configuration panel.

The installer does not require administrator privileges. It creates a user LaunchAgent, and if Node is missing, a private Router runtime:

```text
~/Library/LaunchAgents/com.local.claude-codex-router-ui.plist
```

To remove the background service, run `Uninstall Background Service.command`. Routing configuration and backups are kept.

If the app folder is moved, run the installer again so the LaunchAgent points to the new path.

## Setup from zero

The **Setup from zero** wizard configures the system layer by layer:

1. Checks Node.js, npm, and Git.
2. Detects Claude Desktop/CLI and opens `claude auth login --sso` in a visible Terminal window. Corporate SSO happens directly with Claude; Router does not read credentials.
3. Detects or installs `@openai/codex` into `~/.claude-codex-router/tools`, then opens the normal `codex login` flow for ChatGPT subscription OAuth.
4. Uses the official Claude CLI to add `openai/codex-plugin-cc` and install `codex@openai-codex` in user scope.
5. Applies the routing policy and decision logger with backups.
6. Runs a token-free self-check for plugin runtime → Codex auth. The optional **Live handshake** runs one short Codex turn and does not read or modify files.

Setup processes remove `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and custom base URLs only from their child environment. If those overrides are stored in Claude settings, the UI warns about them but does not silently delete user configuration.

If corporate policy sets `strictKnownMarketplaces` or `allowManagedHooksOnly`, the wizard shows the blocked layer. Managed policy is not bypassed: an administrator must allow `openai/codex-plugin-cc` and/or user hooks.

## Install on another Mac

Press **Export installer** in the top bar or run `Build Portable Installer.command`. It creates:

```text
public/downloads/Claude-Codex-Router-UI.zip
```

Send the ZIP to another Mac, unzip it, and open `Install Desktop PWA.command`. The installer detects Homebrew, NVM, or mise Node.js; if none is available, it installs a private pinned runtime. It does not depend on paths from the original machine.

Requirements on the target Mac:

- macOS;
- access to the corporate Claude workspace and ChatGPT/Codex subscription;
- network access to `claude.ai`, `nodejs.org`, GitHub marketplace, and ChatGPT OAuth during first setup.

Credentials, routing configuration, and backups are not included in the ZIP.

## Router decision log

The **Install logger** button in the history tab:

- copies the local logger to `~/.claude/router-hooks/route-logger.mjs`;
- safely adds its entries to `~/.claude/settings.json` without removing unrelated hooks or corporate settings;
- writes only routing metadata to `~/.claude/router-history/events.jsonl`: decision type, Codex model, effort, verdict, session id, timestamp, and working directory;
- does not store prompts, responses, file contents, or code.

**Repair** restores only this utility's hooks. **Uninstall** removes the logger and its Claude settings entries but keeps local history. Before every `settings.json` change, a backup is created in `~/.claude/router-hooks/backups/`.

If Claude corporate policy has `allowManagedHooksOnly: true`, the UI reports the restriction. User hooks will not run without administrator approval even if the installer files are written locally.

## Run without installing

Open `start.command` or run:

```bash
./start.command
```

The panel opens at `http://127.0.0.1:4177`. The server listens only on localhost and does not use API keys.

## What changes

When **Apply routing policy** is pressed, the UI writes:

```text
~/.claude/rules/agent-routing.md
```

Before every overwrite, the previous version is saved in:

```text
~/.claude/rules/.routing-ui-backups/
```

The first save puts the file under UI management. If a file already exists, it is copied to a backup first. **Restore last backup** restores the latest version.

Open a new Local Code session in Claude Desktop after applying changes.

## Development

```bash
npm test
npm run pack:check
```

The app has no runtime dependencies outside Node.js standard modules.

## Publishing

The package is prepared for npm as `@alex_moroz/claude-codex-router`.

```bash
npm test
npm run pack:check
npm publish --access public
```

If npm requires 2FA, add the current authenticator code:

```bash
npm publish --access public --otp=123456
```
