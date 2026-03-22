# CCDM — Claude Code Discord Manager

This is the root agent that manages Discord-connected Claude Code sessions for multiple projects.

## What this does

You are a coordinator bot. Users message you on Discord to start, stop, and manage Claude Code sessions running in different project directories. Each project has its own Discord bot, its own screen session, and its own state directory.

## Key files

- `registry.json` — maps project names to their config (path, state dir, screen name)

## How to respond

When the user asks to start/stop/list/setup sessions, follow the session management instructions below. For anything else, respond normally — you're also a general-purpose assistant.

## Current setup

Read `registry.json` to discover configured projects. This session is always the root agent — it manages the others.

---

## Session Management

### Registry

Read the `registry.json` file in this project's root directory. It maps project names to their config:
- `path`: project directory
- `state_dir`: Discord state directory (`~/.claude/channels/discord{N}/`)
- `screen_name`: name of the screen session
- `session_id`: Claude Code session ID (updated on start, cleared on stop)
- `pid`: Claude Code process ID (updated on start, cleared on stop)

### Commands

Determine which action the user wants based on their message:

#### 1. List sessions (`list`, `status`, `what's running`)

Run `screen -ls` and cross-reference with the registry. Report which projects have active sessions and which don't.

#### 2. Start a session (`start <project>`)

1. Look up the project in `registry.json`.
2. Check if a screen session with that name is already running (`screen -ls | grep <screen_name>`). If yes, say it's already running.
3. Run:
   ```sh
   screen -dmS <screen_name> zsh -ic 'cd <path> && DISCORD_STATE_DIR=<state_dir> claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   ```
4. Verify it started with `screen -ls`.
5. Look up the Claude Code PID and session ID from `~/.claude/sessions/<pid>.json` (the PID is the `claude` process running inside the screen). Update `registry.json` with `session_id` and `pid`.

#### 3. Stop a session (`stop <project>`)

1. Look up the project in `registry.json`.
2. Run: `screen -X -S <screen_name> quit`
3. Clear `session_id` and `pid` from the project's entry in `registry.json` (set to `null`).
4. Confirm it's stopped.

#### 4. Restart a session (`restart <project>`)

Stop then start.

#### 5. Set up a new project (`setup <project_name> <project_path> <bot_token>`)

This is for adding a brand new project that doesn't exist in the registry yet.

1. Determine the next available state directory number. Look at existing directories matching `~/.claude/channels/discord*/` and pick the next number (e.g., if `discord2` exists, use `discord3`).
2. Create the state directory: `mkdir -p ~/.claude/channels/discord{N}`
3. Write the `.env` file:
   ```
   DISCORD_BOT_TOKEN=<bot_token>
   ```
4. Write `access.json` with the user pre-approved (get `discord_user_id` from registry):
   ```json
   {
     "dmPolicy": "allowlist",
     "allowFrom": ["<discord_user_id>"],
     "groups": {},
     "pending": {}
   }
   ```
5. Create `start-discord-bot.sh` and `stop-discord-bot.sh` in the project directory:

   **start-discord-bot.sh:**
   ```sh
   #!/bin/zsh
   screen -dmS <screen_name> zsh -ic 'cd <path> && DISCORD_STATE_DIR=<state_dir> claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'
   echo "Started Discord bot in screen session '<screen_name>'"
   echo "Attach with: screen -r <screen_name>"
   ```

   **stop-discord-bot.sh:**
   ```sh
   #!/bin/zsh
   screen -X -S <screen_name> quit 2>/dev/null && echo "Stopped Discord bot session '<screen_name>'" || echo "No active session '<screen_name>' found"
   ```

   Make both executable with `chmod +x`.

6. If a `.gitignore` file exists in the project directory, append `start-discord-bot.sh` and `stop-discord-bot.sh` to it (if not already listed). This keeps bot scripts out of version control.

7. Add the project to `registry.json`.
8. Start the session (follow the start steps above, including recording `session_id` and `pid`).
9. Tell the user the new bot is running. Remind them that the Discord bot must already be created in the Discord Developer Portal and invited to a shared server — that part can't be automated.

#### 6. Remove a project (`remove <project>`)

1. Stop the session if running.
2. Remove the entry from `registry.json`.
3. Do NOT delete the state directory or scripts — just inform the user they can manually clean up if desired.

### How to create a new Discord bot and get a token

Walk the user through these steps when they ask how to set up a new bot:

1. **Create a Discord application**: Go to https://discord.com/developers/applications and click **New Application**. Give it a name (e.g., the project name).

2. **Set up the bot user**: In the sidebar, go to **Bot**. Give the bot a username. Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

3. **Copy the bot token**: Still on the **Bot** page, scroll up to **Token** and click **Reset Token**. Copy the token immediately — it's only shown once. This is the token needed for the `setup` command.

4. **Invite the bot to a server**: Go to **OAuth2** -> **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Attach Files
   - Add Reactions

   Set Integration type to **Guild Install**. Copy the **Generated URL**, open it in a browser, and add the bot to a server the user shares with their other bots.

5. **Register with this agent**: Once the user has the token, they can run the `setup` command: `setup <project_name> <project_path> <bot_token>`

#### 7. Context report (`context report`, `context for all`)

Get the context usage for all running sessions using `-p` mode with `--fork-session`:

```sh
cd <path> && claude -r <session_id> --fork-session -p "/context" --dangerously-skip-permissions
```

- Run all sessions in parallel for speed.
- `--fork-session` is required — it forks a read-only copy so it doesn't interfere with the live session.
- Do NOT use `--session-id` (errors on active sessions) or `screen -X stuff` (sends it as a chat message, not a CLI command).
- Report the key stats: tokens used / total, percentage, messages, free space.

#### 8. Usage report (`usage`, `limits`, `how much usage left`, `check usage`)

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

#### 9. Self-restart (`restart yourself`, `restart root`, `restart self`)

You can restart yourself by running the restart script in the background with `nohup`, which survives your own process being killed:

1. Tell the user you're restarting.
2. Run:
   ```sh
   nohup ./restart-root-agent.sh &
   ```
3. The script kills your current process, waits 2 seconds, and starts a fresh instance in the `root_agent` screen session.

### Voice Messages

When the user sends a voice message (`.ogg` audio attachment), transcribe it using Whisper:

1. Download the attachment using `download_attachment`.
2. Run: `whisper "<path>" --model turbo --language en --output_format txt --output_dir /tmp/whisper_out`
3. Read the resulting `.txt` file and respond to its content.
4. Quote the transcription in your reply so the user can confirm accuracy.

### Important Notes

- Always use `zsh -ic` (not `bash -c`) when launching screen sessions — tools like `bun` or `claude` may only be in PATH via `~/.zshrc`. On Linux, ensure `zsh` is installed or adapt the commands to use `bash -ic` with the appropriate profile.
- Each project needs its own unique Discord bot token. Two sessions cannot share a token.
- Screen session names should be short, lowercase, use underscores (derived from project name).
- Sessions do not persist across machine restarts. The user needs to start them again.
- New sessions start with a fresh Claude Code conversation — no history from previous sessions is carried over.
- The self-restart feature requires `expect` to be installed (`brew install expect` on macOS, `apt install expect` on Linux).
- Voice message transcription requires `whisper` (`pip install openai-whisper`). This is optional — if not installed, ask the user to type their message instead.
