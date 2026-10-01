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
    condition: when configuring the root token, Session Scope, guest roles, or root channel permissions
last_updated: 2026-09-29
---

# Setup

## Prerequisites
- Node.js 22.5+ and npm.
- Claude Code CLI and/or Codex CLI, authenticated for the sessions being run.
- `tmux`, `zsh`, Python 3, and `jq`.
- The dashboard E2E tests require Pillow in the `python3` environment. CI provisions Python 3.11 and installs Pillow before `npm test`.
- A Discord server and one bot (root) with Message Content Intent; local `whisper` is optional for voice transcription.

## First-time Setup
1. Run `npm install`.
2. Run `./setup.sh` and provide the Discord user ID, guild ID, and root bot token it requests. It writes `registry.json` (with empty `root_channels` and `root_allowed_user_ids`) and `~/.claude/channels/discord/.env`, the only token file.
3. Add the root channel's ID to `root_channels` in `registry.json`.
4. Run `npm test`.
5. Install the Router with `scripts/install-router-service.sh` and check it with `node scripts/router.js status`.
6. Start the root agent with `./restart-root-agent.sh` or `./restart-root-codex-agent.sh <channel_id>`. Both are Router clients. An older install can move root channels from root's `access.json` with `node scripts/router.js migrate-root-config`.

## Environment Variables
- `DISCORD_BOT_TOKEN` (required, root only) - stored in `ROOT_DISCORD_STATE_DIR/.env` (default `~/.claude/channels/discord/.env`), never in tracked files or the registry.
- `CCDM_ROUTER_STATE_DIR` (optional) - the Router's private state directory; defaults to `~/.local/state/ccdm/router`.
- `CCDM_ROOT_FALLBACK_AFTER_MS` (optional) - how long root waits without the Router before its emergency gateway; defaults to 120000.
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
- `node scripts/router.js status` - reports Router health, sessions, scopes, webhooks, and scope violations.
- `npx mex-agent check` - checks memory scaffold drift.
- `python3 scripts/setup-codex-mimo.py --home ~/.codex-mimo --billing payg` - prepares an isolated MiMo Codex home (Python 3.10+, recent Codex supporting provider auth commands); use `--billing token-plan` for subscription keys or `--rotate-key` to replace an existing key.
- `python3 scripts/setup-codex-deepseek.py --home ~/.codex-deepseek` - prepares an isolated DeepSeek Flash home using the same private credential pattern; `--catalog-file` accepts catalog JSON or a vendor script parsed as data, and `--rotate-key` preserves other home state.

## Common Issues
**No reply, or 💤 on messages:** Run `node scripts/router.js status`; start the Router (`scripts/install-router-service.sh`) or the project's session.

**Duplicate listener refusal:** Run `scripts/stop-session.sh <project>` before retrying start; do not bypass the listener scan.

**Claude account expired:** Start or log into Claude using the same `CLAUDE_CONFIG_DIR` to refresh OAuth.

**Voice messages are not transcribed:** Install `openai-whisper` or ask the user to type the message.

**Tools missing inside tmux:** Launch through the provided scripts, which use `zsh -ic`.
