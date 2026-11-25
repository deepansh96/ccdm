# CCDM — Claude Code Discord Manager

CCDM runs isolated [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Codex and Gemini (Google Antigravity CLI, `agy`) sessions for many local projects, and lets you talk to each one from its own Discord channel. It uses **one Discord bot**. A local **Router** daemon holds that bot's token and connects each project channel to the one session serving it.

```
Discord Server (one bot: root)
  │
  ├── #root              ← root agent listens here (no @mention needed)
  │
  ├── #my-app            ← posts as "my-app-claude · 42%" (webhook ccdm-my-app)
  │     Claude Code running in ~/my-app/
  │
  └── #website           ← posts as "website-codex · 17%" (webhook ccdm-website)
        Codex running in ~/website/

Router (local daemon, holds the root token)
  ├── root session       ← root channels + @mentions in project channels
  ├── my-app session     ← Session Scope: #my-app only
  └── website session    ← Session Scope: #website only
```

## Contents

- **Setup:** [Prerequisites](#prerequisites) · [Creating the root bot](#creating-the-root-bot) · [Quick Start](#quick-start) · [Manual Setup](#manual-setup) · [Registering a New Project](#registering-a-new-project)
- **Concepts:** [How It Works](#how-it-works) · [The Router](#the-router) · [Session Scope](#session-scope) · [Project sessions](#project-sessions) · [Thread Conversations](#thread-conversations) · [Agent Messages](#agent-messages) · [Accounts and homes](#accounts-and-homes) · [Project Guests](#project-guests) · [Project Conversation state](#project-conversation-state) · [Usage Report](#usage-report)
- **Operations:** [Commands](#commands) · [Resuming a conversation](#resuming-a-conversation) · [Router operations](#router-operations) · [Cutover and retirement](#cutover-and-retirement) · [Scheduled Usage Stats Poster](#scheduled-usage-stats-poster) · [Auto-Start on Reboot](#auto-start-on-reboot-macos) · [Preventing Sleep](#preventing-sleep) · [Running on Windows](#running-on-windows)
- **Reference:** [Configuration reference](#configuration-reference) · [Security Note](#security-note) · [Troubleshooting](#troubleshooting) · [Limitations](#limitations) · [File Structure](#file-structure) · [Global Skills](#global-skills)

## How It Works

- **One bot, one Router.** The Router (`scripts/router.js`) is the only component that holds a Discord bot credential. It receives every Discord event and delivers each message to the one session serving that channel. Sessions talk to it over a private Unix socket with a per-launch key and never see a Discord token. See [The Router](#the-router).
- **Root agent.** A Claude Code or Codex session that is itself a Router client. It listens in your root channel without an `@mention` and manages everything else: it registers and deregisters projects, starts, stops and restarts sessions, reports context usage and rate limits, restarts itself, and transcribes voice messages with Whisper. See [Commands](#commands).
- **Project sessions.** Each registered project has its own channel and its own Claude Code, Codex or Gemini session running in the project directory inside tmux. You chat with a project in its channel, with no `@mention`.
- **Project Identity.** Each project posts through its own webhook, `ccdm-<project>`, as `<project>-<claude|codex|gemini> · N%`, where `N` is the session's context usage. See [Context Usage in the Project Identity](#context-usage-in-the-project-identity).
- **Session Scope.** Each session may read and act in one channel only. The Router rejects anything else. See [Session Scope](#session-scope).
- **Thread Conversations.** A public thread under a project channel is its own separate conversation, started and stopped by the Thread Supervisor. See [Thread Conversations](#thread-conversations).
- **Agent Messages.** One project's agent can send a bounded request to another project's live session through the Router once you allow that direction, with linked visible records in both Discord conversations and an append-only ledger. See [Agent Messages](#agent-messages).

An `@mention` of the bot in a project channel reaches root only, never the project.

> **Windows:** the sections below describe macOS and Linux. To set up CCDM on a Windows PC, follow [Running on Windows](#running-on-windows).

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Yes | See docs |
| `tmux` | Yes | `brew install tmux` / `apt install tmux` |
| `zsh` | Yes | Default on macOS / `apt install zsh` on Linux |
| `python3` | Yes | `brew install python3` / `apt install python3`. Codex sessions (the Codex Home resolver) and the provider setup helpers need Python 3.10+ |
| Node.js 22.5+ | Yes | `brew install node`, then `npm install` in this repo (the Router, channel server and bridges) |
| `jq` | Yes | `brew install jq` / `apt install jq` |
| Codex CLI | Optional | For Codex sessions, root Codex, and the Usage Stats Poster installer |
| Google Antigravity CLI (`agy`) | Optional | For Gemini sessions; install it and sign in once by running `agy` |
| `whisper` | Optional | `pip install openai-whisper` (voice messages) |

You also need:

- A Discord account
- A Discord server where you can add bots
- One Discord bot for root, see [Creating the root bot](#creating-the-root-bot)

The LaunchAgent installers (Router, Thread Supervisor, reminders, usage poster) are macOS-only.

## Creating the root bot

CCDM needs exactly one Discord bot application, used by root and the Router.

1. **Create an application**: go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. **Set up the bot**: in the sidebar, go to **Bot**. Under **Privileged Gateway Intents**, enable **Message Content Intent**. Without it the bot receives messages with empty content.
3. **Copy the token**: on the **Bot** page, click **Reset Token** and copy it at once; it is shown only once. `setup.sh` stores it in root's state directory. Never put it in `registry.json`.
4. **Generate an invite link**: go to **OAuth2** > **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:
   - View Channels, Send Messages, Send Messages in Threads, Read Message History
   - Attach Files, Add Reactions, Manage Messages
   - Manage Webhooks (Project Identity webhooks)
   - Manage Channels, Manage Roles, Create Instant Invite (registration and guest access)
   - Create Public Threads, Manage Threads (Thread Conversations), and optionally View Audit Log

   Set Integration type to **Guild Install**. Copy the generated URL.
5. **Invite the bot**: open the URL in a browser and add the bot to your server.

In every project channel, root needs Send Messages, Read Message History, Add Reactions, Manage Messages and Manage Webhooks. `router status` names any that are missing.

## Quick Start

```bash
# 1. Clone the repo and install Node dependencies
git clone https://github.com/<owner>/ccdm.git
cd ccdm
npm install

# 2. Run the setup script (asks for your user ID, server ID, and the root bot token)
./setup.sh

# 3. Put your root channel's ID in registry.json "root_channels"

# 4. Install and check the Router
scripts/install-router-service.sh
node scripts/router.js status

# 5. Start the root agent
./restart-root-agent.sh
```

`setup.sh`:

1. Checks for `claude`, `tmux`, `zsh`, `python3` and `jq` (it does not check Node; run `npm install` yourself), and notes a missing `whisper`.
2. Asks for your Discord user ID and server ID.
3. Writes `registry.json` with `discord_user_id`, `guild_id`, empty `root_channels`, `root_allowed_user_ids`, `codex_accounts`, `category_ids` and `projects`, and `default_codex_account: null`. It asks before overwriting an existing file.
4. Asks for the root bot's token and writes it to `~/.claude/channels/discord/.env`. If that file already exists and you decline to overwrite it, the token goes to the next free `~/.claude/channels/discord<N>/` directory instead; then set `ROOT_DISCORD_STATE_DIR` to that directory for the Router and the other tools.
5. Prints the remaining steps: add your root channel, install the Router, start root.

Then message root in your root channel to [register a project](#registering-a-new-project).

## Manual Setup

1. **Copy the registry template:**
   ```bash
   cp registry.example.json registry.json
   ```

2. **Edit `registry.json`.** Fill in your Discord user ID, server ID and root channel, and replace the example project with `"projects": {}`:
   ```json
   {
     "discord_user_id": "123456789012345678",
     "guild_id": "YOUR_DISCORD_SERVER_ID",
     "root_channels": ["YOUR_ROOT_CHANNEL_ID"],
     "root_allowed_user_ids": [],
     "codex_accounts": {},
     "default_codex_account": null,
     "category_ids": [],
     "projects": {}
   }
   ```
   To find your Discord user ID: Settings > Advanced > enable Developer Mode, then right-click your name > Copy User ID. For the server ID, right-click the server name > Copy Server ID. For a channel ID, right-click the channel > Copy Channel ID. Every key is described in the [Configuration reference](#configuration-reference).

3. **Store the root bot token** (the only token CCDM uses):
   ```bash
   mkdir -p ~/.claude/channels/discord
   (umask 077; echo "DISCORD_BOT_TOKEN=your_token_here" > ~/.claude/channels/discord/.env)
   ```
   `ROOT_DISCORD_STATE_DIR` selects a different directory. The Router, guest management, message exports and the usage poster all read the token from here.

4. **Install the Router** (see [The Router](#the-router)):
   ```bash
   scripts/install-router-service.sh
   node scripts/router.js status
   ```

5. **Start the root agent:**
   ```bash
   ./restart-root-agent.sh
   ```
   This launches root Claude in the `root_agent` tmux session as a Router client: the CCDM channel server (`scripts/ccdm-channel-server.js`) in the root role, with root's own Router key and no Discord token. It accepts the per-launch development-channel confirmation and succeeds only once root has connected to the Router.

   To run root through Codex instead:
   ```bash
   ./restart-root-codex-agent.sh [channel_id]
   ```
   Root Codex runs `scripts/codex-bridge.js` in root mode as a Router client. The channel must be in `root_channels`; omit it when there is only one, or set `ROOT_CODEX_CHANNEL_ID`. Allowed users are the owner and `root_allowed_user_ids`. The script checks this before it stops the current root agent. `restart-root-agent.sh` switches back to Claude.

   An older install that kept root's channels in root's `access.json` can move them into the registry once with `node scripts/router.js migrate-root-config`.

## Registering a New Project

Once the Router and root are running, message root in your root channel:

```
register
```

Root asks:

1. **Which channel?** A channel name or ID; root can also create one.
2. **Project path?** The local directory for the project.
3. **Claude, Codex or Gemini?**

Then it:

1. Creates or resolves the channel with the root bot's credentials.
2. Writes the project entry (`path`, `screen_name`, `channel_id`, `type`, plus an unused `ws_port` for Codex).
3. Runs `node scripts/router.js ensure-webhook <project>`, which finds or creates the `ccdm-<project>` webhook, records `webhook_id` in the registry, and keeps the webhook token only in private Router state.
4. Issues a fresh Conversation Reminder assignment.
5. Starts the session.

There is no bot to make, assign or rename per project. The Router reloads `registry.json` on change, so the new channel is routed without restarting anything.

**Deregistering** stops the session, runs `node scripts/router.js delete-webhook <project>` (deleting the webhook and its token and clearing `webhook_id`; a rerun is a no-op), removes the registry entry, and retires the project's reminders. Its Thread Conversations are closed. The Discord channel is not deleted.

If a project's webhook is deleted in Discord, the Router recreates it once on the next reply and updates `webhook_id`. A second deletion in a row fails replies with `webhook_deleted` until `ensure-webhook` runs again.

## The Router

The Router is a Node daemon (`scripts/router.js serve`, modules in `scripts/router/`) with one discord.js gateway connection. It delivers messages to sessions and performs Discord actions on their behalf: replies, edits, reactions, typing, reads, exports and attachment downloads.

Its private state lives in `~/.local/state/ccdm/router/` (0700; `CCDM_ROUTER_STATE_DIR` overrides it): the socket `router.sock` (0600), per-session keys, webhook tokens, launch files, attachment inboxes, logs, and `agent-messages.jsonl`, the Router's one durable append-only ledger for [Agent Messages](#agent-messages).

**Install it** as the `com.ccdm.router` LaunchAgent:

```bash
scripts/install-router-service.sh
```

The installer first runs the read-only `node scripts/router.js preflight` and touches nothing if a blocker remains. Preflight checks Node 22 or newer, a readable registry with `discord_user_id`, the root token, and that the state directory (if present) is yours with mode 0700. The installer then renders a secret-free plist with private logs (`router.log` and `router.err` in the state directory), relaunches the Router only after a crash, and restores the prior plist and loaded service if the new load fails. Foreground and supervised Routers share one lock, so a second `router.js serve` exits non-zero without disturbing the running one.

**Check it** with `router status`:

```bash
node scripts/router.js status         # human-readable
node scripts/router.js status --json  # for scripts
```

It reports the gateway state, the registry's last good load time and any load error, connected sessions with role, project, scope and connect time, thread sessions and the Thread Supervisor, each project's webhook and root's missing channel permissions, registered channels Discord no longer has (`channel_missing`), recent scope violations, and Agent Messages health (`agent messages: ledger ok|unavailable`, `open agent requests`, and `recent agent refusals`). It exits non-zero when the Router is unreachable.

**Behaviour to know:**

- **One listener per channel.** A new launch writes a new key, which disconnects the previous listener, so two sessions never answer the same channel.
- **Offline channels.** A message to a channel with no live session gets 💤 and is not replayed later. A project with no `webhook_id` (not yet migrated) gets no 💤.
- **Registry reloads.** The Router watches `registry.json` and applies guest, channel and project changes to the next message, with no restart. An invalid registry keeps the last good routing table without disconnecting any session, and `router status` shows the error. Invalid means malformed JSON, a missing owner, a non-object `projects`, a project without `channel_id`, a channel claimed twice or also listed as a root channel, or wrongly typed guest or root lists.
- **Channel moves.** When a project's `channel_id` changes, the Router moves its webhook to the new channel before the next reply and pushes the new scope to the session. No session restart is needed.
- **Rate limits** stop at the Router. It queues REST calls per route bucket, honors `Retry-After`, and coalesces repeated edits to one message. A session sees eventual success, or a typed `rate_limited` failure once the wait bound passes (`CCDM_ROUTER_RATE_LIMIT_MAX_WAIT_MS`, default 30 s).
- **Router down.** launchd restarts a crashed Router, and every session reconnects on its own with capped backoff. While disconnected, Discord operations fail with `router_unavailable` instead of queueing.
- **Emergency fallback.** If the Router stays unreachable for about 2 minutes (`CCDM_ROOT_FALLBACK_AFTER_MS`, default 120000), root opens an emergency direct gateway connection with the root token, for root channels only (owner and `root_allowed_user_ids`). It posts a one-line notice in the primary root channel, so you can diagnose and restart the Router from Discord. While engaged, root replies, reacts, types and edits its own messages in root channels directly as the bot; reads and attachments wait for the Router. When the Router returns, root closes the emergency connection before it reconnects, so the two paths never deliver at once. `restart-root-agent.sh` and `restart-root-codex-agent.sh` refuse to run while the Router is not answering, so a restart never takes down the emergency root.

The admin commands are under [Router operations](#router-operations).

## Session Scope

The Router enforces each session's scope on every operation:

- A project session may read, post, edit, react and type only in its registered channel, and `message_id` targets must belong to that channel. Anything else is rejected with `scope_violation` and logged; `router status` lists recent violations.
- A thread session's scope is its thread alone, not the parent channel or a sibling thread.
- A project's replies post through its own webhook, and it may edit only its own webhook messages. Reactions and typing show as the root bot.
- The root session may act in root channels and every registered project channel.
- Only messages and reactions from the owner (`discord_user_id`) and that channel's guests are forwarded. Bot and webhook messages are never forwarded to sessions.
- An `@mention` of the bot in a project channel, or a native reply to a root message, reaches root only. A reply to a project's webhook message goes to the project. Guests' mentions reach no one.

Discord permissions are not the isolation boundary. The old `project-bot` role and per-channel override model is obsolete.

## Project sessions

Every project session runs in a tmux session named by the project's `screen_name`, launched through `zsh -ic` so tools installed through your shell profile resolve. Each launcher refuses a duplicate session and a project without `webhook_id`, writes a fresh launch key, and records the PID only after the session has connected to the Router.

| Provider | `type` | Launcher | What runs |
|----------|--------|----------|-----------|
| Claude Code | `claude` (default when unset) | `scripts/start-session.sh <project>` | `claude` with the CCDM channel server (`scripts/ccdm-channel-server.js`) |
| Codex | `codex` | `scripts/start-codex-session.sh <project>` | `scripts/codex-bridge.js`, which owns `codex app-server` |
| Gemini | `gemini` | `scripts/start-gemini-session.sh <project>` | `scripts/gemini-bridge.js`, which drives `agy acp` |

`scripts/stop-session.sh <project>` stops any of them. Always use it instead of a bare `tmux kill-session`: it also sweeps leftover listener processes, which otherwise answer messages twice.

### Claude sessions

`start-session.sh` launches `claude --dangerously-load-development-channels server:ccdm --dangerously-skip-permissions` and accepts the per-launch development-channel confirmation for you. A launch that does not connect within 60 s (`CCDM_CLAUDE_LAUNCH_TIMEOUT_S`) is cleaned up and exits non-zero.

Pin the account, model and effort per project:

```json
{
  "claude_home": "~/.claude-work",
  "model": "claude-fable-5",
  "claude_effort": "high"
}
```

These become `CLAUDE_CONFIG_DIR`, `--model` and `--effort`. Effort is `low`, `medium`, `high`, `xhigh` or `max`; any other value is rejected before launch.

### Codex sessions

`start-codex-session.sh` resolves the project's [Codex Home](#codex-accounts) first, then starts the bridge with the app-server on the project's `ws_port` (default 18300; give each Codex project its own). Sessions run with approvals off and full disk access. A launch that does not connect within 120 s (`CCDM_CODEX_LAUNCH_TIMEOUT_S`) is cleaned up and exits non-zero.

Pin runtime settings per project:

```json
{
  "codex_model": "gpt-5.6-sol",
  "codex_reasoning_effort": "high"
}
```

These are passed to `codex app-server` as config overrides. `codex_model` falls back to the project's `model`. Fast mode is off unless `codex_service_tier` is set to a tier such as `"priority"`; Sol/Terra/Luna are model slugs. A ChatGPT-account home can run only the models in its own catalog, so confirm a slug there before you set it.

The Codex bridge also:

- **Steers.** A message sent during a turn steers the running turn.
- **Transcribes voice messages.** `audio/*` attachments are transcribed with local `whisper`, and Codex gets the transcript instead of the audio file. This is on by default; set `CODEX_BRIDGE_TRANSCRIBE_AUDIO=0` to turn it off for a bridge process. The Gemini bridge honors the same setting.
- **Forwards feedback.** 👍 and 👎 from allowed users on the project's own messages become short feedback turns with the reacted message ID and an excerpt when available.

After upgrading the Codex CLI, stop all long-lived CCDM Codex sessions before starting any of them again, then restart the root Codex bridge. Updating the binary does not replace running app-server processes, so a partial restart can mix runtime versions inside a shared home.

### Gemini sessions (Antigravity CLI)

A project with `"type": "gemini"` runs Gemini through the Google Antigravity CLI, `agy`. Install it (`~/.local/bin/agy` on macOS, `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows), run `agy` once to sign in with Google, then register the project with that type and start it:

```bash
scripts/ccdm start-gemini-session my-project
```

`scripts/gemini-bridge.js` runs `agy acp`, agy's Agent Client Protocol server, in the project directory and talks to it over stdio. Like Codex, the bridge is a Router client with a launch key and no Discord token. The scoped Discord tools reach Gemini as an MCP server attached to that one agy session, so no agy config file is written.

- **Model and thinking level:** `gemini_model` (or `model`) and `gemini_effort` (`low`, `medium`, `high`, `xhigh`) in the project entry. Unset, the bridge uses `gemini-4-neon` at `high`. Any model `agy models` lists works, including a level suffix such as `gemini-4-neon-xhigh`. An unknown model fails the launch with the list agy offers.
- **Messages during a turn:** ACP cannot steer a running turn. A message sent while Gemini works gets ⏳, and every waiting message goes into the next turn together.
- **Tools:** agy's tool permission requests are approved automatically (`agy acp --dangerously-skip-permissions`), the way Codex sessions run with approvals off.
- **Text replies:** a turn that ends with text but no successful `reply` call posts that text, so an answer is never lost. Set `"text_reply_fallback": false` in the project entry to turn this off, for the project and its Gemini threads.
- **`/clear` and `/restart`:** `/clear` cancels any turn and opens a fresh agy session. A turn that ignores the cancel for 15 s stops the session (restart it) rather than leaving it stuck. `/restart` waits for agy itself to exit before relaunching.
- **Other binary:** `CCDM_AGY_BIN` names another agy binary. Under an account home it must be agy itself, not a bash or zsh wrapper script; the launch refuses one.

For a second Google account see [Gemini accounts](#gemini-accounts); for resume see [Resuming a conversation](#resuming-a-conversation).

### Context Usage in the Project Identity

Each reply posts as `<project>-<claude|codex|gemini> · N%`, where `N` is the session's context window usage at send time. No bot nickname is changed.

- **Codex** reports `N` from the bridge's tracked token usage.
- **Gemini** reports it from agy's usage updates.
- **Claude** reports it through Claude Code's `statusLine` setting: the status script writes the latest percentage to a private file in the project's Router launch directory, and the channel server sends it with each reply.

For Claude, add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "/path/to/ccdm/scripts/cc-discord-nicknames.sh",
  "padding": 0
}
```

| Script | What it does |
|--------|-------------|
| `scripts/cc-discord-nicknames.sh` | Records the context percentage only, with no terminal UI dependency |
| `scripts/cc-statusline-wrapper.sh` | Records the percentage and pipes through [ccstatusline](https://github.com/sirmalloc/ccstatusline) for a terminal status bar |

`scripts/statusline-context.js` does the same recording in Node, with no bash or `jq`, so use it on Windows. It prints nothing by itself. To keep a status bar, pass that bar's existing command with `--chain`: it gets the same input, and its output is shown. Write Windows paths with forward slashes:

```json
"statusLine": {
  "type": "command",
  "command": "node 'C:/path/to/ccdm/scripts/statusline-context.js' --chain 'npx -y ccstatusline@latest'",
  "padding": 0
}
```

The chained command runs in `/bin/sh` on macOS and Linux. On Windows it runs in Git Bash when installed, otherwise in PowerShell.

All of these scripts use the `CCDM_ROUTER_KEY_FILE` that CCDM sets for its Claude sessions, and do nothing in other Claude sessions. When no percentage is available, replies post as `<project>-claude` with no suffix.

Discord rejects webhook names containing `discord` or `clyde`, so the Router shortens those words in a project name to `dc` and `cl`. It truncates the project name first, so the ` · N%` suffix survives the 80-character limit.

## Thread Conversations

Open a public thread under a registered project channel and type a task. It becomes a **Thread Conversation**: a fresh Claude Code, Codex or Gemini conversation for that project, running in the project checkout. The Router scopes it to that thread alone, so the Channel Conversation and sibling threads never see its traffic. Replies post into the thread through the project's webhook as `<project>-<provider> · N%`. The owner and the channel's guests drive threads without an @mention.

This section is the summary. Full details are in [docs/thread-supervisor.md](docs/thread-supervisor.md).

- **Create** a thread in any of four ways:
  - by hand in Discord;
  - `/thread <name> [--provider claude|codex|gemini] [--account <alias>] [--model <model>] [--effort <effort>] [first message…]` in the project channel;
  - the channel agent's `create_thread` tool;
  - `scripts/threads.sh create <project> <name> [flags] [message]`.

  A thread can use any provider, whatever the project's own `type`. Created threads use Discord's one-week archive duration. A bad flag creates nothing.
- **Settings:** `--effort` is `low|medium|high|xhigh|max` for Claude, `none|minimal|low|medium|high|xhigh` for Codex, and `low|medium|high|xhigh` for Gemini. `--account` is an alias from `claude_accounts`, `codex_accounts` or `gemini_accounts`, never a path (see [Accounts and homes](#accounts-and-homes)). Without flags a thread inherits the project's settings. A project's plain `model` goes only to threads of the project's own provider, so a Claude or Codex thread of a Gemini project never inherits a Gemini model.
- **In a thread:**
  - `/config` (owner) shows or changes the thread's provider, account, model and effort. A model or effort change restarts into the same conversation. A provider or account change starts a fresh conversation and applies only after your ✅. Switching provider also drops the thread's account, model and effort for the old provider, unless the same `/config` sets them.
  - `/model` shows the model, thinking level and account/home the thread runs with.
  - `/restart` resumes the conversation, and `/clear` starts a fresh one.
  - `/compact`, `/pause` and `/unpause` work as in a channel.
  - `/close` (owner) archives the thread, stops its session and closes its reminders.
- **Lifecycle:** a thread stays open until `/close` or `scripts/threads.sh close`. Any other archive, Discord's one-week inactivity auto-archive or one by hand, is reverted at once, and an idle session is stopped. Your next message resumes the same conversation. Only the owner's message reopens a closed one.
- **Status:** root reacts on your message instead of posting. ⏳ means the agent is working on it (only your latest message carries it), ✅ that the turn ended and it is your turn, and ⚠️ that the turn failed or the session crashed. A stop or `/close` takes the ⏳ off; ✅ and ⚠️ stay. 👀 shows while a session boots.
- **Capacity:** live thread sessions are capped per provider by the registry's `thread_session_caps` (default `{"claude": 6, "codex": 8, "gemini": 4}`). Channel sessions never count. At the cap the longest-idle session (30 minutes without an owner message, no turn running) is paused, or the new thread is queued.
- **Operate:**
  - `scripts/threads.sh list [<project>]` lists bound threads with their state.
  - `scripts/threads.sh stop|restart|close [<project>] <name|link|id>` acts on one thread. `restart` also takes `--provider`, `--account`, `--model` and `--effort`: a provider or account change starts fresh, while model and effort alone keep the current conversation.
  - `scripts/stop-session.sh <project> --threads` stops only the thread sessions, and `--all` stops the channel too. A plain `stop-session.sh <project>`, or a channel restart, leaves threads alone.
  - `node scripts/router.js status` lists thread sessions and the supervisor.
- **Project changes:** deregistering a project, moving its channel, or setting its path to `remote:` closes its threads.

**Install the Thread Supervisor**, the separate service that starts, stops and resumes thread sessions. It holds no Discord credential; every Discord action it takes goes through the Router:

```bash
scripts/install-thread-supervisor.sh      # read-only preflight, then the com.ccdm.thread-supervisor LaunchAgent
scripts/thread-supervisor.py status        # worker, Router connection, caps and bound threads
```

`scripts/thread-supervisor.py disable` stops the supervised worker and keeps launchd from relaunching it; `run` starts a foreground worker for debugging. `enable` only clears the disabled marker, so rerun the installer afterwards. State is private under `~/.local/state/ccdm/thread-supervisor/`. Threads are on for every project once the supervisor is installed; there is no per-project flag. While the supervisor is down, a thread message with no live session gets 💤.

Root needs three extra permissions, granted once by hand: Create Public Threads, Send Messages in Threads and Manage Threads in the project channels. No script changes permissions. View Audit Log on the guild is useful but optional: with it the supervisor logs who archived a thread it reopened. `router status` reports any that are missing while threads are enabled. The post-merge live smoke steps are in the [operator checklist](docs/thread-supervisor.md#operator-checklist).

## Agent Messages

**Agent Messages** let one project's Claude, Codex or Gemini agent ask another project's live agent a question through the Router and receive one answer back, without you copying messages between channels. Both Channel Conversations and Thread Conversations can send and receive. Root and `remote:` projects take no part.

- **Exchange shape:** one **Agent Request** (`req-…`) and at most one **Agent Reply** under that request ID, then the exchange closes. A follow-up is a new request. Content is text only (no attachments).
- **Session Scope is unchanged:** neither session gains read, react, edit or history access in the other conversation.
- **Restart sessions after upgrading:** existing project and thread sessions must be restarted after upgrading to announce `agent_messages` in their Router hello. A session started before the upgrade counts as offline (`target_offline`) for Agent Messages.

### Granting, listing and revoking

An **Agent Message Grant** is your one-way permission (`projects.<from>.agent_message_targets` in `registry.json`) for every conversation of `<from>` (its channel and all its threads) to send Agent Requests to every conversation of `<to>`. Manage grants through root or directly with `scripts/ccdm agent-messages` (the same command on macOS and Windows; never hand-edit `registry.json`, and project sessions never edit grants):

```bash
scripts/ccdm agent-messages allow <from> <to>
scripts/ccdm agent-messages revoke <from> <to>
scripts/ccdm agent-messages list [<project>] [--json]
```

- **One-way and self-grants:** `allow alpha beta` lets `alpha` send requests to `beta`, not `beta` to `alpha`. Replies need no grant because the open request is their permission. Messaging inside one project (channel ↔ thread or thread ↔ thread) needs a self-grant (`allow alpha alpha`).
- **No per-request prompt:** once a direction is allowed, granted agents exchange requests without asking you each time.
- **Guest warning:** when `<from>` has guests (`guest_user_ids`), `allow` prints a warning naming the guest count and still records the grant, so you know guests in `<from>` can trigger Agent Requests to `<to>`.
- **No restart needed:** the Router hot-reloads `registry.json`, so `allow` and `revoke` apply to the next send. Revoking a grant does not cancel requests that are already open.
- **Stale targets:** deregistering a project does not automatically remove grants pointing to it. `list` flags unregistered targets as `(stale)`; revoke them with `scripts/ccdm agent-messages revoke <from> <stale>` before reusing that project name.

### How agents send and receive

Every Claude, Codex and Gemini project or thread session exposes three tools (absent for root):

- **`send_agent_request(target, text, timeout_minutes?)`** — accepts `project`, `project/<thread id>`, a Discord thread link, or a unique live `project/<thread name>`. Returns a Router-minted `req-…` ID as soon as the Router records the request; `timeout_minutes` defaults to `30` and caps at `120`. Sending to an ungranted, unknown or `remote:` project (or `root`, or an unresolved link) returns `not_granted`; inside a granted project, an unmatched or non-thread target returns `unknown_target` and a thread name shared by multiple live threads returns `ambiguous_target` (none of these post anything). Sending to a conversation with no live session returns `target_offline` at once (or `target_closed` for an archived thread); it never starts a session, never reopens a closed thread, and is never queued for later delivery.
- **`send_agent_reply(request_id, text)`** — sends the single reply to an open request addressed to this conversation and reports whether the sender's session was live (`delivered_to_live_session`). A second reply is refused (`already_replied`), and a late reply after expiry is refused (`request_expired`).
- **`list_agent_targets()`** — lists granted, registered, non-remote projects with `channel_live` and live capable threads (id and name).

Delivery is asynchronous and never steers an active turn:

- **Own turn:** Claude holds Agent Messages until the running turn ends (delivering one per turn end, oldest first); Codex queues them as their own turn without `turn/steer`; Gemini runs each as its own prompt without batching. `/pause` and thread bootstrap hold them in all three providers; a held request whose `expires_at` passes while waiting is dropped.
- **Marked and untrusted:** every delivered Agent Message names the sender (`sender="agent"` in Claude; a `[Agent Request …]` / `[Agent Reply …]` header in Codex and Gemini). Every session's instructions remind the agent that an Agent Request is from another agent, not from you, never authorizes destructive, irreversible or outward-facing work, and that `reply` still posts only in its own conversation.
- **Delivery across reconnects and Router restarts:** each delivery is acknowledged once held and deduplicated by `delivery_id`; an unacknowledged delivery is re-sent if the same launch reconnects (including after a Router restart), while a new launch receives nothing from before it started.

### Visibility in Discord

Every accepted request and reply appears in both conversations, with no pings (`allowed_mentions` empty):

- **Sender side:** posted in the sender's conversation through the sender's Project Identity webhook (`<project>-<provider> · N%`).
- **Receiver side:** posted in the target conversation as the root bot, naming the sender (`<project>-<provider>`, or `<project>-<provider> › <thread name>` for a thread).
- **Header and links:** every record begins with `-# ⇄ Agent ` and links to its counterpart in the other conversation (messages over 2000 characters split into continuation chunks each starting with `-# ⇄ Agent Request|Reply · <id> · part <k>/<n>`, with links and marks on the first chunk). `reply` (checked on every split chunk after trimming leading whitespace) and `edit_message` refuse text or target messages starting with `-# ⇄ Agent `, so an agent can neither forge nor rewrite any chunk of a record. Both ops also refuse look-alike subtext headers (`-#` followed by 1–3 symbols and `Agent`, in any case or spacing) on the first line of any chunk, while classifiers keep matching only the exact `-# ⇄ Agent ` prefix.
- **Outcome marks:** root reacts on both request posts: ✅ once replied, or ⚠️ if expired or failed. An offline or closed attempt posts one sender-side record marked `· not delivered: target_offline` (or `target_closed`) with ⚠️ and posts nothing in the target conversation. The `react` op refuses adding or removing ✅ or ⚠️ on any Agent Message record chunk (`invalid_args`), while allowing other emoji on records and ✅/⚠️ on ordinary messages.
- **Router restart recovery:** if a Router crash interrupts a multi-chunk record, startup recovery completes only the missing chunks instead of posting earlier chunks twice. An accepted request that expires while the Router is down still has its linked records posted and marked ⚠️ after restart (without delivering the expired request to the target).

### Inspecting status and history

Check live state with `node scripts/router.js status` (or `--json`):

- `agent messages: ledger ok` (or `ledger unavailable` with the error if the ledger file is unreadable);
- `open agent requests: N` — each open request's ID, sender, target, `opened_at`, `expires_at` and `depth`;
- `recent agent refusals: N` — the latest 20 refusals (time, sender, target as given, code).

Status output never includes message text, keys or tokens.

Inspect exchange history with `scripts/ccdm agent-messages log`:

```bash
scripts/ccdm agent-messages log [--project <name>] [--request <id>] [--limit <n>] [--text] [--json]
```

`log` reads `~/.local/state/ccdm/router/agent-messages.jsonl` directly without modifying it, so it works even while the Router is stopped. It prints exchanges and refusals newest last (default 50 entries) and omits message text unless you pass `--text`. On Router start, the ledger is compacted atomically: open exchanges, unacknowledged deliveries of open exchanges, and closed exchanges, deliveries and refusals within the last 30 days are kept (unacknowledged deliveries older than 30 days are dropped once their exchange is closed). If the ledger ever becomes unreadable, `agent_request` and `agent_reply` return `ledger_unavailable` and `router status` reports `ledger unavailable`, while ordinary Discord routing keeps working; move the damaged file aside and restart the Router to recover. If `log` encounters unknown record types, it skips them and prints a one-line stderr note naming the skipped line numbers and pointing to `router status`.

### Limits, reminders and threads

Optional top-level `agent_message_limits` in `registry.json` overrides the four defaults (all positive integers; hot-reloaded on the next send; invalid values or unknown keys keep the last good table):

```json
"agent_message_limits": {
  "depth": 3,
  "requests_per_hour": 20,
  "open_requests": 5,
  "max_characters": 4000
}
```

| Limit | Default | Scope |
|-------|---------|-------|
| `depth` | `3` | Maximum nested request chain depth (A→B→C→D succeeds; a fourth hop returns `depth_exceeded`) |
| `requests_per_hour` | `20` | Sliding-hour cap per sending project (counts accepted requests plus `target_offline` and `target_closed` attempts) |
| `open_requests` | `5` | Unanswered, unexpired requests per sending conversation |
| `max_characters` | `4000` | Maximum characters in one request or reply |

An Agent Message never acknowledges, reopens or arms a Conversation Reminder (replies during an agent-started turn arm nothing until owner input joins), never resets a Thread Conversation's idle eviction clock (though a running agent-started turn is never evicted), and never settles a pending ⏳ thread turn mark.

### Refusal codes

The Router can refuse `agent_request`, `agent_reply` and `agent_targets` with these codes:

| Code | Operations | When it happens | Posted in Discord |
|------|------------|-----------------|-------------------|
| `invalid_args` | `agent_request`, `agent_reply` | Missing or empty required field (`target`, `request_id`, `text`, `idempotency_key`), or `timeout_minutes` is not a positive integer | Nothing |
| `forbidden` | `agent_request`, `agent_reply`, `agent_targets` | Called by a connection whose role is not `project` or `thread` (for example `root`, `observer`, `supervisor` or `status`) | Nothing |
| `ledger_unavailable` | `agent_request`, `agent_reply` | The Router's ledger could not be read at startup or appended to | Nothing |
| `not_granted` | `agent_request` | Sender is `remote:`, or target resolves to `root`, a `remote:` project, an unregistered project, an unresolved link, or a project not in the sender's `agent_message_targets` | Nothing |
| `unknown_target` | `agent_request` | Inside a granted project, a thread ID or Discord link is not a public thread under that project's channel, or no live thread matches `project/<thread name>` | Nothing |
| `ambiguous_target` | `agent_request` | Inside a granted project, two or more live threads share the requested `<thread name>` | Nothing |
| `text_too_long` | `agent_request`, `agent_reply` | `text` exceeds `agent_message_limits.max_characters` (default `4000`) | Nothing |
| `request_rate_exceeded` | `agent_request` | Sending project reached `agent_message_limits.requests_per_hour` (default `20`) in the sliding hour | Nothing |
| `open_requests_exceeded` | `agent_request` | Sending conversation reached `agent_message_limits.open_requests` (default `5`) unanswered, unexpired requests | Nothing |
| `depth_exceeded` | `agent_request` | Request chain depth would exceed `agent_message_limits.depth` (default `3`) | Nothing |
| `target_closed` | `agent_request` | Target thread is archived in Discord (even if a listener is connected) | One sender-side record (`· not delivered: target_closed`) with ⚠️; nothing in target |
| `target_offline` | `agent_request` | Target conversation has no live listener announcing `agent_messages` | One sender-side record (`· not delivered: target_offline`) with ⚠️; nothing in target |
| `unknown_request` | `agent_reply` | No exchange has that `request_id`, or it is not addressed to the calling conversation | Nothing |
| `request_expired` | `agent_reply` | The request's `expires_at` has passed | Nothing (expiry already reacted ⚠️ on the request posts) |
| `already_replied` | `agent_reply` | The request was already answered | Nothing |
| `request_failed` | `agent_reply` | The request already failed (for example its record could not be posted), or the sender or target project was deregistered or moved channels while open | No reply record (a route-change failure reacts ⚠️ on existing request posts) |

## Accounts and homes

Each provider keeps its login, configuration and saved conversations in a **home** directory. CCDM selects a home per project, and per thread by alias. Credentials stay in the homes; never put them in the registry, this README or logs.

| Provider | Alias map (top level) | Project selector | Default |
|----------|----------------------|------------------|---------|
| Claude | `claude_accounts` (threads only) | `claude_home` (a path) | `CLAUDE_CONFIG_DIR`, else `~/.claude` |
| Codex | `codex_accounts` | `codex_account` (an alias) | `default_codex_account`, else `~/.codex` |
| Gemini | `gemini_accounts` | `gemini_account` (an alias) | your own home |

### Claude homes

A project's `claude_home` is the `CLAUDE_CONFIG_DIR` its session runs with. Log in to an extra home by running `claude` once with `CLAUDE_CONFIG_DIR` set to it. The top-level `claude_accounts` map (alias → Claude home) lets a thread's `--account` or `/config account=` name a home by alias, and names that home in the Usage Report; a thread without one uses the project's `claude_home`, then the default.

### Codex Accounts

CCDM names each Codex account with a stable **Codex Account Alias**. Its mapped **Codex Home** is the directory holding that account's configuration, credentials, cache and sessions. Configure aliases in the top level of `registry.json`:

```json
"codex_accounts": {
  "primary": "~/.codex-primary",
  "secondary": "~/.codex-secondary"
},
"default_codex_account": "primary"
```

New Codex projects and the root bridge inherit `default_codex_account` unless a higher-priority selector is present. A project opts into another account with `codex_account`:

```json
{
  "type": "codex",
  "ws_port": 18342,
  "codex_account": "secondary"
}
```

The `codex_account` field is persisted on a project only when it selects a non-default account. Projects on the default need no project-level selector.

#### Login preparation

Prepare every new Codex Home before starting a session. For a subscription account, create the directory, use file-backed credentials, and run the normal subscription `codex login`:

```bash
mkdir -p ~/.codex-secondary
printf '%s\n' 'cli_auth_credentials_store = "file"' > ~/.codex-secondary/config.toml
CODEX_HOME=$HOME/.codex-secondary codex login
CODEX_HOME=$HOME/.codex-secondary codex login status
```

Do not use `--with-api-key` for a subscription account. Keep each `auth.json` private.

#### Precedence and legacy compatibility

The **Legacy Codex Home Override** is a raw `codex_home` path, kept for registries that predate named accounts.

**Project precedence** (highest first):

1. Project `codex_account` or project `codex_home`.
2. Top-level `default_codex_account` or top-level Legacy Codex Home Override.
3. `~/.codex`.

**Root precedence** (highest first):

1. `ROOT_CODEX_HOME`, the emergency direct-path override.
2. Top-level `default_codex_account` or top-level Legacy Codex Home Override.
3. Ambient `CODEX_HOME`.
4. `~/.codex`.

A named selector and a raw-home selector at the same configuration scope are a hard error. Unknown aliases, empty selectors and unusable homes also fail with an actionable error, before any MCP cleanup, tmux creation, PID change or root-session teardown. There is no `ROOT_CODEX_ACCOUNT`; use `ROOT_CODEX_HOME` when the registry must be bypassed during recovery. The bridge receives only the resolved absolute `CODEX_HOME`, never an alias.

#### Manual migration checklist

Moving from a raw `codex_home` to named accounts is done by hand; `setup.sh` does not migrate an existing `registry.json`:

1. **Create and authenticate the new home.** Prepare the file-backed subscription Codex Home and complete `codex login`.
2. **Migrate the ignored `registry.json`.** Replace the top-level `codex_home` with `codex_accounts` and `default_codex_account`. Add project `codex_account` only for projects that need a non-default account.
3. **Restart every affected long-lived Codex project session and the root Codex bridge.** Stop the old processes first, then start them again so each process reads the current selection.
4. Verify each session's resolved account without recording credentials or `auth.json` contents.

**Rollback:** restore the previous top-level Legacy Codex Home Override, remove named project selectors that are no longer needed, then restart every affected project and the root Codex bridge again.

#### MiMo API accounts

MiMo can power the Codex bridge through its Responses API. Prepare a separate home with Python 3.10+ and a recent Codex CLI (tested with 0.153.4):

```bash
python3 scripts/setup-codex-mimo.py --home ~/.codex-mimo --billing payg
```

- **Key:** the command prompts for it without echo. Automation can set `MIMO_API_KEY` or pipe the key through stdin; never put a real key in command arguments.
- **Billing:** `--billing payg` (the default) uses `https://api.xiaomimimo.com/v1` and an `sk-` key. `--billing token-plan` uses `https://token-plan-cn.xiaomimimo.com/v1` and a `tp-` or `ttp-` key. Switching billing endpoints needs a new home.
- **Model:** the helper downloads and validates Xiaomi's model catalog and defaults to `mimo-v2.6-pro` with high reasoning and web search disabled. `--model` selects another catalog model with Responses lite and reasoning support. `--catalog-file` uses a downloaded catalog for offline setup.
- **What it writes:** a new private home (mode `0700`) with the key in its `api-key` file (`0600`) and a `ccdm-mimo.json` marker recording the billing option. Codex's provider authentication command reads the key file directly, so no `MIMO_API_KEY` needs to be inherited and no OpenAI `codex login` is needed.
- **What it does not do:** it rejects existing homes and paths inside this checkout, changes no registry, default account or running session, and makes no billable inference call or balance check.

The vendor catalog enables `use_responses_lite`, needed for custom tools. Reasoning support comes from the catalog; the vendor guide's older top-level `model_supports_reasoning_summaries` setting is rejected by Codex 0.153.4's strict configuration parser and is deliberately omitted. MiMo billing and quota are not part of the Usage Report.

References: [MiMo Codex integration](https://mimo.mi.com/docs/en-US/tokenplan/integration/codex-configuration) and [Codex provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

#### DeepSeek 4.1 Flash API accounts

DeepSeek 4.1 Flash uses the API model name `deepseek-flash` (as of September 22, 2026; the alias may change models later). Prepare its own home with Python 3.10+ and a recent Codex CLI (tested with 0.153.4):

```bash
python3 scripts/setup-codex-deepseek.py --home ~/.codex-deepseek
```

- **Key:** enter it at the hidden prompt. Automation can set `DEEPSEEK_API_KEY` or pipe the key through stdin; the environment variable wins. The helper stores it in a private `api-key` file, and Codex reads it with its provider authentication command. No OpenAI login is needed.
- **Catalog:** the helper downloads DeepSeek's official setup script **as data only**, extracts its literal model-catalog JSON without executing the script, and keeps the `deepseek-flash` entry. It validates standard Responses, shell/patch tools, vision and high reasoning support before creating any state. If the upstream layout changes, setup fails; `--catalog-file <path>` accepts a downloaded catalog JSON or vendor script.
- **Configuration:** `https://api.deepseek.com/`, high reasoning, and built-in web search disabled. Supported efforts are `low`, `high` and `max`. The catalog differs from MiMo's (`use_responses_lite = false`, `shell_type = "shell_command"`); do not reuse MiMo's.
- **What it does not do:** it refuses existing homes and paths inside this checkout, edits no registry, restarts nothing, and makes no billable call.
- **Capabilities:** Flash accepts image input. Browser or computer control additionally needs a configured Computer Use tool.
- **Usage:** DeepSeek has no ChatGPT-style quota window, so the Usage Report shows its account balance and local token totals instead (see [DeepSeek in the report](#deepseek-in-the-report)).

The home uses mode `0700` and its files `0600`. Keep the whole home, including its `ccdm-deepseek.json` setup marker, outside the repository.

**Exa web search (optional).** Pass `--with-exa` when creating a home to add web search and page reading through [Exa MCP](https://exa.ai/docs/get-started/exa-mcp). For an existing home, add this table once to its `config.toml`:

```toml
[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
```

Exa's hosted endpoint offers keyless, rate-limited access; searches and requested page URLs go to Exa, and higher usage needs Exa authentication. Editing the file directly avoids the OAuth prompt `codex mcp add` triggers in Codex 0.153.4. Keep `web_search = "disabled"`: it disables provider-native search, not MCP tools. The flag writes configuration only, does not contact Exa, and cannot be combined with `--rotate-key`. Restart the affected session to load the tools. Remove it with `CODEX_HOME="$HOME/.codex-deepseek" codex mcp remove exa`.

References: [DeepSeek Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) and [DeepSeek model reference](https://api-docs.deepseek.com/quick_start/pricing/).

#### Using an API home on a project

The same steps apply to MiMo and DeepSeek homes:

1. Test the home in a disposable directory first:
   ```bash
   CODEX_HOME=$HOME/.codex-mimo codex exec --strict-config --skip-git-repo-check \
     -C /tmp -s read-only 'What is 2 + 2? Reply only with the answer.'
   ```
2. Add an alias to the existing `codex_accounts` object, keeping its other entries and the current default:
   ```json
   "mimo": "~/.codex-mimo"
   ```
3. On the project, set `"codex_account": "mimo"`. Remove a same-scope `codex_home` and any incompatible model, effort or service-tier override; omit `codex_model` to use the home's model.
4. Restart only that project: `scripts/stop-session.sh <project>`, then `scripts/start-codex-session.sh <project>`.

To switch back, restore the project's previous selector and restart it.

**Rotate a key** without touching configuration, MCP entries, catalogs or history, then restart the sessions using that home:

```bash
python3 scripts/setup-codex-mimo.py --home ~/.codex-mimo --billing payg --rotate-key   # the home's original billing option
python3 scripts/setup-codex-deepseek.py --home ~/.codex-deepseek --rotate-key
```

### Gemini accounts

agy keeps its Google sign-in under `$HOME/.gemini`, so a second account is a second home folder. Sign in there once with `mkdir ~/.agy-work && HOME=~/.agy-work agy`, and trust the CCDM checkout when asked. Then name the homes in the registry and pick one per project with `gemini_account` (unset, agy runs under your own home):

```json
"gemini_accounts": { "agy-main": "~", "agy-work": "~/.agy-work" },
"projects": { "my-project": { "type": "gemini", "gemini_account": "agy-work" } }
```

- The session's agy runs with that home as `HOME`, so it uses that sign-in and keeps its conversations there.
- The shell commands its agent runs get your real home back (through `scripts/agy-shell`, as zsh's `ZDOTDIR` and bash's `BASH_ENV`), so git, gh, ssh and your other tools work as usual. Only a plain `sh` command still sees the account home.
- An unknown alias or a missing home fails the start.
- A Gemini thread uses its `--account`, else the project's `gemini_account`, else your own home. `/config account=` switches a Gemini thread's account (a fresh conversation, after your ✅).
- On Windows agy does not take its account from `HOME`, so a `gemini_accounts` home other than your own is refused there, for projects and threads. Windows runs Gemini under the one account agy is signed in with.
- A project's `--resume` looks in the home its `gemini_account` names now, so after changing a project's account its old conversation is not resumed. A thread keeps the home it started in.

**macOS keychain.** Give each extra account home its own keychain. agy saves its token through `/usr/bin/security`, which finds no default keychain under a bare home. Each token refresh then pops a "Keychain Not Found … store 'antigravity'" dialog, and falls back to the token file after 5 s (click Cancel, never Reset To Defaults). Create the keychain with the account home as `HOME`, so it joins only that home's keychain list and never your own:

```sh
H=~/.agy-work; mkdir -p "$H/Library/Keychains"
(umask 077; openssl rand -hex 24 > "$H/.keychain-password")
HOME=$H security create-keychain -p "$(cat "$H/.keychain-password")" "$H/Library/Keychains/login.keychain-db"
HOME=$H security set-keychain-settings "$H/Library/Keychains/login.keychain-db"  # no auto-lock
```

The keychain starts each boot locked, and a locked one prompts for its password. Unlock it at login, for example with a LaunchAgent (`RunAtLoad`) running `HOME=$H security unlock-keychain -p "$(cat "$H/.keychain-password")" "$H/Library/Keychains/login.keychain-db"`. `unlock-keychain` may print "passphrase … not correct" and exit 51 even when the unlock worked. The password file is no weaker than the plaintext token file agy already keeps in that home.

## Project Guests

To invite someone into one project channel only:

```sh
scripts/guest-access.js invite <project-or-channel-id> <discord-user-id>
```

This creates a one-use invite that lasts 7 days, and a per-project guest role named `ccdm-guest-<project>-<channel_id>`. The role, and the guest as a member, are denied View Channel on the CCDM-managed categories (`category_ids`), the channels under them, and every other project channel. They are then allowed on the target channel with view, send, message history, attachments, reactions and thread replies. The guest's user ID is recorded in the project's `guest_user_ids`.

| Command | Use |
|---------|-----|
| `invite <target> <user_id>` | Someone not yet in the server |
| `grant <target> <user_id>` | Someone already in the server |
| `revoke <target> <user_id>` | Remove the guest role, the registry entry and any outstanding invites |
| `sync [target]` | Reapply the Discord permissions from the registry, for one project or all |
| `list [target]` | Print each project's guests |

A target is a project name, a channel ID, or a thread ID or link (which acts on the thread's parent project). The Router reloads guests from `registry.json`, so a guest reaches the project session on their next message, and a revoked one stops at once, with no restart. Guests can drive the project's channel and threads. They can never reach root.

## Project Conversation state

The opt-in [Project Conversation state service](docs/conversation-reminders.md) sends **Conversation Reminders**. It records owner replies, `/close`, reopening and due times for registered channels and their threads. It watches every project channel as a read-only Router client and sends a `👀` as the root bot one hour after a conversation starts awaiting the owner. While reminders are ignored the gap grows to 2, 4, 6 … hours and settles at one a day.

```bash
scripts/conversation-reminder-service.py enable   # check prerequisites and opt in
scripts/conversation-reminder-service.py run      # start the foreground worker
scripts/conversation-reminder-service.py status   # per-channel readiness
```

- Any owner reaction or reply acknowledges a conversation. `/close` in a channel or thread ends its reminders until the owner's next message.
- On macOS, `scripts/install-conversation-reminder-service.sh` supervises the same worker as an opt-in LaunchAgent (`com.discord.conversation-reminders`). It validates configuration first and keeps credentials out of the plist.
- After a restart, reconnect or re-enable, the service reconciles missed activity before sending. Each overdue channel then gets at most one catch-up, spaced at least five seconds apart.

## Usage Report

`scripts/claude-usage.sh` reports Claude usage on demand:

- **Live data** (macOS only): account profile, 5-hour session limits, 7-day limits, extra usage billing. It reads your Claude Code OAuth token from the macOS Keychain. On Linux this part is skipped.
- **Local data** (all platforms): lifetime stats, monthly breakdowns, top projects, busiest days, streaks.

Ask root for it by messaging `usage`, `limits` or `how much usage left`.

For a report covering Claude, Codex, DeepSeek and Antigravity, posted to a Discord channel on a schedule, see the [Scheduled Usage Stats Poster](#scheduled-usage-stats-poster).

## Commands

### Root commands

Message the root agent in a root channel:

| Command | Description |
|---------|-------------|
| `list` / `status` | Show all registered projects and their status |
| `start <project>` | Start a project's Claude Code, Codex or Gemini session |
| `stop <project>` | Stop a project's session |
| `restart <project>` | Restart a project's channel session. Threads are left alone unless you name them |
| `register` / `setup` | Register a project to a channel (asks for channel, path and provider) |
| `deregister` / `remove` / `unregister` | Stop a project and delete its webhook and registry entry (the channel stays) |
| `router status` | Show the Router's gateway state, connected sessions and scopes, webhook health, recent scope violations, and Agent Messages ledger, open requests and recent refusals |
| `allow / revoke / list agent messages` | Manage one-way [Agent Message Grants](#agent-messages) with `scripts/ccdm agent-messages` |
| `probe <project>` | Post a test notice through a project's webhook |
| `guest invite <project> <user_id>` | Create a project-scoped guest invite |
| `guest revoke <project> <user_id>` | Remove project guest access |
| `context report` | Context window usage for all running sessions (via tmux) |
| `usage` / `limits` | Rate limits, usage stats and account info |
| `restart yourself` | Restart the root agent |
| `create a poll` | Create a native Discord poll in any channel |

### Channel and thread commands

These plain commands are handled outside the model, never as an agent turn. The owner and the channel's guests may send them unless noted.

| Command | In a project channel | In a thread |
|---------|---------------------|-------------|
| `/pause` / `/unpause` | Queue new messages without interrupting the active turn, then deliver them in order | Same |
| `/compact` | Compact the conversation | Same |
| `/clear` | Start a fresh conversation | Relaunch the thread as a fresh conversation |
| `/restart` | Restart that project's session only (never root), as a new conversation | Relaunch the thread into the same conversation |
| `/close` | End Conversation Reminders for the channel; it reaches only the reminder service | Owner only: archive the thread, stop its session, close its reminders |
| `/model` | Show the model, thinking level and account/home the session runs with | Same, for the thread |
| `/thread <name> […]` | Create a Thread Conversation | — |
| `/config` | List the settings new threads inherit | Owner only: show or change the thread's settings |

`/thread`, `/config` and `/model` are answered by the Thread Supervisor, so they need it installed. In a root channel, root answers `/model`.

### Scripts

| Command | What it does |
|---------|--------------|
| `scripts/start-session.sh <project> [--resume <session_id>]` | Start a Claude project |
| `scripts/start-codex-session.sh <project> [--resume <thread_uuid>]` | Start a Codex project |
| `scripts/start-gemini-session.sh <project> [--resume <session_id>]` | Start a Gemini project |
| `scripts/stop-session.sh <project> [--threads\|--all]` | Stop the channel session; `--threads` stops only its thread sessions, `--all` both |
| `scripts/threads.sh list\|create\|stop\|restart\|close …` | Operate [Thread Conversations](#thread-conversations) |
| `./restart-root-agent.sh` | Start or restart root as Claude |
| `./restart-root-codex-agent.sh [channel_id]` | Start or restart root as Codex |
| `node scripts/router.js status [--json]` | Router health, sessions, webhooks, scope violations, and Agent Messages status |
| `scripts/ccdm agent-messages allow\|revoke\|list\|log …` | Manage [Agent Message Grants](#agent-messages) and inspect exchange history (macOS and Windows) |
| `scripts/guest-access.js invite\|grant\|revoke\|sync\|list …` | Manage [Project Guests](#project-guests) |
| `scripts/export-discord-range.js <channel-id\|thread-id\|link\|thread-name> <start-message-id> [end-message-id]` | Export a message range with the root token (operator use) |
| `npm test` | Run the test suite against local fakes |

To restart a project by hand, run `stop-session.sh`, then its launcher. Stop an old listener before starting a replacement.

## Resuming a conversation

A normal launch, and `/restart` in a project channel, start a new conversation. Each launcher takes an explicit `--resume` to continue a saved one. A resume never falls back silently to a fresh conversation: if it fails, the launch cleans up and exits non-zero. Stop the project first:

```bash
scripts/stop-session.sh my-project
scripts/start-session.sh my-project --resume <session_id>          # Claude
scripts/start-codex-session.sh my-project --resume <thread_uuid>   # Codex
scripts/start-gemini-session.sh my-project --resume <session_id>   # Gemini
```

`/clear` still starts a new conversation; the resume argument applies only at startup.

### Resuming a Claude conversation

The id is the Claude session UUID: the registry's recorded `session_id`, or the transcript's file name. The transcript must exist in the Claude home the project launches with (`claude_home`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`) at `projects/<project path with each non-alphanumeric character as ->/<session_id>.jsonl`. A missing transcript, a non-UUID, or an already running session is refused before anything starts.

### Resuming a Codex conversation

Get the UUID from the bridge's `Codex thread started:` log line. The selected Codex Home must contain that saved thread. The bridge resumes it and refreshes the Discord instructions; if that instruction request is rejected, or is not acknowledged within 60 seconds, startup fails. A resume launch has the same 120 s connection limit as any Codex launch.

To change Codex accounts and keep the conversation:

1. Locate its `sessions/.../rollout-...-<thread_uuid>.jsonl` file in the old home, and verify the thread ID and project directory in its session metadata.
2. Stop the project.
3. Copy that file into the same relative `sessions/` location in the target home, without overwriting an existing file.
4. Set the project's `codex_account` to the target alias.
5. Launch with `--resume <thread_uuid>`.

Keep the original file and account selection for recovery. The target account must already be logged in; do not copy credentials between homes. This preserves the saved conversation, not running tools or child-agent processes.

### Resuming a Gemini conversation

The launch records the agy session id as the project's `session_id`. Resume refuses an id with no conversation in the account home's `.gemini/antigravity-cli/conversations`, and refuses while the project's session still runs.

## Router operations

**Admin commands** (root's register and deregister workflows run the first two):

| Command | What it does |
|---------|-------------|
| `node scripts/router.js ensure-webhook <project>` | Find or create `ccdm-<project>` in the project's channel and record its `webhook_id` |
| `node scripts/router.js delete-webhook <project>` | Delete the project's webhook and its private token and clear `webhook_id` |
| `node scripts/router.js probe <project>` | Post one short connection notice through the project's webhook and check Discord returned the expected `webhook_id` |
| `node scripts/router.js migrate-root-config` | Copy root channels and users from root's legacy `access.json` into the registry, once |
| `node scripts/router.js preflight` | Read-only readiness check, as the installer runs it |
| `node scripts/router.js serve` | Run the Router in the foreground |

The scripts that wrap Node (`migrate-to-router.sh`, `retire-pool.sh`, the Thread Supervisor) run `node` unless `CCDM_ROUTER_NODE` names another binary.

### Cutover and retirement

These tools move an older Bot Pool install to the Router. They are kept for installs that still have pool fields in `registry.json`; a fresh install never needs them. A project launch requires the project's `webhook_id`: the launchers refuse a project without one before writing a key, starting tmux or recording a PID, and the Claude and Codex launchers point at `migrate-to-router.sh`.

Do the cutover in this order:

1. **Stop every pool session.** Run `scripts/stop-session.sh <project>` for each project. While a project still names its former pool bot (`bot_id`), the stop also sweeps that bot's leftover official-plugin listener by its `DISCORD_STATE_DIR`.
2. **Move root's configuration.** Run `node scripts/router.js migrate-root-config` once, install the Router with `scripts/install-router-service.sh`, check `node scripts/router.js status`, and restart root.
3. **Migrate each project.** Run `scripts/migrate-to-router.sh <project>` per project.
4. **Retire the pool.** Run `scripts/retire-pool.sh` (a dry run), review it, then `scripts/retire-pool.sh --apply`.

**`scripts/migrate-to-router.sh <project>`** records one project on the Router:

- **Preflight:** the Router is healthy, the project is registered and not yet on the Router, and root has its channel permissions. A preflight failure changes nothing.
- **Steps:** stop the session (including a leftover pool listener), run `ensure-webhook`, record `transport: "router"`, issue the reminder `assignment-changed`, start the session through its launcher, then verify the round trip: `router status` shows it connected in its channel, and `router.js probe <project>` posts a notice under the project's `webhook_id`. Each step prints `<step>: ok` or `<step>: failed — <reason>`.
- **Failure:** any failure after preflight restores the project's previous registry state, restarts its session, and exits non-zero naming the failed step.
- **`--rollback`** refuses, since no pool bot remains to return to.
- **`--resume <project>`** also keeps the conversation. Before the stop step (which clears `pid` and `session_id`) it prints `resume: <id> (<source>)` or `resume: skipped — <reason>`, and the start step, and a rollback's start, pass that id to the launcher's `--resume`. For Claude the id is the running session's own `sessionId` from `<claude home>/sessions/<pid>.json`, else the registry's `session_id`, and its transcript must exist in the project's Claude home. Codex launches record no thread id, so the id is the newest `codex-discord-bridge` rollout (not a subagent's) whose `cwd` is the project directory in the project's resolved Codex Home; it is skipped when another Codex project or the CCDM checkout shares that directory. Without an id or transcript/rollout, or when the launcher cannot resume it, the project starts fresh and the migration continues. Because cutover step 1 clears `session_id`, run `--resume` on projects that are still running (the migration stops them itself).

**`scripts/retire-pool.sh`** removes what is left of a Bot Pool:

- It refuses, naming the projects, while any project still tied to a pool bot (by `bot_id`, `bot_display_name`, or a pool entry's `assigned_to`) lacks `transport: "router"`. A project registered after the cutover needs no `transport`.
- By default it is a dry run that prints each action and changes nothing.
- With `--apply` it uses the root token to remove every old pool bot from the server, and moves their state directories (`~/...` paths included) into a private backup at `~/.local/state/ccdm/pool-retirement/` (0700; `CCDM_POOL_BACKUP_DIR` overrides it). It also deletes the obsolete `project-bot` role, saves a 0600 copy of the registry in the backup, and strips the pool fields from `registry.json`. Bot applications are kept.
- A state directory it cannot move (none recorded, not an absolute path, or missing) is reported as skipped, and `--apply` then exits 2 with the list instead of claiming success.
- An interrupted `--apply` finishes the remaining work when rerun, and a rerun after retirement does nothing.

## Scheduled Usage Stats Poster

An opt-in macOS LaunchAgent can post a text Usage Report to a Discord channel on a schedule. It is not installed by `setup.sh`.

### Configure and install

Configuration lives in the ignored `.usage-stats-poster.json`. Start from the tracked example, set the destination channel and any Claude API-account transcript paths, then validate:

```bash
cp .usage-stats-poster.example.json .usage-stats-poster.json
python3 scripts/usage-stats-poster.py --validate-config
python3 scripts/usage-stats-poster.py --dry-run      # preview: prints every embed field, posts nothing
```

| Config key | Meaning |
|------------|---------|
| `discord_channel_id` | The channel the report posts to |
| `history_db_path` | Where the history database lives (optional) |
| `claude_api_accounts` | `[{path, label}]` Claude API-key config directories to estimate costs for |
| `deepseek_balance_references` | Optional display budgets, see [DeepSeek in the report](#deepseek-in-the-report) |

Install the schedule:

```bash
scripts/install-usage-stats-poster.sh                 # 600 seconds (10 minutes)
scripts/install-usage-stats-poster.sh --interval 900  # 15 minutes
```

The installer needs `python3` and `codex` on `PATH`, and exits before touching LaunchAgents if either is missing. It renders and validates `~/Library/LaunchAgents/com.discord.usage-stats-poster.plist` with absolute paths to Python, Codex, the poster and its logs. The plist holds no token, channel ID or poster configuration. The installer never sends a Discord request, and the interval-only schedule means installing does not trigger an immediate post. Reinstalling unloads the existing label first, so changing the interval is idempotent; if the new load fails, the prior plist and loaded state are restored. Pillow is not needed.

The poster posts with the root bot token from root's state directory (`~/.claude/channels/discord/.env`, or `ROOT_DISCORD_STATE_DIR`; set that in the LaunchAgent environment too when you use it). Missing credentials fail before any Discord request.

### Schedule and history

- Every automated run records a local snapshot in UTC 10-minute slots.
- The report is posted once per UTC 30-minute slot. Any run inside the slot posts if the ledger has no post for it yet, so a run skipped during sleep, or a request that never reached Discord, is retried by the next run in the same slot. If Discord received the request but its reply was lost, the slot is recorded as posted to avoid a duplicate.
- History is stored at `~/Library/Application Support/CCDM/usage-stats/history.sqlite3` by default (`history_db_path` overrides it). The database and lock are private (`0700` directory, `0600` files). Snapshots are kept for 365 days, and an advisory lock makes repeated runs idempotent. Nothing is backfilled.
- Only the poster's own SQLite files count toward a 5 GiB size warning, emitted at most once every 24 hours. Codex session logs and Claude transcripts are never counted or deleted.

| Run | Behaviour |
|-----|-----------|
| LaunchAgent (`CCDM_USAGE_STATS_AUTOMATED=1`) or `--scheduled` (`--post-now` is an alias) | Record a snapshot; post if this 30-minute slot has no post yet |
| `--collect-only` | Record a snapshot without contacting Discord |
| `--dry-run` | Print the report. No bot token, no post, no history write. Wins over `CCDM_USAGE_STATS_AUTOMATED=1` |
| no flags | Post now. Never creates or writes history; reads it, best effort, for Codex credits used |
| `--validate-config` | Check the config and exit |

Logs and removal:

```bash
launchctl list | grep usage-stats-poster
tail -120 "${TMPDIR:-/tmp}/usage-stats-poster.log"
tail -120 "${TMPDIR:-/tmp}/usage-stats-poster.err"

launchctl unload ~/Library/LaunchAgents/com.discord.usage-stats-poster.plist
rm ~/Library/LaunchAgents/com.discord.usage-stats-poster.plist
```

### What the report shows

Each post is one text embed, with no image. A provider section longer than one embed field (1024 characters) continues in fields named `Claude Code (cont.)`, `Codex (cont.)` or `Antigravity (cont.)`, split only between account or model-group blocks. Only a single block longer than a whole field is truncated. An embed over Discord's 25-field or 6000-character limit drops trailing continuation fields, marking the last one kept as truncated, while each provider keeps its first field.

**Claude Code (subscription accounts)**

- Limits come from Anthropic's OAuth APIs with the macOS Keychain credentials: the 5-hour session (absent on accounts that have none), the 7-day allowance for all models, and one 7-day row per model with its own weekly allowance (today `7-Day (Fable)`), each with its reset time. When a model row is shown, the all-models row reads `7-Day (all)`; otherwise it stays `7-Day`. History stores each model row as its own series.
- Limit resets appear on one line, split by what each grant's `clears` list resets. A grant that clears the all-models 7-day limit, or the 5-hour session without any 7-day limit, is **general**. One that clears only a model-scoped weekly limit takes the model its bucket names (such as `seven_day_opus`), else the account's model-scoped row. Example: `Resets: **1** general (use within 24d 8h) · **3** Fable (use within 112d 18h)`. Each group has its own earliest use-by deadline. Paused, expired, used-up and unrecognised grants (including any without `clears`) are left out, and a group with none is omitted.
- Accounts are discovered from the default `~/.claude` login and valid extra `~/.claude-*` config directories. Each home is labelled by its alias in the registry's `claude_accounts` (alias → home); a home with no alias is labelled **claude** for `~/.claude` and **claude-<name>** for `~/.claude-<name>` (for example **claude-work**). Report history is keyed by that label, so renaming an alias starts a new history series. Each extra directory must have a `.claude.json` with an `oauthAccount`, which also records the email that home is logged in to.
- Keychain lookup: a home's Keychain service is derived from the first eight hex characters of the SHA-256 hash of its config-directory path. The plain `Claude Code-credentials` item holds whichever account a session without `CLAUDE_CONFIG_DIR` last logged in to, so it can belong to any home. The poster tries a home's hashed item and the plain item, freshest first, and reports only a login whose profile email matches that home's `.claude.json`. When none matches, it shows that home's re-login command instead of another account's usage.

**Claude API-key accounts** have no comparable percentage limit, so the report shows sanitized local estimates: Today and This month costs, request counts and status.

**Codex**

- Limits for every alias in `codex_accounts`, with `default_codex_account` first and the rest alphabetical. Codex is shown as a weekly allowance only. Aliases that resolve to the same Codex Home are reported once.
- Older registries without `codex_accounts` still work: top-level and project-level raw `codex_home` paths are discovered as **Legacy Codex Home** entries. Named and legacy selectors may be mixed across scopes, but the same-scope conflict is rejected, as in [Codex Accounts](#codex-accounts).
- Credits, for subscription accounts whose live rate-limit read reports them: `Credits: **61,285** left`, or `unlimited`. The app-server reports only the current balance, so credits used come from the poster's own history. Each scheduled snapshot stores the balance with a 16-character salted hash of the app-server account id (never the id). The line adds `used N in 24h · N in 7d`, the sum of balance decreases between consecutive snapshots of the same account; increases are top-ups and are ignored. A balance from another account under the same label, or without an account hash, is never compared. A window starts from the last stored balance at or before its start, at most 6 hours older, and is omitted without one. When the weekly limit is reached and credits remain, the line ends `running on credits`.
- When live rate limits are unavailable, the poster falls back to local token usage from each home's `sessions` directory.
- Codex API-key session files expose token counts, not ChatGPT-style rate-limit percentages.

**Antigravity (`agy`)**

- One block per model group from `agy -p /usage --output-format json`: today **Gemini Models** and **Claude and GPT models**, each with a 5-hour and a weekly row, plus the separate **Gemini 4 Argon** weekly cap. Rows show percent used with the reset time. An untouched bucket shows no reset time, because agy reports "now + window" for a window that has not started.
- `/usage` is a read-only print-mode command: it starts no agent turn, spends no quota and leaves no conversation. The poster runs it once per account per run, with the repository as its workspace, stdin closed, the CLI log sent to `/dev/null`, and a 30-second limit (`CCDM_AGY_TIMEOUT_SECONDS`) that kills agy's process group (its process tree on Windows).
- The binary is `CCDM_AGY_BIN` when set, else `agy` on `PATH`, else `~/.local/bin/agy` (`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows). On Windows only your own agy account is read.
- Each other home in `gemini_accounts` is asked too, with that home as `HOME`. With more than one account every block is headed `<alias> · <group>` (your own home is the alias naming `~`, else `agy`), and a missing home is one unavailable line.
- A machine with no agy binary, no `~/.gemini/antigravity-cli` directory and no other account gets no Antigravity field. Otherwise a missing binary, an expired sign-in, a timeout or unreadable output is one short `*Usage unavailable: <reason>*` line, and the rest of the report is unchanged.

### DeepSeek in the report

A configured Codex Home that carries the `ccdm-deepseek.json` setup marker is reported from DeepSeek instead of the Codex rate-limit request. (A DeepSeek-backed session still runs through the Codex app-server; only this query is skipped.)

- The poster reads the home's private `api-key`, and fetches the account-wide balance from the official `GET /user/balance` endpoint on `https://api.deepseek.com`, one request per distinct key per run. Reference: [Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/).
- It pairs that with this month's local DeepSeek token totals from the session rollouts in the configured DeepSeek homes.
- The block is headed `<alias> (API)`: a bold remaining balance, a paid/granted breakdown, this month's local token total and session count, an optional `Tokens:` split line, and a short `Balance: whole account · Usage: local Codex` footer.
- The balance is account-wide; the token totals are this machine's only. Other clients, other machines and deleted rollouts are excluded, so the block never claims a provider-wide total. No spend figure is derived from the balance.
- Homes sharing a key are grouped under one labeled note, and a rollout copied between them is counted once. Distinct keys stay separate.
- A response that does not match DeepSeek's documented balance schema is reported as unavailable.

Without a reference the block shows the real amounts only, with no percentage or bar. An optional `deepseek_balance_references` object supplies a per-alias display budget, which draws an inline meter of used balance labeled with percent used and percent left:

```json
{
  "deepseek_balance_references": {
    "deepseek-flash": { "currency": "USD", "amount": "50.00" }
  }
}
```

Each entry is a `{currency, amount}` pair: `currency` is `USD` or `CNY`, and `amount` a positive decimal string. Extra fields, floats, zero and negative values are rejected at validation. A reference is a display budget, not a provider quota, and is never inferred from the current balance. A balance above the reference prints its honest percentage while the bar clamps. When a shared-key group is covered by conflicting alias references, the meter is omitted with a status line, and the real balance and local usage are still shown.

For local tests only, `deepseek_base_url` may point at a literal `http://127.0.0.1:<port>` (or `localhost`/`[::1]`) fake; any other origin is refused.

`scripts/usage-dashboard-renderer.py`, a trend-image renderer with an optional Pillow dependency, is kept for manual use. The posting workflow does not call it.

## Auto-Start on Reboot (macOS)

The Router's `com.ccdm.router` LaunchAgent starts at login by itself. tmux sessions do not survive reboots, so add a LaunchAgent to start the root agent at login too:

```bash
cat > ~/Library/LaunchAgents/com.claude.root-agent.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.root-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/ccdm/restart-root-agent.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/tmp/claude-root-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-root-agent.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/YOU/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/YOU</string>
    </dict>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude.root-agent.plist
launchctl list | grep claude        # verify
```

Replace `/path/to/ccdm` and `/Users/YOU` with your own paths. To unload: `launchctl unload ~/Library/LaunchAgents/com.claude.root-agent.plist`.

- The launcher exits non-zero while the Router is not answering, which can happen right after login. The `KeepAlive` and `ThrottleInterval` keys make launchd retry every 30 seconds until one launch succeeds.
- To start root as Codex, point `ProgramArguments` at `restart-root-codex-agent.sh`.
- Project sessions are not started automatically. After a reboot, message root with `start <project>` for each.
- This LaunchAgent starts a detached tmux session; it does not supervise root afterwards. A successful launchd exit does not prove root is still connected. Check `node scripts/router.js status` for a live root listener when Discord is online but messages get 💤.

If tmux Continuum or Resurrect also restores sessions at login, add this to `~/.tmux.conf` before the plugin loader:

```tmux
# Keep session restoration from replacing an agent already started by launchd.
set -g @resurrect-never-overwrite 'on'
```

Apply it to a running tmux server with `tmux set-option -g @resurrect-never-overwrite on`. Resurrect otherwise treats a server with only one pane as a restore from scratch and can replace that pane with a saved shell, stopping a newly started root agent. Restoring saved pane contents does not restart the agent process.

## Preventing Sleep

CCDM needs your machine to stay awake. If it sleeps, the Router and all tmux sessions go offline.

**macOS:**

- Install [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704) (free) and set it to keep the Mac awake indefinitely
- Or use the built-in command: `caffeinate -s` (keeps the system awake while the command runs)
- Or disable sleep entirely: `sudo pmset -a disablesleep 1` (undo with `sudo pmset -a disablesleep 0`)

**Linux:**

- `systemd-inhibit --what=idle sleep infinity` (prevents idle sleep while running)
- Or `systemctl mask sleep.target suspend.target`

## Configuration reference

### registry.json

`registry.json` is ignored by git and holds no bot or webhook token. The Router reloads it on change.

**Top-level keys**

| Key | Meaning |
|-----|---------|
| `discord_user_id` | The owner's Discord user ID. Required |
| `guild_id` | Your Discord server ID |
| `root_channels` | Channels where root listens without an `@mention`. The first is the primary root channel |
| `root_allowed_user_ids` | Extra users, besides the owner, who may talk to root there. Channel guests can never reach root |
| `category_ids` | CCDM-managed categories that guest roles are denied on |
| `guest_deny_channel_ids` | Optional extra channels or categories that guests are denied on |
| `codex_accounts` | Codex Account Alias → Codex Home |
| `default_codex_account` | The alias new Codex projects and root Codex use |
| `codex_home` | Legacy Codex Home Override (a raw path); not allowed beside `default_codex_account` |
| `claude_accounts` | Alias → Claude home, for thread `--account` and Usage Report labels |
| `gemini_accounts` | Alias → the home agy runs under |
| `thread_session_caps` | Live thread sessions per provider; default `{"claude": 6, "codex": 8, "gemini": 4}`. An invalid value falls back to its default |
| `agent_message_limits` | Optional [Agent Messages](#agent-messages) caps: positive integers `depth` (3), `requests_per_hour` (20), `open_requests` (5), `max_characters` (4000). Invalid values or unknown keys keep the last good table |
| `projects` | Object keyed by project name |

**Project keys**

| Key | Meaning |
|-----|---------|
| `path` | The project directory |
| `type` | `claude` (default when missing), `codex` or `gemini` |
| `screen_name` | The tmux session name (lowercase, underscores) |
| `channel_id` | The project's Discord channel. One channel per project, never a root channel |
| `webhook_id` | Written by `ensure-webhook`; required to launch |
| `guest_user_ids` | Users who may drive this project. `guest_role_id` and `guest_invites` are written beside it by `guest-access.js` |
| `agent_message_targets` | List of project names this project's conversations may send [Agent Requests](#agent-messages) to (may include itself). Manage with `scripts/ccdm agent-messages allow\|revoke\|list`, never by hand |
| `pid`, `session_id` | Runtime state written by the launchers and cleared by `stop-session.sh` |
| `model` | Claude `--model`; also the fallback for `codex_model` and `gemini_model` |
| `claude_home`, `claude_effort` | Claude home and effort (`low`, `medium`, `high`, `xhigh`, `max`) |
| `ws_port` | Codex app-server port (default 18300); unique per Codex project |
| `codex_account` | Codex Account Alias, only when not the default |
| `codex_home` | Legacy raw Codex Home; not allowed beside `codex_account` |
| `codex_model`, `codex_reasoning_effort`, `codex_service_tier` | Codex runtime overrides |
| `gemini_account` | Alias in `gemini_accounts` |
| `gemini_model`, `gemini_effort` | Gemini model and thinking level (`low`, `medium`, `high`, `xhigh`) |
| `text_reply_fallback` | `false` stops a Gemini session posting a turn's plain text when it made no `reply` call. A Codex project has this fallback off unless it is set to `true` |

Leftover Bot Pool fields (`pool`, `max_pool_size`, `project_bot_role_id`, `bot_id`, `bot_display_name`, `transport`) are ignored for routing and removed by `scripts/retire-pool.sh`.

**Writing the registry.** Every script that rewrites the registry holds one lock, a `registry.json.lock` directory beside it, and commits through an adjacent temporary file renamed into place with the registry's mode kept. Concurrent writers never drop each other's changes, and the Router's reload never reads a partial file. A lock left by a writer that died is reclaimed; a writer waits up to 30 s for a live holder (`CCDM_REGISTRY_LOCK_TIMEOUT_MS`) and then fails naming its pid. When you edit the file by hand, save it in one atomic write.

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `ROOT_DISCORD_STATE_DIR` | `~/.claude/channels/discord` | Directory whose `.env` holds `DISCORD_BOT_TOKEN` |
| `CCDM_ROUTER_STATE_DIR` | `~/.local/state/ccdm/router` | Router private state |
| `CCDM_ROUTER_NODE` | `node` | Node binary for the installers and wrapper scripts |
| `CCDM_ROOT_FALLBACK_AFTER_MS` | `120000` | Router outage before root's emergency fallback |
| `CCDM_ROUTER_RATE_LIMIT_MAX_WAIT_MS` | `30000` | Longest wait on a Discord rate limit before `rate_limited` |
| `CCDM_REGISTRY_LOCK_TIMEOUT_MS` | `30000` | Longest wait for the registry lock |
| `ROOT_CODEX_HOME` | — | Codex Home for root Codex, above the registry |
| `ROOT_CODEX_CHANNEL_ID` | — | Root channel for `restart-root-codex-agent.sh` |
| `CCDM_CLAUDE_LAUNCH_TIMEOUT_S` | `60` | Claude launch timeout |
| `CCDM_CODEX_LAUNCH_TIMEOUT_S` | `120` | Codex launch timeout |
| `CCDM_GEMINI_LAUNCH_TIMEOUT_S` | `120` | Gemini launch timeout |
| `CODEX_BRIDGE_TRANSCRIBE_AUDIO` | on | `0` turns off voice transcription in the Codex and Gemini bridges |
| `CCDM_AGY_BIN` | `agy` on `PATH` | The agy binary |
| `CCDM_AGY_TIMEOUT_SECONDS` | `30` | The usage poster's limit on `agy /usage` |
| `CCDM_THREAD_SUPERVISOR_STATE_DIR` | `~/.local/state/ccdm/thread-supervisor` | Thread Supervisor private state |
| `CCDM_THREAD_BOOT_TIMEOUT_S` | `120` | Thread session boot timeout |
| `CCDM_THREAD_WS_PORT_BASE` | `19000` | First app-server port for Codex threads |
| `CCDM_THREAD_TURN_MARKS` | on | `0` turns off the ⏳/✅/⚠️ turn marks |
| `CCDM_POOL_BACKUP_DIR` | `~/.local/state/ccdm/pool-retirement` | `retire-pool.sh` backup directory |
| `CCDM_USAGE_STATS_LOG_DIR` | `$TMPDIR`, else `/tmp` | Usage Stats Poster logs |

## Security Note

Sessions run without interactive permission prompts, because an unattended session cannot answer them:

- Claude Code sessions start with `--dangerously-skip-permissions`.
- Codex sessions run with approvals off and full disk access.
- Gemini sessions run `agy acp --dangerously-skip-permissions`.

Each agent therefore has unrestricted access to the file system and shell as your user. Only run CCDM on machines you trust, and be mindful of which projects you connect and whom you add as a guest: a guest can drive a project's session.

Discord access is contained by the Router. The root bot token lives only in root's state directory, and webhook tokens only in private Router state (0600). No session environment, file or MCP config holds a Discord token. Session Scope is enforced in software by the Router, not by an OS sandbox: local sessions run as your user, so keep the Router state directory private.

## Troubleshooting

**Bot doesn't respond to messages**

- Run `node scripts/router.js status`: the Router must be reachable with its gateway ready, and the project's session connected in its channel.
- A 💤 reaction means the channel has no live session. Start it and resend the message; it is not replayed.
- Enable **Message Content Intent** in the Discord Developer Portal (Bot settings).
- Check the bot is in the same server as you, and your user ID is `discord_user_id` in `registry.json`.
- In a root channel, check the channel is in `root_channels`.
- Check the Router logs in `~/.local/state/ccdm/router/router.err`.

**A launcher refuses a project without `webhook_id`**

- Run `node scripts/router.js ensure-webhook <project>`, or for an old pool install `scripts/migrate-to-router.sh <project>`.

**`router status` lists missing permissions**

- Grant them to the root bot's role, or on the project channel or category. CCDM never changes root's permissions itself.

**Replies fail with `webhook_deleted`**

- The project's webhook was deleted twice in a row. Run `node scripts/router.js ensure-webhook <project>`.

**A session start hangs, then times out**

- An interactive prompt in `~/.zshrc` blocks the `zsh -ic` launch. The launchers already switch off oh-my-zsh's update prompt; remove or guard any other prompt.

**`tmux` session dies immediately**

- Run the command directly without tmux to see the actual error.
- If running as the system root user: add `IS_SANDBOX=1` before `claude`.
- Check that `claude` is in your PATH (run `zsh -ic 'which claude'`). Claude Code may only be on PATH through `~/.zshrc`, which is why sessions use `zsh -ic`.
- On Linux, make sure `zsh` is installed.

**A thread does not answer**

- Check `scripts/thread-supervisor.py status` and the `supervisor:` line of `router status`. With no supervisor, thread messages get 💤.
- A failed start posts a one-line reason in the thread; the next message retries.

**Gemini: a "Keychain Not Found" dialog keeps appearing**

- Give the account home its own keychain, see [Gemini accounts](#gemini-accounts).

**Codex rejects a model with "not supported when using Codex with a ChatGPT account"**

- The model is not in that home's catalog, or the installed Codex CLI is older than the model. Upgrade the CLI and check the slug.

**Usage report shows "Could not fetch profile"**

- Live API data needs the macOS Keychain with Claude Code credentials. Run `claude` interactively once to populate it. Local stats work without it.

**Sessions lost after reboot**

- tmux sessions do not survive machine restarts. Set up the [Launch Agent](#auto-start-on-reboot-macos) so root starts automatically, then `start <project>` for each project.

## Limitations

- Sessions do not persist across machine restarts. Root can [auto-start](#auto-start-on-reboot-macos); project sessions must be started by hand.
- One session serves one project channel; a project cannot span channels.
- The Router is a single point of failure, mitigated by launchd restarts, session reconnects and root's emergency fallback.
- Webhooks cannot send native replies, so a project's reply to a specific message starts with a `↪ [jump](…)` link.
- Claude sessions load the CCDM channel with `--dangerously-load-development-channels`, a research preview that may change between Claude releases.
- Claude OAuth tokens can expire after an account is idle; they refresh on the next login or session.
- Live usage API data needs the macOS Keychain (local stats work everywhere). The service installers are macOS LaunchAgents.
- Voice message transcription needs `whisper` (optional).
- Gemini cannot steer a running turn; mid-turn messages wait for the next turn.
- **Remote VM sessions** are not supported with the Router yet: a remote session would need its own connection to the local Router (tracked as issue #125). Deregister unused VM projects rather than giving a VM a Discord token. Projects whose `path` starts with `remote:` get no Thread Conversations.

## File Structure

```
ccdm/
  README.md                  # This file
  AGENTS.md                  # Instructions for agents working in this repo (CLAUDE.md links to it)
  CLAUDE.md.example          # Root agent instructions for the one-bot Router model
  LICENSE                    # MIT
  registry.example.json      # Template — copy to registry.json
  registry.json              # Your config (not committed; holds no tokens)
  .usage-stats-poster.example.json  # Template for the usage poster config
  setup.sh                   # Interactive first-run setup
  restart-root-agent.sh      # Start or restart root Claude as a Router client
  restart-root-codex-agent.sh # Start or restart root Codex as a Router client
  docs/                      # thread-supervisor.md, conversation-reminders.md, ADRs
  scripts/
    router.js                # The Router daemon and its CLI (serve, status, preflight, webhooks, probe)
    router/                  # Router modules: socket server, client library, ops, webhooks, agent-messages, emergency fallback
    install-router-service.sh # Install the com.ccdm.router LaunchAgent
    migrate-to-router.sh     # One-project cutover onto the Router
    retire-pool.sh           # Remove leftover pool bots, state, role, and registry fields
    registry-update.py       # Locked registry writes for shell and Python callers

    start-session.sh         # Start a registered Claude project
    start-codex-session.sh   # Start a registered Codex project
    start-gemini-session.sh  # Start a registered Gemini project (agy)
    stop-session.sh          # Stop any registered project (--threads, --all)
    ccdm-channel-server.js   # CCDM channel server for Claude sessions (project, thread and root)
    codex-bridge.js          # Codex app-server bridge (project, thread and root)
    gemini-bridge.js         # Gemini bridge: drives agy acp (project and thread)
    discord-mcp-server.js    # Scoped Discord tools for Codex and Gemini, backed by the Router
    send-claude-command.sh   # Types /compact or /clear into a Claude tmux session
    resolve-codex-home.py    # The Codex Home a project or root runs with
    resolve-gemini-home.py   # The home a Gemini session's agy runs under (gemini_accounts)
    agy-shell/               # Gives a Gemini account session's shell commands the real home back
    setup-codex-mimo.py      # Prepare a MiMo API Codex Home
    setup-codex-deepseek.py  # Prepare a DeepSeek Flash API Codex Home

    thread-supervisor.py     # The Thread Supervisor worker and CLI (run, status, enable, disable, preflight)
    thread_supervisor/       # Thread Supervisor modules
    install-thread-supervisor.sh # Install the com.ccdm.thread-supervisor LaunchAgent
    start-thread-session.sh  # Start one Thread Conversation (run by the Thread Supervisor)
    threads.sh               # List, create, stop, restart, or close Thread Conversations

    guest-access.js          # Project-scoped guest invites, grants, revokes, sync, list
    export-discord-range.js  # Operator export of a message range
    conversation-reminder-service.py          # Conversation Reminder service and CLI
    install-conversation-reminder-service.sh  # Install its LaunchAgent
    usage-stats-poster.py    # Scheduled text Usage Report
    install-usage-stats-poster.sh # Install its LaunchAgent
    usage-dashboard-renderer.py   # Optional manual trend renderer (Pillow)
    claude-usage.sh          # On-demand Claude usage report
    _update-nickname.sh      # Shared statusline helper — records context %
    cc-discord-nicknames.sh  # StatusLine script — records context %
    cc-statusline-wrapper.sh # StatusLine script — context % + ccstatusline terminal UI
  skills/
    restart-self.md          # /restart-self skill — agent self-restart
    check-context.md         # /check-context skill — context window usage check
  tests/                     # E2E suite against local fakes (npm test); see tests/e2e/README.md
```

## Running on Windows

CCDM runs on Windows 11 without WSL and without tmux. A Windows PC runs its own complete CCDM: its own Discord bot, its own Router, its own sessions and its own services. It shares nothing with a Mac that runs CCDM in the same Discord server; see [Multiple machines](#multiple-machines).

The parts that differ from macOS:

| macOS | Windows |
|-------|---------|
| tmux holds the sessions | `ccdm-host`, a background program, holds the sessions |
| launchd LaunchAgents | scheduled tasks for your Windows user, in the Task Scheduler folder `\CCDM\` |
| the `.sh` scripts | one command, `scripts\ccdm` (`scripts\ccdm --help` lists what it can do) |
| `./setup.sh` | `setup.ps1` |

Type the commands of this section in PowerShell, in Windows Terminal, from the CCDM folder. Git Bash takes the same commands written as `scripts/ccdm`, except setup, which needs Windows Terminal.

`<stateRoot>` in this section is the folder `%USERPROFILE%\.local\state\ccdm`. Set `CCDM_STATE_ROOT` to use another folder.

Do the steps in this order.

### Step 1: Install the tools

| Tool | Needed | Install |
|------|--------|---------|
| Node.js 22.5 or newer | Yes | `winget install OpenJS.NodeJS.LTS` |
| Python 3.11 or newer | Yes | `winget install Python.Python.3.12` |
| Git for Windows | Yes | `winget install Git.Git` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Yes | See its docs. CCDM looks for `claude.exe` in `.local\bin` in your user folder, then on `PATH` |
| Codex CLI | Yes | `npm install -g @openai/codex` |
| `ffmpeg` | Yes | `winget install Gyan.FFmpeg` |
| Windows Terminal | Yes | Part of Windows 11 |
| PowerShell 7 | Recommended | `winget install Microsoft.PowerShell` (Windows PowerShell 5.1 also works, see step 4) |
| `whisper` | Optional | `py -3 -m pip install openai-whisper` (for voice messages) |

- Python must be a real install. The `python` that opens the Microsoft Store does not count. Check it with `py -3 --version`.
- If Python is installed in an unusual place, set `CCDM_PYTHON` to the full path of its `python.exe`.
- Open a new terminal after you install a tool, so the terminal can find it.
- Start `claude` once and sign in. Run `codex login` once if you will use Codex.

### Step 2: Turn on symlinks, then clone

Two files in the repository, `CLAUDE.md` and `.mex/AGENTS.md`, are symlinks. If git cannot make symlinks, it writes small text files in their place, and root then loads none of its instructions. Setup checks this and stops. So do these two things **before** you clone:

1. Turn on Developer Mode: Windows Settings > System > For developers > Developer Mode.
2. Tell git to make symlinks:

   ```powershell
   git config --global core.symlinks true
   ```

Now clone. Choose a folder that OneDrive does not sync. Desktop and Documents are often synced.

```powershell
git clone https://github.com/<owner>/ccdm.git
cd ccdm
npm ci
```

### Step 3: Create the Windows bot and its category

The Windows PC needs its own Discord bot. Never use another machine's bot token on this PC.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it, for example, "CCDM Win".
2. Open **Bot**. Under **Privileged Gateway Intents**, turn on **Message Content Intent**.
3. Do not copy the token yet. You fetch it during setup in step 4, when setup asks for it.
4. Open **OAuth2** > **URL Generator**. Select the `bot` scope. Under **Bot Permissions** select only **View Audit Log**. Set Integration type to **Guild Install**. Open the generated URL and add the bot to your server.
5. Never give this bot Manage Roles for the whole server. With it the bot could hand out roles that belong to another machine's guests.
6. In Discord, create a category for this PC, for example "Windows". Edit the category's permissions:
   - `@everyone`: deny View Channel.
   - Add the bot and allow it:
     - View Channels, Send Messages, Send Messages in Threads, Read Message History
     - Attach Files, Add Reactions, Manage Messages
     - Manage Webhooks (Project Identity webhooks)
     - Manage Channels, Create Instant Invite, Manage Permissions (registration and guest access)
     - Create Public Threads, Manage Threads (Thread Conversations)
7. Choose what else the bot may see. The Router answers only in its root channel and its registered project channels, and ignores every other channel it can see. Other categories are up to you:
   - To keep the bot to its own category, add the bot to every other category and deny it View Channel.
   - To let it see the rest of the server, leave the other categories alone. The bot can then read them, and so can anything that holds its token, but it does not act in them. Private channels stay hidden unless you add the bot to them.
8. Create the root channel inside the new category, for example `#root-win`. Keep its permissions synced with the category.
9. In Discord, turn on Settings > Advanced > Developer Mode. Then right-click and choose Copy ID to get four IDs: your own user ID, the server ID, the root channel ID and the category ID. Note them down. Setup asks for them.

### Step 4: Run setup

In Windows Terminal, in the CCDM folder:

```powershell
pwsh -NoProfile -File setup.ps1
```

Setup does this, in order:

1. It checks the tools from step 1. For a missing tool it prints the line that installs it, and stops. Setup installs nothing itself.
2. It checks the symlinks from step 2. If they are missing it stops and prints the fix.
3. It asks for your Discord user ID, the server ID, the root channel ID and the category ID.
4. It asks for a machine id and a machine label. Press Enter to keep `win` and `Windows`.
5. It asks for the guest mode. Press Enter to keep `member-overwrites`, or type `none` for no guests. [Guests on Windows](#guests-on-windows) explains the choice.
6. It asks for the bot token. Now open the bot's **Bot** page in the Developer Portal, click **Reset Token** and copy the token. Paste it into the prompt and press Enter. The prompt is hidden: nothing appears while you paste. Do not save the token anywhere else.
7. It writes three files and prints the next steps:
   - `registry.json` in the CCDM folder, with the root channel in `root_channels`, the category in `category_ids`, and the two fields `machine` and `guest_mode`.
   - The token file `.claude\channels\discord\.env` in your user folder. Setup first makes that folder private to your Windows account.
   - `CLAUDE.local.md` in the CCDM folder, from `CLAUDE.local.md.example`. It holds notes about this machine for root. Fill in its placeholders. Never write a token in it.

After you have pasted the token, clear the clipboard history: press Win+V, then choose **Clear all**.

- Do not run setup in the Git Bash window. That window cannot hide the token, so setup refuses there and asks nothing.
- Without PowerShell 7, or if PowerShell refuses to run the script, use Windows PowerShell:

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
  ```

- You can run setup again. At each `Overwrite it? (y/N)` question, press Enter to keep the file you have.
- Setup does not change your Claude settings.

The two Windows fields at the end of `registry.json` look like this:

```json
"machine": { "id": "win", "label": "Windows" },
"guest_mode": "member-overwrites"
```

`registry.example.json` is the macOS template and does not show them.

### Step 5: Install the services

Each service is a scheduled task for your Windows user. Install these four, in this order:

```powershell
scripts\ccdm install-service router
scripts\ccdm install-service host
scripts\ccdm install-service thread-supervisor
scripts\ccdm install-service root-at-logon
```

| Service | What it runs |
|---------|--------------|
| `router` | The Router. It holds the bot token and the connection to Discord |
| `host` | `ccdm-host`, which holds every session |
| `thread-supervisor` | The Thread Supervisor, which starts and stops the sessions of [Thread Conversations](#thread-conversations) |
| `root-at-logon` | One run after you sign in to Windows, which starts root |

- Install `router` first. The `thread-supervisor` install asks the Router whether it is ready, and stops if the Router is not running.
- Install `host` from a terminal while no session is live. Installing it restarts `ccdm-host`, and that ends every session. If a session is live, the install refuses and lists the sessions.
- `root-at-logon` does not check that the other tasks exist. It needs `router` and `host`.
- Each task records its environment when you install it: where Node, Python, Claude and Codex are, the state folder, `CLAUDE_CONFIG_DIR` and the `CCDM_*` variables. After you change one of these, or move the CCDM folder, install that service again from a terminal that has the new value.
- For Codex threads, install `thread-supervisor` from a terminal where `codex` is found, or where `CCDM_CODEX_PATH` is set.

Check the services, and check the Router's connection to Discord:

```powershell
scripts\ccdm service-status
node scripts\router.js status
```

To stop and remove a service:

```powershell
scripts\ccdm uninstall-service <name>
```

Removing `host` ends every session. Removing `thread-supervisor` leaves the thread sessions running.

Two more services are optional. Install them only if you want them.

**Conversation reminders** (see [Project Conversation state](#project-conversation-state)):

```powershell
scripts\ccdm install-service reminders
scripts\ccdm reminders enable
scripts\ccdm reminders status
```

The Router must be running. The first command starts the worker, which watches but sends nothing. The second turns reminders on. If you later run `scripts\ccdm reminders disable` and then `enable`, run the install again to start the worker.

**Usage collection:**

1. Copy the example config:

   ```powershell
   Copy-Item .usage-stats-poster.example.json .usage-stats-poster.json
   ```

2. Open `.usage-stats-poster.json`. Delete the `history_db_path` line, which is a macOS path. The history then goes to `<stateRoot>\usage-stats\history.sqlite3`. Set `claude_api_accounts` to `[]` unless you have such an account.
3. Install the service:

   ```powershell
   scripts\ccdm install-service usage-poster
   ```

- On Windows the poster only collects. The task runs `usage-stats-poster.py --collect-only`, and it never posts to Discord.
- It collects every 600 seconds. `scripts\ccdm install-service usage-poster --interval <seconds>` changes that.
- The first collection comes one interval after the install.

### Step 6: Start root and register a project

```powershell
scripts\ccdm restart-root
```

The command checks the Router first. It finishes when root has connected to the Router. Then write to root in your root channel:

```
register
```

Root asks for the channel, the project folder and the provider. Give this PC's projects a name that ends in `-win`, for example `my-app-win`. Put the project's channel inside the Windows category, so it gets the category's permissions.

### Everyday commands

The commands in the [Commands](#commands) table work the same when you send them to root on Discord. From a terminal:

```powershell
scripts\ccdm list
scripts\ccdm status
scripts\ccdm start-session <project>
scripts\ccdm start-codex-session <project>
scripts\ccdm stop-session <project>
scripts\ccdm restart-session <project>
scripts\ccdm restart-root
scripts\ccdm attach <project>
scripts\ccdm attach root
```

`attach` shows a live session in your terminal. Press Ctrl-] to leave; the session keeps running.

**Threads.** `scripts\ccdm threads` takes the place of `scripts/threads.sh`:

```powershell
scripts\ccdm threads list
scripts\ccdm threads create <project> <name> --message-file <path>
scripts\ccdm threads stop <name>
scripts\ccdm threads restart <name>
scripts\ccdm threads close <name>
```

Give `create` its first message in a UTF-8 file with `--message-file <path>`, or on standard input with `--message-stdin`. Never type the message as arguments. The first thread that starts after you sign in waits up to 90 seconds for `ccdm-host`.

**Agent Messages.** Manage one-way grants and inspect history with the same `ccdm` subcommand (see [Agent Messages](#agent-messages)):

```powershell
scripts\ccdm agent-messages allow <from> <to>
scripts\ccdm agent-messages revoke <from> <to>
scripts\ccdm agent-messages list
scripts\ccdm agent-messages log
```

**Usage report.**

```powershell
scripts\ccdm usage
```

It prints the same report as `scripts/claude-usage.sh` on macOS. It reads your Claude login from `.claude\.credentials.json` in your user folder and never changes it. Without a usable login it prints `Could not fetch profile` and `Could not fetch live usage`, and the local sections still print.

**Voice messages.**

```powershell
scripts\ccdm transcribe <audio path>
```

It prints the transcript made by `whisper`. It exits with code 3 when `whisper` is not installed. `whisper.exe` must be on `PATH`, or `CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND` must name it.

**Codex provider homes.** The MiMo and DeepSeek helpers in [Codex Accounts](#codex-accounts) take the same options on Windows:

```powershell
py -3 scripts\setup-codex-mimo.py --home ~/.codex-mimo --billing payg
py -3 scripts\setup-codex-deepseek.py --home ~/.codex-deepseek
```

A session that uses such a home needs `node` on `PATH`.

### Guests on Windows

The top-level `guest_mode` in `registry.json` decides how guests are let into one project channel. It has three values:

| `guest_mode` | What it means |
|--------------|---------------|
| absent, or `"roles"` | The macOS mode described in [Project Guests](#project-guests): one guest role per project. It is never used on Windows, because the Windows bot never gets Manage Roles for the whole server |
| `"none"` | No new guests from this machine. `invite`, `grant` and `sync` refuse and make no Discord call. `revoke` and `list` still work. Answer `none` at the setup prompt to get this |
| `"member-overwrites"` | No role. Each guest gets permissions of their own: allowed on the one project channel, denied View Channel on this machine's category and its other project channels. The bot only needs Manage Permissions on its own category, never Manage Roles for the whole server. Setup offers this value by default |

Setup offers `"member-overwrites"` by default. For it the bot needs Manage Permissions on its own category, and never Manage Roles for the whole server. Answer `none` at the setup prompt, or set `"guest_mode": "none"` in `registry.json`, and this machine takes no guests.

After setup, check it on your own server with one invite:

1. With a test account and a test project, run `invite`, `sync` and `revoke` from the block below.
2. If Discord refuses one of them, revoke the test guest and set `"guest_mode": "none"`. This machine then takes no guests.

```powershell
node scripts\guest-access.js invite <project> <discord-user-id>
node scripts\guest-access.js grant <project> <discord-user-id>
node scripts\guest-access.js sync <project>
node scripts\guest-access.js revoke <project> <discord-user-id>
node scripts\guest-access.js list
```

- `invite` is for someone who is not in the server yet. It makes a one-use invite. After they join, run `sync <project>`; the command tells you when this is needed.
- `grant` is for someone who is already in the server.
- In `"member-overwrites"` mode CCDM only touches the channels the registry names: the project channels and the categories in `category_ids`. Everywhere else in the server a guest sees what `@everyone` sees.
- Revoke every guest before you change `guest_mode`. One mode does not clean up what another mode wrote.
- Never give the bot Manage Roles for the whole server to make guests work.
- Guests can never reach root.

### Context % on Windows

Nothing to configure. The launchers write Claude's `statusLine` setting for each launch, so every reply shows the context percentage. If you already have a `statusLine` command of your own, it keeps running: CCDM passes it on with `--chain`. Your Claude settings file is not changed. Skip the `statusLine` step in [Context Usage in the Project Identity](#context-usage-in-the-project-identity).

### Preventing sleep on Windows

If the PC sleeps, the Router and every session go offline.

- CCDM asks Windows not to go to sleep from idleness while a project session or a thread session runs **and** the PC is on AC power.
- Only the installed `host` service does this. A `ccdm-host` that you start by hand does not.
- Root alone does not count. With no project or thread session running, the PC may sleep.
- On battery CCDM holds nothing. A laptop on battery goes to sleep as usual, and sleep drops the network. Keep the laptop plugged in.
- CCDM checks the power source every 30 seconds.
- It does not keep the screen on. It does not stop the sleep that follows closing the lid, pressing the power button or choosing Sleep in the Start menu.
- To see the request, run `powercfg /requests` in an administrator terminal. Its reason reads `CCDM: <n> sessions`.

### Auto-start on Windows

- The tasks start when you sign in to Windows. They run only while you are signed in.
- `router`, `host`, `thread-supervisor` and `reminders` start at sign-in. Task Scheduler also looks every 5 minutes and starts one that is not running, unless it is `disabled`.
- `root-at-logon` runs once for each sign-in. It waits one minute, then waits up to 120 seconds for the Router and `ccdm-host` to answer, then starts root. So root is up one to three minutes after you sign in.
- If that run fails, it does not try again until the next sign-in. Start root yourself with `scripts\ccdm restart-root`.
- Its log is `<stateRoot>\services\root-at-logon.log`. Look for `root is up`, `router not reachable after 120 s` or `ccdm-host not reachable after 120 s`.
- Project sessions do not start by themselves. Send `start <project>` to root.
- After a restart for a Windows update, nothing runs until you sign in. The Windows setting "Use my sign-in info to automatically finish setting up after an update" (Settings > Accounts > Sign-in options) signs you in again after such a restart. Turn it on, so that you do not have to sign in by hand.

### Troubleshooting on Windows

Start with these two commands:

```powershell
node scripts\router.js status
scripts\ccdm service-status
```

`router status` shows the gateway, the connected sessions and any channel permission the bot is missing. If the Router does not answer and its service is installed, it also prints a line `service: <state>`.

`service-status` prints one line per service:

| State | Meaning | What to do |
|-------|---------|------------|
| `running` | The service is up | Nothing |
| `backoff` | It failed and starts again after a short wait | Read its `.err` log |
| `crashloop` | It failed six times within ten minutes. The waits grow, up to ten minutes. The state ends after it has stayed up for 30 minutes | Read its `.err` log and fix the cause |
| `disabled` | It was stopped on purpose, or its program ended cleanly. A marker file `<name>.disabled` in `<stateRoot>\services` keeps it stopped | Run `scripts\ccdm install-service <name>` again |
| `stopped` | The task exists but nothing runs | Wait up to 5 minutes for the next start, or run `scripts\ccdm install-service <name>` again |
| `installed` | The task exists and has not written a state. `root-at-logon` and `usage-poster` always show this | Nothing |
| `not installed` | There is no task | Install it |

**Logs.** Each service writes `<stateRoot>\services\<name>.log` and `<name>.err`. Older logs end in `.1`, `.2` and `.3`.

**A service will not install.** The install runs a `preflight` first and prints what blocks it. You can run the checks alone; they change nothing:

```powershell
node scripts\router.js preflight
py -3 scripts\thread-supervisor.py preflight
scripts\ccdm reminders preflight
```

**A service stays stopped after `enable`.** After `py -3 scripts\thread-supervisor.py enable` or `scripts\ccdm reminders enable`, run `scripts\ccdm install-service <name>` again. `enable` alone starts nothing.

**The install says a worker is already running outside the service.** A Thread Supervisor or reminder worker that you started by hand blocks the install. Stop it with Ctrl+C in its terminal, then install again.

**Setup stops and names `CLAUDE.md` or `.mex/AGENTS.md`.** The clone was made without symlinks. Do step 2, clone again, and run setup in the new clone.

**Setup says the terminal cannot hide input.** Run setup from Windows Terminal, not from the Git Bash window.

**Upgrading `ccdm-host` while sessions are live.** `scripts\ccdm install-service host` refuses while any session is live, and root is a session. To upgrade and keep the conversations, use a terminal outside CCDM:

1. Note each project's conversation id:

   ```powershell
   scripts\ccdm status
   ```

2. Stop each project and its threads:

   ```powershell
   scripts\ccdm stop-session <project> --all
   ```

3. Install the host. `--force` ends the sessions that are left, such as root:

   ```powershell
   scripts\ccdm install-service host --force
   ```

4. Start root, then each Claude project with its id:

   ```powershell
   scripts\ccdm restart-root
   scripts\ccdm start-session <project> --resume <id>
   ```

A Codex project starts with `scripts\ccdm start-codex-session <project>`; [Resuming a Codex conversation](#resuming-a-codex-conversation) says how to find its id. A thread resumes its conversation at your next message in it.

If `ccdm-host` ends cleanly, for example after `node scripts\ccdm-host.js shutdown`, the `host` service shows `disabled`. Run `scripts\ccdm install-service host` to start it again.

### Limitations on Windows

- Signing out of Windows stops the Router, `ccdm-host` and every session. Nothing runs before you sign in.
- Root on Windows is Claude only for now. `scripts\ccdm restart-root --provider codex` is refused. Codex projects and Codex threads work.
- The usage poster never posts on Windows; it only collects.
- Guests use `"member-overwrites"`, the setup default; answer `none` at the setup prompt for no guests. See [Guests on Windows](#guests-on-windows).
- The tools in [Cutover and retirement](#cutover-and-retirement) are for older macOS installs. A Windows install starts on the Router and does not need them.

### Multiple machines

A Mac and a Windows PC can run CCDM in the same Discord server.

- **Two bots.** Each machine has its own bot, its own token, its own Router, its own `registry.json` and its own services. Never copy a token or a `registry.json` from one machine to the other.
- **Two categories.** Each machine has its own private category and its own root channel. To talk to a machine's root, write in that machine's root channel.
- **Names.** Windows project names end in `-win`, so no channel or session has the name of a Mac project.
- **Mentions.** Each machine's Router answers only in its own root channel and project channels. Mentioning the Mac's bot in a Windows channel does nothing, and the other way round, even when a bot can see the other machine's channels.
- **Resume.** A conversation is stored on the machine that ran it. `--resume` works only on that machine. You cannot continue a Mac conversation on Windows, or a Windows conversation on the Mac.
- **Each machine works alone.** One machine keeps working while the other sleeps or is off. You set up, upgrade and restart each one by itself.
- **Usage.** Both machines can use the same accounts. Only the Mac posts the usage report; Windows only collects.
- **What the Windows bot can still do in the server.** Whatever `@everyone` may do, and read the audit log.

## Global Skills

CCDM includes reusable skills (custom slash commands) that any Claude Code agent can use.

| Skill | File | Description |
|-------|------|-------------|
| `/restart-self` | `skills/restart-self.md` | Agent restarts its own session. It tells the user first, then runs the one `scripts/ccdm` command for its kind of session: `restart-session` for a project, `threads restart` for a thread, `restart-root` for root. It works for Claude and Codex sessions, on macOS and Windows |
| `/check-context` | `skills/check-context.md` | Agent reports its own context window usage. It reads the percentage from its launch record (`context.json`). A Claude session can also type `/context` into itself for the breakdown by category |

Install them for every local agent.

macOS and Linux:
```bash
mkdir -p ~/.claude/commands
cp skills/*.md ~/.claude/commands/
```

Windows (PowerShell):
```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\commands"
Copy-Item skills\*.md "$HOME\.claude\commands\"
```

A session that runs with another Claude home (`CLAUDE_CONFIG_DIR`, or a project's `claude_home`) reads its skills from that home's `commands` folder. Copy them there too.

Or send the files to an agent on Discord and ask it to save them to `~/.claude/commands/`.

## License

MIT — see [LICENSE](LICENSE)
