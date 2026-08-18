# CCDM — Claude Code Discord Manager

Manage multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances from Discord. A **pool of Discord bots** is managed centrally — assign one to a project when needed, return it when done.

```
Discord Server
  │
  ├── #root              ← Root Agent listens here (no @mention needed)
  │
  ├── #my-app            ← bot2-my-app ONLY sees this channel
  │     Claude Code running in ~/my-app/
  │
  ├── #website           ← bot3-website ONLY sees this channel
  │     Claude Code running in ~/website/
  │
  └── bot4, bot5, ...    (available in pool, not assigned)
```

## How It Works

The root agent is a Claude Code instance connected to Discord. It manages a **pool of Discord bots** (default limit: 50, configurable in `registry.json`). When you message it in `#root`, it can:

- **Register bots** to specific Discord channels (each bot is isolated to only see its assigned channel)
- **Deregister bots** and return them to the pool (channel stays, bot goes back)
- **Start/stop/restart** Claude Code sessions for assigned projects
- **Report context usage** across all running sessions
- **Show rate limits and usage stats** with visual progress bars
- **Restart itself** without manual intervention
- **Show live context usage** in bot Discord nicknames (e.g. `bot4-my-app · 42%`)
- **Transcribe voice messages** using Whisper

Each project gets its own Discord channel and bot. The bot is **locked to that one channel** via Discord permission overrides — it can't see anything else. You chat with each project in its own channel, no `@mention` needed. The root agent listens in `#root` without `@mention`, and can be `@mentioned` in project channels for management tasks.

CCDM is built on the [official Anthropic Discord plugin for Claude Code](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/README.md). Refer to that README for details on the plugin itself, including how the MCP server works, pairing flow, and access control.

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Yes | See docs |
| `tmux` | Yes | `brew install tmux` / `apt install tmux` |
| `zsh` | Yes | Default on macOS / `apt install zsh` on Linux |
| `python3` | Yes | `brew install python3` / `apt install python3` |
| `jq` | Yes | `brew install jq` / `apt install jq` |
| `whisper` | Optional | `pip install openai-whisper` (for voice messages) |

For Codex bridge sessions, voice-message transcription is on by default. The
bridge transcribes `audio/*` attachments with local `whisper` and sends Codex
the transcript instead of the audio file. Set `CODEX_BRIDGE_TRANSCRIBE_AUDIO=0`
to disable it for a bridge process.

The Codex bridge also forwards 👍 and 👎 reactions from allowed users on its
own messages as short feedback turns containing the reacted message ID and
an excerpt when available.

### Codex Accounts

CCDM names each Codex Account with a stable **Codex Account Alias**. The alias
is the account identity; its mapped **Codex Home** is the directory containing
that account's configuration, credentials, cache, and sessions. Configure
aliases in the top level of `registry.json`:

```json
"codex_accounts": {
  "primary": "~/.codex-primary",
  "secondary": "~/.codex-secondary"
},
"default_codex_account": "primary"
```

The Default Codex Account is inherited by new Codex projects and by the root
bridge unless a higher-priority selector is present. A project can opt into a
non-default account with `codex_account`:

```json
{
  "type": "codex",
  "ws_port": 18342,
  "codex_account": "secondary"
}
```

The `codex_account` field is persisted on a project only when it selects a
non-default account. Projects selecting the default, including new Codex
projects, silently inherit `default_codex_account` and do not need a
project-level selector.

#### Login preparation

Prepare every new Codex Home before starting a session. For a subscription
account, create the directory, use file-backed credentials, and run the normal
subscription `codex login`:

```bash
mkdir -p ~/.codex-secondary
printf '%s\n' 'cli_auth_credentials_store = "file"' > ~/.codex-secondary/config.toml
CODEX_HOME=$HOME/.codex-secondary codex login
CODEX_HOME=$HOME/.codex-secondary codex login status
```

