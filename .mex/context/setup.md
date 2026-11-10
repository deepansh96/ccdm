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
last_updated: 2026-11-10
---

# Setup

## Prerequisites
- Node.js 22.5+ and npm.
- Claude Code CLI and/or Codex CLI, authenticated for the sessions being run.
- Python 3.
- macOS: `tmux`, `zsh`, and `jq`.
- Windows: Git for Windows (root's Bash tool is Git Bash), the native Claude Code install (`claude.exe`; an npm-only install is not found), and the optional npm packages `ccdm-host` needs, which `npm install` adds.
- The dashboard E2E tests require Pillow in the `python3` environment. CI provisions Python 3.11 and installs Pillow before `npm test`.
- A Discord server and one bot (root) with Message Content Intent; local `whisper` is optional for voice transcription.

## First-time Setup
1. Run `npm install`.
2. Create the registry and the root token file.
   - macOS: run `./setup.sh` and provide the Discord user ID, guild ID, and root bot token it requests. It writes `registry.json` (with empty `root_channels` and `root_allowed_user_ids`) and `~/.claude/channels/discord/.env`, the only token file.
   - Windows: pending (#252). There is no Windows setup command yet.
3. Add the root channel's ID to `root_channels` in `registry.json`.
4. Run `npm test`.
5. Install the Router as a service, then check it with `node scripts/router.js status`.
   - macOS: `scripts/install-router-service.sh`.
   - Windows: `scripts/ccdm install-service router`.
6. Windows: install the session host with `scripts/ccdm install-service host`. It refuses while any session is live. macOS uses tmux and has no host to install.
7. Start the root agent with `scripts/ccdm restart-root` for Claude, or `scripts/ccdm restart-root --provider codex <channel_id>` for Codex. Both are Router clients. An older install can move root channels from root's `access.json` with `node scripts/router.js migrate-root-config`.
   - macOS: `./restart-root-agent.sh` and `./restart-root-codex-agent.sh <channel_id>` run the same commands.
   - Windows: root Codex is not supported yet.

## Services
Each service is opt-in. Install one only when the operator asks.

- macOS: each installer is a script that loads a LaunchAgent: `scripts/install-router-service.sh` (Router), `scripts/install-usage-stats-poster.sh` (usage poster), `scripts/install-thread-supervisor.sh` (Thread Supervisor) and `scripts/install-conversation-reminder-service.sh` (Conversation Reminders). macOS has no session host service; it uses tmux.
- Windows: `scripts/ccdm install-service router` (Router), `scripts/ccdm install-service host` (session host), `scripts/ccdm install-service usage-poster` (usage poster), `scripts/ccdm install-service thread-supervisor` (Thread Supervisor) and `scripts/ccdm install-service reminders` (Conversation Reminders).
- Windows: the Thread Supervisor and Conversation Reminders installs run the worker's read-only `preflight` first and need the Router running. `disable` makes the worker exit and the task leaves it stopped; after `enable`, run the install again to start it.
- Windows: each service is a per-user scheduled task under `\CCDM\`. It runs only while the user is logged on. `scripts/ccdm service-status` shows every installed service, `scripts/ccdm service-status <name>` shows one, and `scripts/ccdm uninstall-service <name>` stops and removes one. Logs are `~/.local/state/ccdm/services/<name>.log` and `<name>.err`.
- Windows: the usage poster only collects history; it never posts to Discord. `scripts/ccdm install-service usage-poster --interval <seconds>` changes how often it runs (default 600). The first collection comes one interval after the install.
- Windows: `scripts/ccdm install-service host` refuses while any session is live, because every hosted session ends when the host stops. `scripts/ccdm install-service host --force` ends them. Neither `--force` nor `scripts/ccdm uninstall-service host` can run from inside a session, so root never runs them; the owner runs them from a terminal.

## Environment Variables
- `DISCORD_BOT_TOKEN` (required, root only) - stored in `ROOT_DISCORD_STATE_DIR/.env` (default `~/.claude/channels/discord/.env`), never in tracked files or the registry.
- `CCDM_STATE_ROOT` (optional) - CCDM's private state root on both OSes; defaults to `~/.local/state/ccdm`.
- `CCDM_ROUTER_STATE_DIR` (optional) - the Router's private state directory; defaults to `~/.local/state/ccdm/router`.
- `CCDM_ROOT_FALLBACK_AFTER_MS` (optional) - how long root waits without the Router before its emergency gateway; defaults to 120000.
- `CLAUDE_CONFIG_DIR` (optional) - selects a secondary Claude account home.
- Top-level registry `codex_home` (optional) - selects one shared CCDM Codex home for root and project bridges; defaults to `~/.codex` when absent.
- `ROOT_CODEX_HOME` (optional) - overrides the shared home for the root Codex bridge.
- `CODEX_BRIDGE_TRANSCRIBE_AUDIO=0` (optional) - disables bridge voice transcription.
- `CCDM_LIVE_E2E=1` (optional) - enables explicitly requested live smoke tests.

## Common Commands
- `npm test` - runs serialized local-fake E2E tests.
- `scripts/ccdm --help` - lists every `scripts/ccdm` command; the same commands run on macOS and Windows.
- `scripts/ccdm list` - lists the projects and whether each session is live.
- `scripts/ccdm start-session <project>` - starts a registered Claude project.
- `scripts/ccdm start-codex-session <project>` - starts a registered Codex project.
- `scripts/ccdm stop-session <project>` - stops either session type and clears runtime state.
- `scripts/ccdm restart-session <project>` - stops, then starts, either session type.
- `node scripts/guest-access.js list [project]` - inspects project guest access.
- `node scripts/router.js status` - reports Router health, sessions, scopes, webhooks, and scope violations.
- `npx mex-agent check` - checks memory scaffold drift.
- macOS: `python3 scripts/setup-codex-mimo.py --home ~/.codex-mimo --billing payg` - prepares an isolated MiMo Codex home (Python 3.10+, recent Codex supporting provider auth commands); use `--billing token-plan` for subscription keys or `--rotate-key` to replace an existing key.
- macOS: `python3 scripts/setup-codex-deepseek.py --home ~/.codex-deepseek` - prepares an isolated DeepSeek Flash home using the same private credential pattern; `--catalog-file` accepts catalog JSON or a vendor script parsed as data, and `--rotate-key` preserves other home state.
- Windows: `python scripts/setup-codex-mimo.py --home ~/.codex-mimo --billing payg` and `python scripts/setup-codex-deepseek.py --home ~/.codex-deepseek` - the same two helpers with the same options. Windows has no `/bin/cat`, so the home's auth command is `node`, which reads the private `api-key` file; Node must be on `PATH` for a session that uses the home. The helper protects the home's access list and stops if it cannot.
- `scripts/ccdm transcribe "<audio path>"` - prints the transcript of a voice message with local `whisper`, on macOS and Windows; exits 3 when `whisper` is not installed.

## Common Issues
**No reply, or 💤 on messages:** Run `node scripts/router.js status`; start the Router or the project's session.

- macOS: start the Router with `scripts/install-router-service.sh`.
- Windows: start the Router with `scripts/ccdm install-service router`.

**Duplicate listener refusal:** Run `scripts/ccdm stop-session <project>` before retrying start; do not bypass the listener scan.

**Claude account expired:** Start or log into Claude using the same `CLAUDE_CONFIG_DIR` to refresh OAuth.

**Voice messages are not transcribed:** Install `openai-whisper` or ask the user to type the message. On Windows `whisper.exe` must be on `PATH`, or `CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND` must name it.

**Tools missing inside a session:** Launch only through `scripts/ccdm`.

- macOS: it starts each tmux session through `zsh -ic`, so tools set up in `~/.zshrc` resolve.
- Windows: `ccdm-host` gives each session the user's profile environment.
