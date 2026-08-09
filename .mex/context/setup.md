---
name: setup
description: Dev environment setup and commands. Load when setting up the project for the first time or when environment issues arise.
triggers:
  - "setup"
  - "install"
  - "environment"
  - "getting started"
  - "how do I run"
  - "local development"
edges:
  - target: context/stack.md
    condition: when specific technology versions or library details are needed
  - target: context/architecture.md
    condition: when understanding how components connect during setup
  - target: context/discord-security.md
    condition: when configuring bot tokens, allowlists, roles, or channel permissions
last_updated: 2026-08-09
---

# Setup

## Prerequisites
- Node.js 22+ and npm.
- Claude Code CLI and/or Codex CLI, authenticated for the sessions being run.
- `tmux`, `zsh`, Python 3, and `jq`.
- A Discord server and bot credentials; local `whisper` is optional for voice transcription.

## First-time Setup
1. Run `npm install`.
2. Run `./setup.sh` and provide the Discord user, guild, root channel, and bot token values it requests.
3. Verify the generated local `registry.json` and `~/.claude/channels/discord/access.json`.
4. Run `npm test`.
5. Start the root agent with `./restart-root-agent.sh` or `./restart-root-codex-agent.sh <channel_id>`.

## Environment Variables
- `DISCORD_BOT_TOKEN` (required per bot) - stored in each local Discord state directory, never in tracked files.
- `DISCORD_STATE_DIR` (required for Claude sessions) - selects the assigned bot's plugin state.
- `CLAUDE_CONFIG_DIR` (optional) - selects a secondary Claude account home.
- Top-level registry `codex_home` (optional) - selects one shared CCDM Codex home for root and project bridges; defaults to `~/.codex` when absent.
- `ROOT_CODEX_HOME` (optional) - overrides the shared home for the root Codex bridge.
- `CODEX_BRIDGE_TRANSCRIBE_AUDIO=0` (optional) - disables bridge voice transcription.
- `CCDM_LIVE_E2E=1` (optional) - enables explicitly requested live smoke tests.

## Common Commands
- `npm test` - runs serialized local-fake E2E tests.
- `scripts/start-session.sh <project>` - starts a registered Claude project.
- `scripts/start-codex-session.sh <project>` - starts a registered Codex project.
- `scripts/stop-session.sh <project>` - stops either session type and clears runtime state.
- `scripts/guest-access.js list [project]` - inspects project guest access.
- `npx mex-agent check` - checks memory scaffold drift.

## Common Issues
**Duplicate listener refusal:** Run `scripts/stop-session.sh <project>` before retrying start; do not bypass the listener scan.

**Claude account expired:** Start or log into Claude using the same `CLAUDE_CONFIG_DIR` to refresh OAuth.

**Voice messages are not transcribed:** Install `openai-whisper` or ask the user to type the message.

**Tools missing inside tmux:** Launch through the provided scripts, which use `zsh -ic`.
