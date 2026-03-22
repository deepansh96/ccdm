# CCDM — Claude Code Discord Manager

Manage multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances from Discord. Each project gets its own bot, its own screen session, and its own conversation — all orchestrated by a single root agent.

```
Discord Server
  │
  ├── Root Agent Bot (this repo)
  │     Manages all other bots via screen sessions
  │
  ├── Project Bot 1 (screen session)
  │     Claude Code running in ~/project-a/
  │
  └── Project Bot 2 (screen session)
        Claude Code running in ~/project-b/
```

## How It Works

The root agent is a Claude Code instance connected to Discord. When you message it, it can:

- **Start/stop/restart** Claude Code sessions for different projects
- **Set up new projects** with their own Discord bots
- **Report context usage** across all running sessions
- **Show rate limits and usage stats** with visual progress bars
- **Restart itself** without manual intervention
- **Transcribe voice messages** using Whisper

Each project runs in its own `screen` session with its own Discord bot token, so you can talk to each project independently on Discord.

CCDM is built on the [official Anthropic Discord plugin for Claude Code](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/README.md). Refer to that README for details on the plugin itself, including how the MCP server works, pairing flow, and access control.

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Yes | See docs |
| `screen` | Yes | `brew install screen` / `apt install screen` |
| `zsh` | Yes | Default on macOS / `apt install zsh` on Linux |
| `python3` | Yes | `brew install python3` / `apt install python3` |
| `expect` | Yes | `brew install expect` / `apt install expect` |
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
screen -dmS root_agent zsh -ic 'cd /path/to/ccdm && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
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

2. **Edit `registry.json`** — replace `YOUR_DISCORD_USER_ID` with your actual Discord user ID:
   ```json
   {
     "discord_user_id": "123456789012345678",
     "projects": {}
   }
   ```
   To find your Discord user ID: Settings > Advanced > enable Developer Mode, then right-click your name > Copy User ID.

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
   screen -dmS root_agent zsh -ic 'cd /path/to/ccdm && DISCORD_STATE_DIR=~/.claude/channels/discord claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   ```

## Commands

Message the root agent bot on Discord with any of these:

| Command | Description |
|---------|-------------|
| `list` / `status` | Show all registered projects and their status |
| `start <project>` | Start a project's Claude Code Discord session |
| `stop <project>` | Stop a project's session |
| `restart <project>` | Restart a project's session |
| `setup <name> <path> <token>` | Register and start a new project bot |
| `remove <project>` | Unregister a project |
| `context report` | Get context window usage for all running sessions |
| `usage` / `limits` | Show rate limits, usage stats, and account info |
| `restart yourself` | Self-restart the root agent |

### Adding a New Project

Once the root agent is running, message it on Discord:

```
setup my_project ~/path/to/project BOT_TOKEN_HERE
```

This will:
1. Create a new state directory for the project
2. Configure the bot token and access control
3. Add the project to the registry
4. Start the Claude Code session in a new screen

Each project needs its own Discord bot — see [Creating Discord Bots](#creating-discord-bots).

## Creating Discord Bots

Each project (including the root agent) needs its own Discord bot. Here's how to create one:

1. **Create an application**: Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it after your project.

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

6. **Register with CCDM**: Message the root agent: `setup <project_name> <project_path> <bot_token>`

## Usage Report

CCDM includes a usage reporting script (`scripts/claude-usage.sh`) that shows:

- **Live data** (macOS only): Account profile, 5-hour session limits, 7-day limits, extra usage billing
- **Local data** (all platforms): Lifetime stats, monthly breakdowns, top projects, busiest days, streaks

The live data section uses the macOS Keychain to retrieve your Claude Code OAuth token. On Linux, this section gracefully skips and local stats still work.

Ask the root agent for a usage report by messaging `usage`, `limits`, or `how much usage left`.

## Preventing Sleep

CCDM needs your machine to stay awake — if it sleeps, all screen sessions (and their Discord bots) go offline.

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
```

## Troubleshooting

**Bot doesn't respond to messages**
- Ensure **Message Content Intent** is enabled in the Discord Developer Portal (Bot settings)
- Check the bot is in the same server as you
- Verify your Discord user ID is in `access.json`

**`screen` session dies immediately**
- Attach to see errors: `screen -r root_agent`
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
- Screen sessions don't survive machine restarts
- Re-run `start <project>` for each project, or set up a launch agent / systemd service

## Limitations

- Sessions do not persist across machine restarts
- Live usage API data requires macOS Keychain (local stats work everywhere)
- Each project needs its own Discord bot token — two sessions cannot share a token
- Voice message transcription requires `whisper` (optional)

## License

MIT — see [LICENSE](LICENSE)
