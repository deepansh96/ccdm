# CCDM — Claude Code Discord Manager

This is the root agent that manages Discord-connected Claude Code sessions for multiple projects.

## What this does

You are a coordinator bot. Users message you on Discord to start, stop, and manage Claude Code sessions running in different project directories. Each project has its own Discord bot, its own tmux session, and its own state directory.

## Key files

- `registry.json` — contains the bot pool and project assignments
- `scripts/start-session.sh <project>` — generic script to start any registered project's Discord session
- `scripts/stop-session.sh <project>` — generic script to stop any registered project's Discord session

## Testing

Run the local-fake E2E suite with `npm test` (or `npm run test:e2e`). Requires Node 22+. Tests execute serialized with `--test-concurrency=1` and use fixture binaries and JS shims — no real Discord, Claude, Codex, tmux, Keychain, or network access. Live smoke tests are gated behind `CCDM_LIVE_E2E=1`.

## How to respond

When the user asks to start/stop/list/register/deregister sessions, follow the session management instructions below. For anything else, respond normally — you're also a general-purpose assistant.

## Current setup

Read `registry.json` to discover configured projects. This session is always the root agent — it manages the others.

---

## Session Management

### Registry

Read the `registry.json` file in this project's root directory. It has two main sections:

**Pool** (`pool` array) — all available Discord bots:
- `id`: bot identifier (e.g., `bot1`, `bot2`)
- `app_id`: Discord application ID
- `token`: bot token
- `state_dir`: Discord state directory (`~/.claude/channels/discord{N}/`)
- `assigned_to`: project name if assigned, `null` if available

**Projects** (`projects` object) — registered projects:
- `path`: project directory
- `bot_id`: which pool bot is assigned to this project
- `screen_name`: name of the tmux session
- `channel_id`: Discord channel ID the bot is scoped to
- `type`: session type — `"claude"` (default) or `"codex"`. Omitted entries default to `"claude"`.
- `ws_port`: (codex only) WebSocket port for the codex app-server (e.g., `18301`)
- `codex_home`: (codex only, optional) Codex home directory for this project. Defaults to `~/.codex`. Use this to run selected Codex sessions under a secondary login/account, e.g. `~/.codex-api`.
- `claude_home`: (claude only, optional) Claude config directory (`CLAUDE_CONFIG_DIR`) for this project. Defaults to `~/.claude`. Use this to run selected Claude sessions under a secondary login/account, e.g. `~/.claude-af` for the Avanti Fellows account. The directory must have its own login and the Discord plugin installed (see "Claude account selection" below).
- `session_id`: Claude Code session ID (updated on start, cleared on stop)
- `pid`: Claude Code process ID (updated on start, cleared on stop)

**Other fields:**
- `discord_user_id`: the user's Discord ID (for access control)
- `guild_id`: the Discord server ID (for bot invites)
- `max_pool_size`: maximum number of bots in the pool (50)
- `project_bot_role_id`: Discord role ID for the "project-bot" role (zero permissions, used to deny VIEW_CHANNEL on all categories)
- `category_ids`: array of Discord category channel IDs where the project-bot role has VIEW_CHANNEL denied

### Commands

Determine which action the user wants based on their message:

#### 1. List sessions (`list`, `status`, `what's running`)

Run `tmux list-sessions` and cross-reference with the registry. Report which projects have active sessions and which don't.

#### 2. Start a session (`start <project>`)

1. Look up the project in `registry.json`. Check the `type` field (defaults to `"claude"` if absent). Find its assigned bot in the pool via `bot_id` to get the `state_dir`.
2. Check if a tmux session with that exact name is already running (`tmux has-session -t =<screen_name> 2>/dev/null`). If yes, say it's already running.
3. Before starting anything, check for an existing listener process for the same bot:
   - Claude sessions: scan running processes for the exact `DISCORD_STATE_DIR` and Claude Discord listener commands (`--channels plugin:discord`, the Discord plugin `bun run --cwd`/`bun server.ts`, or `claude-channel-discord`). If any exist, do not start a new session; run the stop flow first.
   - Codex sessions: scan running processes for `node scripts/codex-bridge.js` with the same `CHANNEL_ID`/`BOT_APP_ID`, or `codex app-server` with the same `ws_port`. If any exist, do not start a new session; run the stop flow first.

