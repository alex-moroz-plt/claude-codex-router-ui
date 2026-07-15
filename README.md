# Claude × Codex Router

Claude × Codex Router is a local macOS utility for setting up Claude Code to delegate selected work to Codex through the official Codex Claude plugin.

Use it when you want to keep working in Claude, but have Codex available for implementation, plan review, and post-change checks without manually switching tools.

## What It Does

- Installs and checks the Claude → Codex bridge.
- Creates a local routing policy for Claude Code.
- Lets you choose Codex models and effort levels for different task types.
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

This installs a small macOS background service and opens the setup UI in your browser.

You can also run it once without installing globally:

```bash
npx @alex_moroz/claude-codex-router start
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

- simple tasks stay Claude-only;
- multi-file or risky work can be delegated to Codex;
- selected plans can be reviewed by Codex before implementation;
- routing decisions can be logged locally for later inspection.

Open the UI at any time:

```bash
claude-codex-router open
```

Check local status:

```bash
claude-codex-router doctor
```

## Commands

```bash
claude-codex-router install        # install/repair the local background service and open the UI
claude-codex-router start          # run the UI server in the foreground
claude-codex-router open           # open the UI in your browser
claude-codex-router doctor         # print local setup status
claude-codex-router uninstall      # remove the background service only
claude-codex-router build-portable # build a local ZIP installer
```

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

Before overwriting routing policy or Claude settings, it creates backups.

It does not use API keys, does not require `sudo`, and does not send prompts or source code to a separate logging service.

## Uninstall

Remove the background service:

```bash
claude-codex-router uninstall
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

Local token history is read from Claude and Codex client logs already present on your machine. These numbers are technical counters, not billing statements.