Do not use `--with-api-key` for a subscription account. Keep each `auth.json`
and other credential contents private; never put them in the registry, README,
or logs.

#### Precedence and legacy compatibility

The **Legacy Codex Home Override** is a raw `codex_home` path retained for
registries that predate named accounts. A named selector and a raw-home
selector at the same configuration scope are a hard error. Unknown aliases,
empty selectors, and unusable selected homes also fail with an actionable
error before stale MCP cleanup, tmux creation, PID mutation, or root-session
teardown. CCDM uses `~/.codex` only when no configured selector applies.

**Project precedence** (highest priority first):

1. Project `codex_account` or project `codex_home`.
2. Top-level `default_codex_account` or top-level Legacy Codex Home Override.
3. `~/.codex`.

**Root precedence** (highest priority first):

1. `ROOT_CODEX_HOME`, the emergency direct-path override.
2. Top-level `default_codex_account` or top-level Legacy Codex Home Override.
3. Ambient `CODEX_HOME`.
4. `~/.codex`.

There is no `ROOT_CODEX_ACCOUNT`; use `ROOT_CODEX_HOME` when the registry
needs to be bypassed during recovery. The bridge receives only the resolved
absolute `CODEX_HOME`, never an alias.

#### Manual migration checklist

Migration is documented and operator-executed; `setup.sh` does not migrate an
existing ignored `registry.json`:

1. **Create and authenticate the new home.** Prepare the file-backed
   subscription Codex Home and complete `codex login`.
2. **Migrate the ignored `registry.json`.** Replace the top-level
   `codex_home` with `codex_accounts` and `default_codex_account`; add
   project `codex_account` only for projects that need a non-default account.
3. **Restart every affected long-lived Codex project session and the root
   Codex bridge.** Stop the old processes first, then start them again so each
   process reads the current account selection.
4. Verify each session's resolved account without recording credentials or
   `auth.json` contents.

**Rollback:** restore the previous top-level Legacy Codex Home Override (and
remove named project selectors that are no longer needed), then restart every
affected project and the root Codex bridge again. Keep the older external Usage
Stats Poster directory and LaunchAgent until the tracked replacement has been
verified; removing that rollback copy is a separate operation.

After upgrading the Codex CLI, stop all long-lived CCDM Codex sessions before
starting any of them again, then restart the root Codex bridge. Updating the
binary does not replace already-running app-server processes, so a partial
restart can mix runtime versions inside the shared CCDM home.

Codex projects can also pin runtime settings per session:

```json
{
  "codex_model": "gpt-5.6-sol",
  "codex_reasoning_effort": "high"
}
```

These registry values are passed through to `codex app-server` as config
overrides when `scripts/start-codex-session.sh` launches the bridge. Fast mode
is off unless `codex_service_tier` is set to a tier such as `"priority"`;
Sol/Terra/Luna are model slugs.