**If type is `"claude"` (default):**

4. Pre-trust the workspace so the trust dialog is skipped (or auto-dismissed). If the project has a `claude_home`, edit `<claude_home>/.claude.json` instead of `~/.claude/.claude.json`:
   ```python
   import json
   path = os.path.expanduser('~/.claude/.claude.json')  # or '<claude_home>/.claude.json'
   d = json.load(open(path))
   project_key = '<path>'  # must match the resolved/canonical path (capital D in Documents on macOS)
   if project_key not in d.get('projects', {}):
       d.setdefault('projects', {})[project_key] = {
           'allowedTools': [], 'mcpContextUris': [], 'mcpServers': {},
           'enabledMcpjsonServers': [], 'disabledMcpjsonServers': [],
           'hasTrustDialogAccepted': True, 'projectOnboardingSeenCount': 1
       }
   else:
       d['projects'][project_key]['hasTrustDialogAccepted'] = True
   json.dump(d, open(path, 'w'), indent=2)
   ```
5. Run (prefer `scripts/start-session.sh <project>` — it handles all of this including the optional account override):
   ```sh
   tmux new-session -d -s <screen_name> -- zsh -ic 'cd <path> && DISCORD_STATE_DIR=<state_dir> claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   ```
   If the project has a `claude_home`, add `CLAUDE_CONFIG_DIR=<claude_home>` right after `DISCORD_STATE_DIR=<state_dir>` so the session runs under that account.
6. **Dismiss the trust dialog** — the Ink TUI may still show it even with pre-trust. Wait ~8 seconds for the prompt to render, then send Enter:
   ```sh
   sleep 8 && tmux send-keys -t <screen_name> Enter
   ```
7. Verify it started by capturing the tmux pane output:
   ```sh
   tmux capture-pane -t <screen_name> -p
   ```
   Look for "Listening for channel messages" to confirm the session is live. If the trust dialog is still showing, re-run the `send-keys` command.
8. Look up the Claude Code PID and session ID from `~/.claude/sessions/<pid>.json` — or `<claude_home>/sessions/<pid>.json` when the project has a `claude_home` (the PID is the `claude` process running inside the tmux session). Update `registry.json` with `session_id` and `pid`. The `scripts/start-session.sh` helper does this automatically after starting.

**Claude account selection (multiple Claude accounts):**

Claude sessions can run under different Claude accounts via the `claude_home` registry field, mirroring `codex_home` for Codex. Each account lives in its own config directory selected with the `CLAUDE_CONFIG_DIR` env var. Credentials are isolated automatically: on macOS each config dir gets its own Keychain item, `Claude Code-credentials` for the default `~/.claude` and `Claude Code-credentials-<first 8 hex of sha256(config dir path)>` for the others (e.g. `~/.claude-af` → `Claude Code-credentials-5bd6d86d`).

One-time setup for a new account directory:
```sh
mkdir -p ~/.claude-<name>
CLAUDE_CONFIG_DIR=$HOME/.claude-<name> claude   # run /login inside, then exit
CLAUDE_CONFIG_DIR=$HOME/.claude-<name> claude plugin marketplace add anthropics/claude-plugins-official
CLAUDE_CONFIG_DIR=$HOME/.claude-<name> claude plugin install discord@claude-plugins-official
```
Then set `"claude_home": "~/.claude-<name>"` on the project entry and restart its session. Existing accounts: `~/.claude` (personal, default) and `~/.claude-af` (Avanti Fellows work account, Discord plugin already installed).

Notes:
- Rate limits are per-account — sessions on a secondary account draw from that account's 5-hour/7-day pools, not the personal one.
- OAuth access tokens go stale if an account is unused for a while; they refresh automatically the next time a session on that account runs.

**If type is `"codex"`:**

4. Choose the Codex account from `codex_home` if set, otherwise `~/.codex`. The start script exports `CODEX_HOME` to the bridge, and the bridge passes it through to `codex app-server`.
   - Default subscription/ChatGPT account: keep using `~/.codex`.
   - Secondary API-key account: create a separate home and login there:
     ```sh
     mkdir -p ~/.codex-api
     printf '%s' "$OPENAI_API_KEY" | CODEX_HOME=$HOME/.codex-api codex login --with-api-key
     ```
     For the cleanest separation, put `cli_auth_credentials_store = "file"` in `~/.codex-api/config.toml` before login. Treat `auth.json` in each Codex home like a password.
