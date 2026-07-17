# Claude × Codex Router

Claude × Codex Router is a local macOS utility for setting up Claude Code to delegate selected work to Codex through the official Codex Claude plugin.

Use it when you want to keep working in Claude, but have Codex available for implementation, plan review, and post-change checks without manually switching tools.

## What It Does

- Installs and checks the Claude → Codex bridge.
- Creates a local routing policy for Claude Code.
- Lets you choose Codex models and effort levels for different task types.
- Applies separate file thresholds for Codex implementation and plan audit.
- Adds optional plan review before coding.
- Tracks local routing decisions: `Claude-only`, `delegated`, and `audit`.
- Reads local Claude/Codex token counters from your machine.

Claude remains in control. The Claude model and effort selected in the Claude UI are not overridden by this tool.

## Requirements

- macOS.
- Node.js 18 or newer.
- Claude Code / Claude Desktop access.
- Codex CLI access through a ChatGPT/Codex subscription.
- Network access to Claude, GitHub, npm, and ChatGPT/Codex login during first setup.

The tool runs locally at `http://127.0.0.1:4177`.

## Install

Install the package globally:

```bash
npm i -g @alex_moroz/claude-codex-router
```

Start the local app:

```bash
claude-codex-router install
```

This starts the local UI and opens it in your browser. It does not install a background service and does not configure start-at-login.

You can also run it once without installing globally:

```bash
npx @alex_moroz/claude-codex-router open
```

## First Setup

After the UI opens, go to **Setup from zero** and complete the steps shown there.

The setup wizard will:

1. Check local runtime dependencies.
2. Verify Claude access.
3. Verify Codex CLI access.
4. Install or repair the Claude → Codex bridge plugin.
5. Apply the routing policy and local decision logger.
6. Run a token-free bridge self-check.

OAuth and SSO happen in the provider’s own browser or terminal flow. The router does not read or store credentials.

## Daily Use

After setup, keep using Claude as usual.

Claude will follow the generated routing policy:

- read-only and small single-layer tasks stay Claude-only;
- multi-file work is delegated to Codex automatically at the configured implementation threshold;
- work spanning two architectural layers, or a corrective pass after one unsuccessful attempt, is delegated regardless of file count;
- selected plans can be reviewed by Codex before implementation;
- routing decisions can be logged locally for later inspection.

The bundled hook repeats a short routing gate alongside every submitted prompt so the thresholds remain visible to Claude throughout a long session. If Claude reaches the implementation file threshold without involving Codex, the hook blocks that threshold-reaching Edit or Write once and asks Claude to delegate or state an allowed skip reason. Claude's built-in Explore and Plan agents may gather evidence, but they do not count as independent Codex involvement.

The presets currently use these implementation thresholds:

- Economy: 5 files;
- Balanced: 3 files;
- Strict: 2 files.

Plan-audit has its own separate threshold and token limits. Those token limits do not cap Codex implementation turns.

Open the UI at any time:

```bash
claude-codex-router open
```

`open` starts the local UI if it is not already running. It does not create a LaunchAgent.

Check local status:

```bash
claude-codex-router doctor
```

## Commands

```bash
claude-codex-router install                         # start the UI now; no login service
claude-codex-router open                            # start the UI if needed, then open it
claude-codex-router start                           # run the UI server in the foreground
claude-codex-router doctor                          # print local setup status
claude-codex-router service install                 # install a macOS service without start-at-login
claude-codex-router service install --start-at-login # opt in to RunAtLoad + KeepAlive
claude-codex-router service uninstall               # remove the background service only
claude-codex-router uninstall                       # alias for service uninstall
claude-codex-router build-portable                  # build a local ZIP installer
```

## Optional Start at Login

By default, this package does not install persistence.

If you explicitly want the router to start when you log in, run:

```bash
claude-codex-router service install --start-at-login
```

This creates a per-user macOS LaunchAgent with `RunAtLoad=true` and `KeepAlive=true`:

```text
~/Library/LaunchAgents/com.local.claude-codex-router-ui.plist
```

For corporate machines, use the default `install` or `open` command unless your security policy allows user LaunchAgents.

## What Gets Changed

The tool may create or update:

```text
~/.claude/rules/agent-routing.md
~/.claude/rules/.routing-ui-backups/
~/.claude/router-hooks/
~/.claude/router-history/
~/.claude-codex-router/
~/Library/LaunchAgents/com.local.claude-codex-router-ui.plist
```

The LaunchAgent is created only when you run a `service install` command.

Before overwriting routing policy or Claude settings, it creates backups.

It does not use API keys, does not require `sudo`, and does not send prompts or source code to a separate logging service.

## Uninstall

Remove the background service:

```bash
claude-codex-router service uninstall
```

This keeps routing files, backups, and local history.

To remove the npm package:

```bash
npm uninstall -g @alex_moroz/claude-codex-router
```

## Privacy Notes

The decision logger stores routing metadata only:

- route type;
- Codex model and effort;
- verdict or outcome;
- session id;
- timestamp;
- working directory.

It does not store prompts, responses, file contents, or code.

The `UserPromptSubmit` hook reads only the numeric thresholds from the generated routing policy and injects a fixed routing reminder. The submitted prompt is never copied into the router history.

Local token history is read from Claude and Codex client logs already present on your machine. These numbers are technical counters, not billing statements.