You also need:
- A Discord account
- A Discord server where you can add bots
- At least one Discord bot (for the root agent) — see [Adding bots to the pool](#adding-bots-to-the-pool)

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/<owner>/ccdm.git
cd ccdm

# 2. Run the setup script
./setup.sh

# 3. Start the root agent
tmux new-session -d -s root_agent -- zsh -ic 'cd /path/to/ccdm && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
```

The setup script will:
1. Check that all prerequisites are installed
2. Ask for your Discord user ID and server ID
3. Create `registry.json` with all required fields
4. Ask for your root agent's bot token
5. Set up the state directory with credentials and access control

Then message your bot on Discord to start managing projects!

## Manual Setup

If you prefer to set things up by hand:

1. **Copy the registry template:**
   ```bash
   cp registry.example.json registry.json
   ```

2. **Edit `registry.json`** — fill in your Discord user ID and server ID:
   ```json
   {
     "discord_user_id": "123456789012345678",
     "guild_id": "YOUR_DISCORD_SERVER_ID",
     "max_pool_size": 50,
     "codex_accounts": {},
     "default_codex_account": null,
     "project_bot_role_id": null,
     "category_ids": [],
     "pool": [],
     "projects": {}
   }
   ```
   To find your Discord user ID: Settings > Advanced > enable Developer Mode, then right-click your name > Copy User ID. For the server ID, right-click the server name > Copy Server ID.

3. **Create the state directory:**
   ```bash
   mkdir -p ~/.claude/channels/discord
   ```

4. **Add your bot token:**
   ```bash
   echo "DISCORD_BOT_TOKEN=your_token_here" > ~/.claude/channels/discord/.env
   ```

5. **Set up access control:**
   ```bash
   cat > ~/.claude/channels/discord/access.json << 'EOF'
   {
     "dmPolicy": "allowlist",
     "allowFrom": ["YOUR_DISCORD_USER_ID"],
     "groups": {
       "YOUR_ROOT_CHANNEL_ID": {
         "requireMention": false,
         "allowFrom": ["YOUR_DISCORD_USER_ID"]
       }
     },
     "pending": {}
   }
   EOF
   ```

6. **Start the root agent:**
   ```bash
   tmux new-session -d -s root_agent -- zsh -ic 'cd /path/to/ccdm && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   ```

   To run the root bot through Codex instead:
   ```bash
   ./restart-root-codex-agent.sh [channel_id]
   ```
   The selected channel must already be in the root `access.json` `groups` map. The script checks this before stopping the current root agent. It keeps `restart-root-agent.sh` as the Claude rollback path.

## Commands

Message the root agent bot on Discord with any of these:

| Command | Description |
|---------|-------------|
| `list` / `status` | Show all registered projects and their status |
| `start <project>` | Start a project's Claude Code Discord session |
| `stop <project>` | Stop a project's session |
| `restart <project>` | Restart a project's session |
| `register` / `setup` | Register a bot to a channel (interactive — asks for channel and path) |
| `deregister` / `remove` / `unregister` | Deregister a project and return its bot to the pool |
| `pool` / `pool status` | Show all bots and their assignment status |
| `pool add` | Create a new bot and add it to the pool |
| `pool remove <bot_id>` | Remove an unassigned bot from the pool |
| `guest invite <project> <user_id>` | Create a project-scoped guest invite |
| `guest revoke <project> <user_id>` | Remove project guest access |
| `context report` | Get context window usage for all running sessions (via tmux) |
| `usage` / `limits` | Show rate limits, usage stats, and account info |
| `restart yourself` | Self-restart the root agent |
| `create a poll` | Create a native Discord poll in any channel |
| `/compact` / `/clear` / `/restart` | From a Codex project channel, manage that Codex session directly |
| `/pause` / `/unpause` | Queue new Codex messages without interrupting the active turn, then resume them in order |
| `@root /compact` / `@root /clear` | From a Claude project channel, relay the slash command into that project's tmux session |

### Registering a New Project

Once the root agent is running and you have bots in the pool, message it in `#root`:

```
register
```

The root agent will ask you:
1. **Which channel?** — provide a channel name or ID (it can also create one)
2. **Project path?** — the local directory for the project

Then it automatically:
1. Claims an available bot from the pool
2. Renames it to `botN-project_name`
3. **Isolates the bot** to only see the assigned channel (via Discord permission overrides)
4. Configures the bot's state directory and access control
5. Updates the root bot's config so you can `@mention` it in the project channel
6. Starts the Claude Code session

No need to provide a token — bots are managed in the pool. If the pool is empty, add more bots with `pool add`.

### Channel Isolation

Each project bot is locked to a single Discord channel using:
- A **"project-bot" role** with zero permissions and VIEW_CHANNEL denied on all categories
- A **member-level override** that allows the bot on its one assigned channel

This means:
- Project bots **cannot see** any other channel, `#root`, or other project channels
- The root bot **can see everything** and responds in `#root` without `@mention`
- You can `@mention` the root bot in any project channel for management tasks

### Project Guests

To invite someone into one project channel only, run:

```sh
scripts/guest-access.js invite <project-or-channel-id> <discord-user-id>
```

This creates a one-use invite and a per-project `ccdm-guest-<project>` role. The role is denied on CCDM-managed categories and other project channels, then allowed on the target channel with text, message history, attachments, reactions, and thread replies. The guest user ID is also added to the project bot allowlist so Claude/Codex can read their messages.

For users already in the server, use `grant` instead of `invite`. Use `revoke` to remove their project guest role and bot access.

## Managing the Bot Pool

CCDM uses a **bot pool** — a set of pre-created Discord bots that get assigned to projects on demand. The default pool limit is 50 bots (configurable via `max_pool_size` in `registry.json`).

### Adding bots to the pool

The easiest way is to message the root agent: `pool add`. This uses browser automation to create a bot, get its token, and invite it to your server automatically. Note: the automation relies on bypassing Discord's hCaptcha, which is flaky — it may pass through sometimes and fail others. If it fails, fall back to manual creation below.

Alternatively, create bots manually:

1. **Create an application**: Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.

2. **Set up the bot**: In the sidebar, go to **Bot**. Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this, the bot receives messages with empty content.

3. **Copy the token**: On the **Bot** page, click **Reset Token** and copy it immediately — it's only shown once.

4. **Generate an invite link**: Go to **OAuth2** > **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Attach Files
   - Add Reactions

   Set Integration type to **Guild Install**. Copy the generated URL.

5. **Invite the bot**: Open the URL in a browser and add the bot to your Discord server.

6. **Add to pool**: Provide the token to the root agent and it will add the bot to the pool.

### How assignment works

- `register` → interactive flow: picks a bot, locks it to a channel, starts the session
- `deregister <project>` → stops the session, removes channel lock, renames the bot back, returns it to the pool
- Bots are interchangeable — any available bot can be assigned to any project
- The Discord channel is **not deleted** on deregister — only the bot assignment is removed

## Usage Report

CCDM includes a usage reporting script (`scripts/claude-usage.sh`) that shows:

- **Live data** (macOS only): Account profile, 5-hour session limits, 7-day limits, extra usage billing
- **Local data** (all platforms): Lifetime stats, monthly breakdowns, top projects, busiest days, streaks

The live data section uses the macOS Keychain to retrieve your Claude Code OAuth token. On Linux, this section gracefully skips and local stats still work.

Ask the root agent for a usage report by messaging `usage`, `limits`, or `how much usage left`.

## Scheduled Usage Stats Poster

A separate, opt-in macOS LaunchAgent can post usage stats to Discord on a schedule. It is not installed by `setup.sh` and it is not the old tmux-based `usage-report-loop.sh` flow.

The tracked installer requires Python 3 with Pillow (the renderer dependency), then renders and validates `~/Library/LaunchAgents/com.discord.usage-stats-poster.plist` with absolute paths to Python, Codex, the poster, and its logs. If Pillow is missing it prints a `python3 -m pip install Pillow` remediation and exits before touching LaunchAgents or the existing plist. The LaunchAgent is interval-only and runs every 600 seconds, so installation does not trigger an immediate post. Every automated run records a local structured snapshot in UTC 10-minute slots; the trend-first PNG is uploaded only once per UTC 30-minute slot. Manual JSON-embed invocations remain independent of the history database. Reinstalling unloads the existing label before loading the new plist, so changing the interval is idempotent; if the new load fails, the prior plist and loaded/unloaded schedule are restored:

```bash
scripts/install-usage-stats-poster.sh                 # 600 seconds (10 minutes)
scripts/install-usage-stats-poster.sh --interval 900  # 15 minutes
```

The rendered LaunchAgent contains no token, channel ID, or poster configuration. The installer never sends a Discord request; it only schedules the poster.

History is stored at `~/Library/Application Support/CCDM/usage-stats/history.sqlite3` by default (override with the ignored config's `history_db_path`). The database and lock are private (`0700` directory, `0600` files), snapshots are retained for 365 days, and an advisory lock makes repeated LaunchAgent runs idempotent. Only feature-owned SQLite files count toward the 5 GiB warning; Codex session logs and Claude transcripts are never counted or deleted. A warning is emitted at most once every 24 hours while the feature-owned history directory remains over the limit.

```bash
~/Library/LaunchAgents/com.discord.usage-stats-poster.plist
```

The poster reports:
- Claude Code limits from Anthropic OAuth APIs via the macOS Keychain credentials
- ChatGPT/Codex limits for every alias in the top-level `codex_accounts`
  registry map, with `default_codex_account` shown first and the remaining
  aliases shown alphabetically
- Local token-usage fallback from each named Codex Home's `sessions` directory
  when live rate limits are unavailable

The poster reads the same named-account registry configuration shown in
[Codex Accounts](#codex-accounts); it does not need a separate list of Codex
Homes. Aliases that resolve to the same Codex Home are reported only once.
Older registries without `codex_accounts` remain supported: top-level and
project-level raw `codex_home` paths are discovered as **Legacy Codex Home**
entries. Direct `~/.codex` and `~/.codex-api` session paths are legacy
compatibility examples, not the recommended configuration.

Claude OAuth accounts are discovered from the default `~/.claude` login and
valid extra `~/.claude-*` config directories. Each extra directory must have a
`.claude.json` with an OAuth organization name or email address; that label is
used in the report. Its Keychain service is derived from the first eight hex
characters of the SHA-256 hash of the config-directory path, while the default
login uses `Claude Code-credentials`. No account names or local paths are
hardcoded in the poster.

Named and legacy Codex selectors may be mixed across configuration scopes. The
poster preserves named-account default-first ordering, adds selected/configured
legacy homes, and deduplicates shared paths. It rejects the same-scope conflict
between `default_codex_account` and top-level `codex_home` (and the analogous
project-level `codex_account`/`codex_home` conflict).

Codex API-key session files currently expose token counts, not ChatGPT-style
rate-limit percentages. OpenAI Platform usage/cost API reporting requires an API
key with usage-read permissions.

Useful commands:

```bash
launchctl list | grep usage-stats-poster
tail -120 "${TMPDIR:-/tmp}/usage-stats-poster.log"
tail -120 "${TMPDIR:-/tmp}/usage-stats-poster.err"
```

Configuration stays in the ignored root `.usage-stats-poster.json`. Start from the tracked placeholder example, edit the destination channel and any Claude API-account transcript paths, then validate it:

```bash
cp .usage-stats-poster.example.json .usage-stats-poster.json
python3 scripts/usage-stats-poster.py --validate-config
```

Run a live legacy JSON-embed post separately after validation; installation never triggers this command:

```bash
python3 scripts/usage-stats-poster.py
```

To exercise the scheduled trend surface manually, use `--scheduled --post-now`; `--collect-only` records a snapshot without contacting Discord. Scheduled runs outside a UTC 30-minute window collect history but do not upload an image.

To roll back the schedule, unload and remove only CCDM's rendered LaunchAgent. Keep the older external poster directory and its LaunchAgent available until the replacement has been verified; deleting that external rollback copy is out of scope.

```bash
launchctl unload ~/Library/LaunchAgents/com.discord.usage-stats-poster.plist
rm ~/Library/LaunchAgents/com.discord.usage-stats-poster.plist
```

## Context Nicknames

CCDM can update each bot's Discord nickname to show its current context window usage — for example, `bot4-my-app · 42%`. This lets you see at a glance how much context each session has used, right from the Discord member list or channel messages.

This works via Claude Code's `statusLine` setting. Claude Code pipes status JSON to a command on every update; the script extracts the context percentage and PATCHes the bot's server nickname via the Discord API.

### Setup

Add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "/path/to/ccdm/scripts/cc-discord-nicknames.sh",
  "padding": 0
}
```

Two scripts are available:

| Script | What it does |
|--------|-------------|
| `scripts/cc-discord-nicknames.sh` | Updates Discord nicknames only — no terminal UI dependency |
| `scripts/cc-statusline-wrapper.sh` | Updates Discord nicknames AND pipes through [ccstatusline](https://github.com/sirmalloc/ccstatusline) for a terminal status bar |

Use the wrapper if you also use Claude Code in the terminal and want the status bar. Use the nicknames-only script if you only interact via Discord.

### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `CONTEXT_DISCORD_INTERVAL` | `60` | Minimum seconds between nickname updates (avoids Discord rate limits) |
| `DISABLE_DISCORD_MESSAGE` | `false` | Set to `true` to disable nickname updates entirely |

Both env vars are optional. The scripts also require `DISCORD_STATE_DIR` to be set, which happens automatically when Claude Code starts with the Discord plugin.

## Preventing Sleep

CCDM needs your machine to stay awake — if it sleeps, all tmux sessions (and their Discord bots) go offline.

**macOS:**
- Install [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704) (free) and set it to keep the Mac awake indefinitely
- Or use the built-in command: `caffeinate -s` (keeps the system awake while the command runs)
- Or disable sleep entirely: `sudo pmset -a disablesleep 1` (undo with `sudo pmset -a disablesleep 0`)

**Linux:**
- `systemd-inhibit --what=idle sleep infinity` (prevents idle sleep while running)
- Or configure via `systemctl mask sleep.target suspend.target`

## Auto-Start on Reboot (macOS)

By default, tmux sessions don't survive reboots. Set up a macOS Launch Agent so the root agent starts automatically on login:

```bash
# Create the Launch Agent plist
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

# Load it
launchctl load ~/Library/LaunchAgents/com.claude.root-agent.plist

# Verify
launchctl list | grep claude
```

Replace `/path/to/ccdm` and `/Users/YOU` with your actual paths. The Launch Agent runs `restart-root-agent.sh` on login, which starts the root agent in a `root_agent` tmux session. Project sessions still need to be started manually after reboot — message the root agent with `start <project>`.

To unload: `launchctl unload ~/Library/LaunchAgents/com.claude.root-agent.plist`

## Security Note

CCDM uses the `--dangerously-skip-permissions` flag when starting Claude Code sessions. This is necessary because automated bot sessions cannot interactively confirm permission prompts.

This means Claude Code will have unrestricted access to the file system and shell within each project directory. Only run CCDM on machines you trust, and be mindful of what projects you connect.

## Global Skills

CCDM includes reusable skills (custom slash commands) that any Claude Code agent can use. Copy them to `~/.claude/commands/` on any machine to make them available globally.

| Skill | File | Description |
|-------|------|-------------|
| `/restart-self` | `skills/restart-self.md` | Agent restarts its own session — detects its tmux session name, state dir, and project path automatically, then runs a `nohup` restart that survives its own process being killed |
| `/check-context` | `skills/check-context.md` | Agent checks its own context window usage — finds its tmux session, sends `/context`, and reports token usage breakdown |

### Installing skills

**On your local machine (all agents get them automatically):**
```bash
cp skills/*.md ~/.claude/commands/
```

**On a remote VM:**
```bash
mkdir -p ~/.claude/commands
# Copy each .md file, or tell the running agent to save them
```

Or just send the files to the agent on Discord and ask it to save them to `~/.claude/commands/`.

## Remote VM Setup

You can run Claude Code sessions on remote Linux VMs connected to Discord channels. The root agent handles bot registration and Discord permissions locally — only the Claude Code runtime runs on the VM.

### Prerequisites
- Node.js/npm installed on the VM
- Claude Code installed (`npm install -g @anthropic-ai/claude-code`) and logged in
- `tmux` installed
- **`IS_SANDBOX=1`** is required when running as root (Claude Code blocks `--dangerously-skip-permissions` as root without it)

### Steps

1. **Install Bun** (required by Discord plugin): `npm install -g bun`
2. **Install Discord plugin:**
   ```bash
   claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install discord@claude-plugins-official
   ```
3. **Ask the root agent** to register a bot and create a channel — it will provide the bot token and channel ID
4. **Create the state directory** on the VM with `.env` (bot token) and `access.json` (channel + user allowlist)
5. **Start the session:**
   ```bash
   tmux new-session -d -s <name> -- bash -ic 'cd /project && IS_SANDBOX=1 DISCORD_STATE_DIR=~/.claude/channels/discord_<name> claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   sleep 8 && tmux send-keys -t <name> Enter
   ```
6. **Install skills** (optional): copy `skills/*.md` to `~/.claude/commands/` on the VM

See `CLAUDE.md` for the full detailed instructions with all config file templates.

## File Structure

```
ccdm/
  CLAUDE.md                  # Agent instructions (read by Claude Code)
  README.md                  # This file
  LICENSE                    # MIT
  .gitignore                 # Excludes registry.json, .claude/, .env
  registry.example.json      # Template — copy to registry.json
  registry.json              # Your config (not committed)
  restart-root-agent.sh      # Self-restart script
  setup.sh                   # Interactive first-run setup
  scripts/
    _update-nickname.sh      # Shared helper — Discord nickname update logic
    cc-discord-nicknames.sh  # StatusLine script — updates bot nicknames with context %
    cc-statusline-wrapper.sh # StatusLine script — nicknames + ccstatusline terminal UI
    claude-usage.sh          # Usage reporting script
    send-claude-command.sh   # Root relay helper — sends /compact or /clear into a Claude tmux session
    start-session.sh         # Generic script to start any registered project
    stop-session.sh          # Generic script to stop any registered project
  skills/
    restart-self.md          # /restart-self skill — agent self-restart
    check-context.md         # /check-context skill — context window usage check
```

## Troubleshooting

**Bot doesn't respond to messages**
- Ensure **Message Content Intent** is enabled in the Discord Developer Portal (Bot settings)
- Check the bot is in the same server as you
- Verify your Discord user ID is in `access.json`

**`tmux` session dies immediately**
- Run the command directly without tmux to see the actual error
- If running as root: add `IS_SANDBOX=1` before `claude`
- Check that `claude` is in your PATH (run `which claude` in zsh)
- On Linux, ensure `zsh` is installed or adapt commands to use `bash -ic`

**"Command not found: claude"**
- Claude Code may only be in PATH via `~/.zshrc` — that's why sessions use `zsh -ic`
- Verify: `zsh -ic 'which claude'`

**Usage report shows "Could not fetch profile"**
- Live API data requires macOS Keychain with Claude Code credentials
- Run `claude` interactively once to populate the Keychain
- Local stats will still work without Keychain access

**Sessions lost after reboot**
- Tmux sessions don't survive machine restarts
- Set up the [Launch Agent](#auto-start-on-reboot-macos) so the root agent starts automatically, then `start <project>` for each project

## Limitations

- Sessions do not persist across machine restarts (root agent can [auto-start](#auto-start-on-reboot-macos), project sessions must be started manually)
- Live usage API data requires macOS Keychain (local stats work everywhere)
- Each project needs its own bot from the pool — two projects cannot share a bot (default limit: 50, configurable)
- Voice message transcription requires `whisper` (optional)
- Pool bots with admin managed roles bypass channel isolation — bot roles must have non-admin permissions for isolation to work
- When new Discord categories are created, the "project-bot" role deny must be applied to them

## License

MIT — see [LICENSE](LICENSE)