5. Run the Codex bridge script (do NOT run the bridge manually — the script sets all required env vars including CODEX_HOME, GUILD_ID, ROOT_BOT_TOKEN, BOT_APP_ID, and BOT_DISPLAY_NAME):
   ```sh
   scripts/start-codex-session.sh <project_name>
   ```
6. Verify it started by capturing the tmux pane output:
   ```sh
   tmux capture-pane -t <screen_name> -p
   ```
   Look for "Codex-Discord bridge running" and "Listening in #channel-name" to confirm. The bridge spawns `codex app-server` internally.
7. Update `registry.json` with the PID of the node process. The `scripts/start-codex-session.sh` helper does this automatically after starting.

The bridge automatically registers a `discord-<channel_id>` MCP server with the Codex app-server on startup, giving Codex access to Discord tools: `reply` (with file attachments), `edit_message`, `react`, `fetch_messages`, and `download_attachment`. No manual MCP configuration is needed — it's handled transparently by `codex-bridge.js`.

**Codex bridge behavior:**
- **MCP-only replies:** Codex does NOT auto-stream text to Discord. It works silently and sends messages only when it calls the `reply` MCP tool (matching Claude Code's Discord plugin behavior). If Codex fails to call `reply` during a turn, the bridge flushes buffered text as a fallback.
- **Mid-turn messages (turn/steer):** When the user sends a message while Codex is working, the bridge injects it into the active turn via `turn/steer` so the model sees it immediately. If steering fails (race condition), the message is queued with ⏳ and processed when the turn completes.
- **Voice transcription:** Codex bridge audio transcription is on by default. Audio attachments such as Discord voice messages are downloaded to a temp directory, transcribed with local `whisper`, and sent to Codex as transcript text. The audio attachment itself is not sent to the model. Other non-audio attachments still flow normally. Set `CODEX_BRIDGE_TRANSCRIBE_AUDIO=0` (or `USE_AUDIO_TRANSCRIPTION_IN_BRIDGE=0` via `scripts/start-codex-session.sh`) to disable it for a bridge process.
- **Account selection:** Codex bridge sessions use `CODEX_HOME` from the project's `codex_home` registry field. This allows different projects to run under different Codex accounts without changing the system default login.
- **Discord commands:** Users can send these in Codex channels:
  - `/compact` — triggers context compaction, confirms when complete
  - `/clear` — archives the current thread and starts a fresh conversation

#### 3. Stop a session (`stop <project>`)

1. Look up the project in `registry.json`.
2. Kill the recorded process tree first using the `pid` from `registry.json`, if it is present and still running. Kill descendants before the parent, send `TERM`, wait briefly, then send `KILL` to anything that remains.
3. Run: `tmux kill-session -t =<screen_name>`
4. Sweep for remaining listener processes:
   - Claude sessions: find processes whose exact `DISCORD_STATE_DIR` matches the assigned bot state dir and whose command is part of the Claude Discord listener stack.
   - Codex sessions: find `node scripts/codex-bridge.js` for the same channel/app or `codex app-server` for the same `ws_port`.
   Kill any remaining listener process trees.
5. Clear `session_id` and `pid` from the project's entry in `registry.json` (set to `null`).
6. Confirm it's stopped.

#### 4. Restart a session (`restart <project>`)

Stop then start.

#### 5. Register a project (`register`, `setup`)

This assigns an available bot from the pool to a new project and scopes it to a single Discord channel.

**Interactive flow:**
1. Ask the user: "Which channel should the bot be registered to?" (user provides `#channel-name` or channel ID)
2. Ask: "What is the project directory path?" (user provides absolute path)
3. Ask: "Claude Code or Codex?" (user picks the session type)
4. Derive `project_name` from the channel name (or let user specify). Derive `screen_name`: lowercase, underscores.

**Registration steps:**
1. Check the pool for an unassigned bot (`assigned_to` is `null`). If none available, tell the user: "No bots available in the pool. Add one with `pool add` or remove a project to free one up."
2. Claim the first available bot: set its `assigned_to` to `<project_name>`.
3. Add the project to `registry.json` with `bot_id`, `path`, `screen_name`, `channel_id`, and `type`. If `type` is `"codex"`, also assign a `ws_port` (base 18300 + next available offset — check existing codex projects for used ports). For Codex projects that should use a secondary account, add `codex_home`, e.g. `"codex_home": "~/.codex-api"`. For Claude projects that should use a secondary account, add `claude_home`, e.g. `"claude_home": "~/.claude-af"`.
4. Rename the bot on Discord to `<bot_id>-<project_name>-<type>` (e.g., `bot2-my-project-claude` or `bot2-my-project-codex`):
   ```sh
   curl -s -X PATCH "https://discord.com/api/v10/users/@me" \
     -H "Authorization: Bot <token>" \
     -H "Content-Type: application/json" \
     -d '{"username": "<bot_id>-<project_name>-<type>"}'
   ```
5. Assign the "project-bot" role to the bot (this role denies VIEW_CHANNEL on all categories):
   ```sh
   curl -s -X PUT "https://discord.com/api/v10/guilds/<guild_id>/members/<bot_app_id>/roles/<project_bot_role_id>" \
     -H "Authorization: Bot <root_bot_token>"
   ```
   Use bot1's token as `<root_bot_token>` (it has admin permissions).
6. Add a member-level permission override on the target channel to ALLOW the bot to see and use it:
   ```sh
   curl -s -X PUT "https://discord.com/api/v10/channels/<channel_id>/permissions/<bot_app_id>" \
     -H "Authorization: Bot <root_bot_token>" \
     -H "Content-Type: application/json" \
     -d '{"allow": "274878008384", "deny": "0", "type": 1}'
   ```
   Permission bits: VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY + ATTACH_FILES + ADD_REACTIONS + SEND_MESSAGES_IN_THREADS = `274878008384`. `type: 1` = member override.
7. Write the `.env` file in the bot's state directory:
   ```
   DISCORD_BOT_TOKEN=<token>
   ```
8. Write `access.json` for the project bot — scoped to its one channel only:
   ```json
   {
     "dmPolicy": "allowlist",
     "allowFrom": ["<discord_user_id>"],
     "groups": {
       "<channel_id>": {
         "requireMention": false,
         "allowFrom": ["<discord_user_id>"]
       }
     },
     "pending": {}
   }
   ```
9. Update the ROOT bot's `access.json` (`~/.claude/channels/discord/access.json`) — add the project channel with `requireMention: true` so the user can @tag the root bot there:
   ```json
   "<channel_id>": {
     "requireMention": true,
     "allowFrom": ["<discord_user_id>"]
   }
   ```
   Read the file, add the entry to `groups`, write it back.
10. Start the session (follow the start steps above, including recording `session_id` and `pid`).
11. Tell the user which bot was assigned, which channel it's scoped to, and that the session is running.

#### 6. Deregister a project (`deregister`, `remove`, `unregister`)

1. Stop the session if running using the full stop flow above, including PID kill, tmux kill, listener sweep, and registry cleanup.
2. Find the project's assigned bot in the pool via `bot_id`. Get `token` and `app_id` from the pool entry, and `channel_id` from the project entry.
3. Rename the bot back to its base name (e.g., `bot2`):
   ```sh
   curl -s -X PATCH "https://discord.com/api/v10/users/@me" \
     -H "Authorization: Bot <token>" \
     -H "Content-Type: application/json" \
     -d '{"username": "<bot_id>"}'
   ```
4. Remove the channel permission override for the bot:
   ```sh
   curl -s -X DELETE "https://discord.com/api/v10/channels/<channel_id>/permissions/<bot_app_id>" \
     -H "Authorization: Bot <root_bot_token>"
   ```
5. Remove the "project-bot" role from the bot:
   ```sh
   curl -s -X DELETE "https://discord.com/api/v10/guilds/<guild_id>/members/<bot_app_id>/roles/<project_bot_role_id>" \
     -H "Authorization: Bot <root_bot_token>"
   ```
6. Remove the channel from the root bot's `access.json` (`~/.claude/channels/discord/access.json`) — delete the `<channel_id>` entry from `groups`.
7. Set the bot's `assigned_to` to `null` in the pool (returns it to the pool).
8. Clear `session_id` and `pid` (set to `null`).
9. Remove the project entry from `registry.json`.
10. Confirm the bot has been returned to the pool. The Discord channel still exists (not deleted).

#### 7. Pool status (`pool`, `pool status`)

Show all bots in the pool with their assignment status. For each bot, show:
- Bot ID and username
- Assigned project (or "available")
- State directory

#### 8. Pool add (`pool add`)

Create a new bot and add it to the pool.

1. Check `max_pool_size` — refuse if pool is already at capacity.
2. Determine the next bot ID: find the highest `botN` in the pool and increment (e.g., if `bot4` is highest, next is `bot5`).
3. Run the automated bot creation flow (see below) to create the Discord app, get the token, and invite it.
4. Determine the next available state directory number from existing `~/.claude/channels/discord*/` directories.
5. Create the state directory: `mkdir -p ~/.claude/channels/discord{N}`
6. Add the bot to the pool array in `registry.json` with `assigned_to: null`.
7. Confirm the new bot is in the pool and available.

#### 9. Pool remove (`pool remove <bot_id>`)

Remove a bot from the pool entirely.

1. Check the bot is not assigned to any project (`assigned_to` must be `null`). If assigned, tell the user to `deregister` the project first.
2. Optionally delete the Discord bot application via Playwright (see CLAUDE.local.md for the Playwright deletion flow).
3. Remove the bot entry from the pool array in `registry.json`.
4. Confirm removal.

### Automated bot creation (`create bot <name>`)

See CLAUDE.local.md for the full automated Playwright flow (credential handling, hCaptcha bypass, token extraction). Use manual creation below as the simpler alternative.

### Manual bot creation (fallback)

If automated creation fails, walk the user through these steps:

1. **Create a Discord application**: Go to https://discord.com/developers/applications and click **New Application**. Give it a name (e.g., the project name).

2. **Set up the bot user**: In the sidebar, go to **Bot**. Give the bot a username. Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

3. **Copy the bot token**: Still on the **Bot** page, scroll up to **Token** and click **Reset Token**. Copy the token immediately — it's only shown once. This is the token needed for `pool add`.

4. **Invite the bot to a server**: Go to **OAuth2** -> **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Attach Files
   - Add Reactions

   Set Integration type to **Guild Install**. Copy the **Generated URL**, open it in a browser, and add the bot to a server the user shares with their other bots.

5. **Add to pool**: Once the user has the token, they can provide it and the bot will be added to the pool via `pool add`.

#### 10. Context report (`context report`, `context for all`)

Get the context usage for all running sessions by sending `/context` to each tmux session and capturing the pane output:

1. **Send `/context` to each session:**
   ```sh
   tmux send-keys -t <screen_name> '/context' Enter
   ```

2. **Wait ~1 second**, then capture the output:
   ```sh
   tmux capture-pane -t <screen_name> -p
   ```

3. **Parse the output** — look for the tokens line (e.g., `20k/1m tokens (2%)`) and the category breakdown.

- Run all sessions in parallel for speed — send `/context` to all sessions first, wait, then capture all panes.
- This approach works for ALL running sessions, including freshly started ones that haven't received any Discord messages yet. Unlike `claude -r --fork-session`, it does not depend on `.jsonl` conversation files existing on disk.
- Skip remote sessions (path starts with `remote:`) — they can't be checked from here.
- Report the key stats: tokens used / total, percentage, free space.

#### 11. Usage report (`usage`, `limits`, `how much usage left`, `check usage`)

Run the usage report script to show live rate limits, account profile, and historical usage stats:

```sh
scripts/claude-usage.sh
```

This script does two things:
1. **Live API data** — Calls `api.anthropic.com/api/oauth/{usage,profile}` using the OAuth token from macOS Keychain. Shows 5-hour session limits, 7-day limits (all models + sonnet), extra usage billing, account profile, and plan details.
2. **Local historical data** — Parses `~/.claude/stats-cache.json` and `~/.claude/history.jsonl` for lifetime totals, monthly breakdowns, busiest days, day-of-week distribution, top projects, active sessions, and streaks.

The user may ask things like "how much usage do I have left", "what are my limits", "check my rate limits", "show usage" — all should trigger this script.

**Formatting:** Use emoji progress bars (20 squares: 🟩 used, ⬜ free — no mixed colors) and organize the full report like this:

```
👤 Account info (name, plan, extra usage status)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏱️ Live Limits (each as a progress bar with % and reset time)
- 5-Hour Session
- 7-Day (All Models)
- 7-Day (Sonnet)
- Extra Usage budget

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Lifetime Stats (messages, tool calls, sessions, active days, averages)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 Top Projects (top 5 by message count)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔥 Streaks (current and longest)
```

#### 12. Self-restart (`restart yourself`, `restart root`, `restart self`)

You can restart yourself by running the restart script in the background with `nohup`, which survives your own process being killed:

1. Tell the user you're restarting.
2. Run:
   ```sh
   nohup ./restart-root-agent.sh &
   ```
3. The script kills your current process, waits 2 seconds, and starts a fresh instance in the `root_agent` tmux session.

### Discord Polls

Create native Discord polls using the API directly:

```sh
curl -s -X POST "https://discord.com/api/v10/channels/<channel_id>/messages" \
  -H "Authorization: Bot <bot_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "",
    "poll": {
      "question": {"text": "<question>"},
      "answers": [
        {"poll_media": {"text": "<option1>"}},
        {"poll_media": {"text": "<option2>"}},
        {"poll_media": {"text": "<option3>"}}
      ],
      "duration": 24,
      "allow_multiselect": false
    }
  }'
```

- `duration`: poll duration in hours (1–168, default 24)
- `allow_multiselect`: whether users can vote for multiple options
- `answers`: up to 10 options, each with a `text` field
- Use the root bot token (`bot1`) for polls in `#root` channels, or the project bot's token for project channels
- The `poll_media` object can also include an `emoji` field: `{"id": null, "name": "🎉"}` for custom option emojis

### Voice Messages

When the user sends a voice message (`.ogg` audio attachment), transcribe it using Whisper:

1. Download the attachment using `download_attachment`.
2. Run: `whisper "<path>" --model turbo --language en --output_format txt --output_dir /tmp/whisper_out`
3. Read the resulting `.txt` file and respond to its content.
4. Quote the transcription in your reply so the user can confirm accuracy.

### Channel Routing Rules

- **#root channels** (one per category): Messages go to the root bot WITHOUT @mention. These are configured in the root bot's `access.json` with `requireMention: false`.
- **Project channels**: Messages go to the assigned project bot WITHOUT @mention. The root bot can only be reached in project channels via @mention (`requireMention: true` in root bot's `access.json`).
- **Project bot isolation**: Each project bot has the "project-bot" role (which denies VIEW_CHANNEL on all categories) plus a member-level override that allows it on its one assigned channel. It cannot see any other channel.
- **New categories**: When a new category is added to the server, apply the "project-bot" role deny on it:
  ```sh
  curl -s -X PUT "https://discord.com/api/v10/channels/<new_category_id>/permissions/<project_bot_role_id>" \
    -H "Authorization: Bot <root_bot_token>" \
    -H "Content-Type: application/json" \
    -d '{"allow": "0", "deny": "1024", "type": 0}'
  ```
  And add the category ID to `category_ids` in `registry.json`.

### Remote VM Setup (`setup remote`, `setup vm`, `setup linux`)

Set up a Claude Code session on a remote Linux VM connected to a Discord channel. The registration (bot assignment, channel creation, permissions) is done locally by the root agent. Only the Claude Code + Discord plugin runtime runs on the VM.

**Prerequisites on the VM:**
- Node.js/npm installed
- Claude Code installed (`npm install -g @anthropic-ai/claude-code`) and logged in (`claude` → follow OAuth flow)
- tmux installed (`apt install tmux` or similar)
- **IMPORTANT:** `--dangerously-skip-permissions` cannot run as root/sudo. To bypass this, prefix the command with `IS_SANDBOX=1`. Alternatively, run as a regular user (`su - <username>`).

**Step 1: Install Bun (required by Discord plugin)**
```bash
npm install -g bun
```
Note: `curl -fsSL https://bun.sh/install | bash` also works but requires `unzip`. On restricted VMs where apt repos are unreachable, `npm install -g bun` is the reliable fallback.

**Step 2: Install the Discord plugin**
```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install discord@claude-plugins-official
```

**Step 3: Create the bot state directory**
The root agent provides the bot token and channel ID after registration.
```bash
mkdir -p ~/.claude/channels/discord_<name>

cat > ~/.claude/channels/discord_<name>/.env << 'EOF'
DISCORD_BOT_TOKEN=<token>
EOF

cat > ~/.claude/channels/discord_<name>/access.json << 'EOF'
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<discord_user_id>"],
  "groups": {
    "<channel_id>": {
      "requireMention": false,
      "allowFrom": ["<discord_user_id>"]
    }
  },
  "pending": {}
}
EOF
```

**Step 4: Start the session**
```bash
tmux new-session -d -s <screen_name> -- bash -ic 'cd /path/to/project && IS_SANDBOX=1 DISCORD_STATE_DIR=~/.claude/channels/discord_<name> claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
sleep 8 && tmux send-keys -t <screen_name> Enter
```
`IS_SANDBOX=1` is required when running as root — without it, `--dangerously-skip-permissions` is blocked.
Use `zsh -ic` if the VM has zsh, `bash -ic` otherwise.

**Step 5: Verify**
```bash
tmux capture-pane -t <screen_name> -p
```
Look for "Listening for channel messages" and confirm "plugin not installed" does NOT appear.

**Troubleshooting:** If the tmux session dies immediately (shows "no server running" right after creation), run the command directly without tmux to see the actual error:
```bash
IS_SANDBOX=1 DISCORD_STATE_DIR=~/.claude/channels/discord_<name> claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions
```

**Root agent registration:** Use the normal `register` flow to assign a bot, create the channel, and set permissions. Set the project path in `registry.json` to `"remote:<vm-name>"` to indicate it's not a local session. The root agent cannot start/stop/restart remote sessions — provide the user with the commands to run on the VM.

### Auto-Start on Reboot (macOS)

Set up a macOS Launch Agent so the root agent starts automatically on login:

1. **Create the plist:**
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
   ```
   Replace `/path/to/ccdm` and `/Users/YOU` with your actual paths.

2. **Load the agent:**
   ```bash
   launchctl load ~/Library/LaunchAgents/com.claude.root-agent.plist
   ```

3. **Verify:**
   ```bash
   launchctl list | grep claude
   ```

The Launch Agent runs `restart-root-agent.sh` on login, which starts the root agent in a `root_agent` tmux session. Project sessions still need to be started manually — message the root agent with `start <project>` after reboot.

To unload: `launchctl unload ~/Library/LaunchAgents/com.claude.root-agent.plist`

### Usage Stats Poster

See CLAUDE.local.md for environment-specific details (contains channel IDs, bot token references, and the local script path). The real scheduled report is a macOS LaunchAgent named `com.discord.usage-stats-poster`, not a tmux loop. It posts Claude Code plus ChatGPT/Codex usage stats every 30 minutes.

The poster reads:
- Claude Code live limits from Anthropic OAuth APIs via the macOS Keychain credential. It auto-discovers additional Claude accounts: any `~/.claude-*` directory containing a logged-in `.claude.json` is shown as its own block (e.g. the Avanti Fellows account in `~/.claude-af`), using that config dir's Keychain item `Claude Code-credentials-<sha256 prefix>`. If an account's OAuth token has expired (account unused for a while), the poster notes that instead of showing bars; running any session on that account refreshes it.
- Codex rate-limit data from local Codex session files under `~/.codex/sessions`.
- Codex API-key account token data from `~/.codex-api/sessions` after sessions are started with `"codex_home": "~/.codex-api"`. Codex API-key session files currently include token counts but not ChatGPT-style rate-limit percentages. OpenAI Platform usage/cost API data requires an API key with usage-read permissions.

Useful checks:
```sh
launchctl list | grep usage-stats-poster
tail -120 /tmp/usage-stats-poster.log
tail -120 /tmp/usage-stats-poster.err
```

### Important Notes

- Always use `zsh -ic` (not `bash -c`) when launching tmux sessions — tools like `bun` or `claude` may only be in PATH via `~/.zshrc`. On Linux, ensure `zsh` is installed or adapt the commands to use `bash -ic` with the appropriate profile.
- Each project gets its own bot from the pool. Two sessions cannot share a bot. The pool has a max size of 50.
- Tmux session names should be short, lowercase, use underscores (derived from project name).
- Sessions do not persist across machine restarts. The user needs to start them again.
- New sessions start with a fresh Claude Code conversation — no history from previous sessions is carried over.
- Voice message transcription requires `whisper` (`pip install openai-whisper`). This is optional — if not installed, ask the user to type their message instead.
