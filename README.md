# CCDM — Claude Code Discord Manager

Manage multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances from Discord. A **pool of Discord bots** is managed centrally — assign one to a project when needed, return it when done.

```
Discord Server
  │
  ├── #root (General)  ← Root Agent listens here (no @mention needed)
  ├── #root (ADS)      ← Root Agent listens here too
  ├── #root (AF)       ← ...and here
  │
  ├── #my-app (ADS)    ← bot2-my-app ONLY sees this channel
  │     Claude Code running in ~/my-app/
  │
  ├── #website (AF)    ← bot3-website ONLY sees this channel
  │     Claude Code running in ~/website/
  │
  └── bot4, bot5, ...  (available in pool, not assigned)
```

## How It Works

The root agent is a Claude Code instance connected to Discord. It manages a **pool of up to 50 Discord bots**. When you message it in any `#root` channel, it can:

- **Register bots** to specific Discord channels (each bot is isolated to only see its assigned channel)
- **Deregister bots** and return them to the pool (channel stays, bot goes back)
- **Start/stop/restart** Claude Code sessions for assigned projects
- **Report context usage** across all running sessions
- **Show rate limits and usage stats** with visual progress bars
- **Restart itself** without manual intervention
- **Transcribe voice messages** using Whisper

Each project gets its own Discord channel and bot. The bot is **locked to that one channel** via Discord permission overrides — it can't see anything else. You chat with each project in its own channel, no `@mention` needed. The root agent listens in all `#root` channels without `@mention`, and can be `@mentioned` in project channels for management tasks.

CCDM is built on the [official Anthropic Discord plugin for Claude Code](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/README.md). Refer to that README for details on the plugin itself, including how the MCP server works, pairing flow, and access control.

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Yes | See docs |
| `tmux` | Yes | `brew install tmux` / `apt install tmux` |
| `zsh` | Yes | Default on macOS / `apt install zsh` on Linux |
| `python3` | Yes | `brew install python3` / `apt install python3` |
| `whisper` | Optional | `pip install openai-whisper` (for voice messages) |

You also need:
- A Discord account
- A Discord server where you can add bots
- At least one Discord bot (for the root agent) — see [Creating Discord Bots](#creating-discord-bots)

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/deepanshmathur/ccdm.git
cd ccdm

# 2. Run the setup script
./setup.sh

# 3. Start the root agent
tmux new-session -d -s root_agent -- zsh -ic 'cd /path/to/ccdm && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
```

The setup script will:
1. Check that all prerequisites are installed
2. Ask for your Discord user ID
3. Create `registry.json` from the template
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
     "groups": {},
     "pending": {}
   }
   EOF
   ```

6. **Start the root agent:**
   ```bash
   tmux new-session -d -s root_agent -- zsh -ic 'cd /path/to/ccdm && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   ```

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
| `context report` | Get context window usage for all running sessions |
| `usage` / `limits` | Show rate limits, usage stats, and account info |
| `restart yourself` | Self-restart the root agent |

### Registering a New Project

Once the root agent is running and you have bots in the pool, message it in any `#root` channel:

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
- Project bots **cannot see** any other channel, `#root` channels, or other project channels
- The root bot **can see everything** and responds in `#root` channels without `@mention`
- You can `@mention` the root bot in any project channel for management tasks

## Managing the Bot Pool

CCDM uses a **bot pool** — a set of pre-created Discord bots that get assigned to projects on demand. The pool supports up to 50 bots.

### Adding bots to the pool

The easiest way is to message the root agent: `pool add`. This uses browser automation to create a bot, get its token, and invite it to your server automatically.

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

## Preventing Sleep

CCDM needs your machine to stay awake — if it sleeps, all tmux sessions (and their Discord bots) go offline.

**macOS:**
- Install [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704) (free) and set it to keep the Mac awake indefinitely
- Or use the built-in command: `caffeinate -s` (keeps the system awake while the command runs)
- Or disable sleep entirely: `sudo pmset -a disablesleep 1` (undo with `sudo pmset -a disablesleep 0`)

**Linux:**
- `systemd-inhibit --what=idle sleep infinity` (prevents idle sleep while running)
- Or configure via `systemctl mask sleep.target suspend.target`

## Security Note

CCDM uses the `--dangerously-skip-permissions` flag when starting Claude Code sessions. This is necessary because automated bot sessions cannot interactively confirm permission prompts.

This means Claude Code will have unrestricted access to the file system and shell within each project directory. Only run CCDM on machines you trust, and be mindful of what projects you connect.

## Global Skills

CCDM includes reusable skills (custom slash commands) that any Claude Code agent can use. Copy them to `~/.claude/commands/` on any machine to make them available globally.

| Skill | File | Description |
|-------|------|-------------|
| `/restart-self` | `skills/restart-self.md` | Agent restarts its own session — detects its tmux session name, state dir, and project path automatically, then runs a `nohup` restart that survives its own process being killed |
| `/project-context` | `skills/project-context.md` | Generates or updates a comprehensive `project-context.md` document for the current project — serves as an entry point for AI agents and engineers |

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
    claude-usage.sh          # Usage reporting script
    start-session.sh         # Generic script to start any registered project
    stop-session.sh          # Generic script to stop any registered project
  skills/
    restart-self.md          # /restart-self skill — agent self-restart
    project-context.md       # /project-context skill — generate project docs
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
- Re-run `start <project>` for each project, or set up a launch agent / systemd service

## Limitations

- Sessions do not persist across machine restarts
- Live usage API data requires macOS Keychain (local stats work everywhere)
- Each project needs its own bot from the pool — two projects cannot share a bot (max 50 bots)
- Voice message transcription requires `whisper` (optional)
- Pool bots with admin managed roles bypass channel isolation — bot roles must have non-admin permissions for isolation to work
- When new Discord categories are created, the "project-bot" role deny must be applied to them

## License

MIT — see [LICENSE](LICENSE)
