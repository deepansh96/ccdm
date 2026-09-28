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

#### MiMo API accounts

MiMo can power the existing Codex CLI/app-server bridge using its Responses
API. Prepare a separate home with Python 3.10+ and a recent Codex CLI
(tested with 0.153.4):

```bash
python3 scripts/setup-codex-mimo.py --home ~/.codex-mimo --billing payg
```

The command prompts for the key without echoing it. Automation can provide
`MIMO_API_KEY` or pipe the key through stdin; never put a real key in command
arguments. For a Token Plan key, use `--billing token-plan` instead. Pay-as-you-go
uses `https://api.xiaomimimo.com/v1` and an `sk-` key; Token Plan uses
`https://token-plan-cn.xiaomimimo.com/v1` and a `tp-` or `ttp-` key.

The helper creates a new private home, downloads and validates Xiaomi's model
catalog, and defaults to `mimo-v2.6-pro` with high reasoning and web search
disabled. `--model` selects another model present in that catalog with Responses
lite and reasoning support. `--catalog-file` uses a previously downloaded catalog
for offline setup. Existing homes and paths inside this checkout are rejected.
No registry, default account, or running session is changed by the helper.

Credentials live in the home's `api-key` file (mode `0600`, home mode `0700`).
Codex's provider authentication command reads that file directly, so standalone
Codex and CCDM/tmux launches do not need an inherited `MIMO_API_KEY`. This home
does not require OpenAI `codex login`. Keep the entire home outside the repository.

Add an alias to the existing `codex_accounts` object in ignored `registry.json`,
preserving its other entries and the current default:

```json
"mimo": "~/.codex-mimo"
```

On a registered Codex project, set `"codex_account": "mimo"`. Remove a legacy
project `codex_home` selector and any incompatible GPT model or service-tier
override; omit `codex_model` to use the MiMo home's model. Stop the selected
project with `scripts/stop-session.sh <project>`, then start it with
`scripts/start-codex-session.sh <project>`. Other sessions need no restart.
To switch back, restore that project's previous selector and restart it.

Before assigning a bot, test the home in a disposable directory:

```bash
CODEX_HOME=$HOME/.codex-mimo codex exec --strict-config --skip-git-repo-check \
  -C /tmp -s read-only 'What is 2 + 2? Reply only with the answer.'
```

Replace a testing key later without overwriting configuration, MCP entries,
catalogs, or history:

```bash
python3 scripts/setup-codex-mimo.py --home ~/.codex-mimo --billing payg --rotate-key
```

Use the home's original billing option; switching billing endpoints requires a
new home. The `ccdm-mimo.json` file records that original billing option for
rotation. Restart sessions using that home after rotation to refresh authentication.

The vendor catalog enables `use_responses_lite`, needed for custom tools.
Reasoning support comes from the catalog: the vendor guide's older top-level
`model_supports_reasoning_summaries` setting is rejected by Codex 0.153.4's strict
configuration parser and is deliberately omitted. The setup command validates
catalog metadata but does not make a billable inference call or verify balance.
MiMo billing/quota reporting is not added to CCDM's ChatGPT usage dashboards.

References: [MiMo Codex integration](https://mimo.mi.com/docs/en-US/tokenplan/integration/codex-configuration)
and [Codex provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

#### DeepSeek 4.1 Flash API accounts

DeepSeek 4.1 Flash uses the API model name `deepseek-flash` as of September 22,
2026. Prepare its own Codex home with Python 3.10+ and a recent Codex CLI
(tested with 0.153.4):

```bash
python3 scripts/setup-codex-deepseek.py --home ~/.codex-deepseek
```

Enter your DeepSeek API key at the hidden prompt. Automation can set
`DEEPSEEK_API_KEY` or pipe the key through stdin; the environment variable takes
precedence. Never put credentials in command arguments or tracked files. The
helper stores the key in a private `api-key` file, and Codex reads it with its
provider authentication command. No OpenAI login is needed.

The helper downloads DeepSeek's official setup script **as data only**, extracts
its literal model-catalog JSON without executing the script, and retains the
`deepseek-flash` entry. It validates standard Responses, shell/patch tools,
vision, and high reasoning support before creating any state. If the upstream
script layout changes, setup fails; `--catalog-file <path>` accepts a downloaded
catalog JSON or vendor script for offline preparation.

This catalog is different from MiMo's: DeepSeek uses `use_responses_lite = false`
and `shell_type = "shell_command"`. Do not reuse MiMo's catalog. The generated
configuration selects `https://api.deepseek.com/`, high reasoning, and disabled
built-in web search. The API alias may change models in future; consult the
vendor's model reference when upgrading.

Add the new home to the existing `codex_accounts` object in ignored
`registry.json`, keeping the other entries and default:

```json
"deepseek": "~/.codex-deepseek"
```

Select `"codex_account": "deepseek"` on the intended Codex project. Remove any
same-scope `codex_home` and incompatible model/effort/service-tier overrides, then stop
and start that project with the standard CCDM scripts. To roll back, restore its
previous account selector and restart it. Setup itself does not edit the registry
or restart sessions, and refuses existing homes and paths inside this checkout.

```bash
CODEX_HOME=$HOME/.codex-deepseek codex exec --strict-config --skip-git-repo-check \
  -C /tmp -s read-only 'What is 2 + 2? Reply only with the answer.'

python3 scripts/setup-codex-deepseek.py --home ~/.codex-deepseek --rotate-key
```

Rotation replaces only the private key, preserving configuration, MCP entries,
catalog, and history; restart affected sessions to refresh authentication. The
home uses mode `0700`, and generated files use `0600`. Keep the full home,
including its `ccdm-deepseek.json` setup marker, outside the repository.

Flash accepts image input; browser/computer control additionally needs a
configured Computer Use tool/plugin. Supported reasoning efforts are `low`,
`high`, and `max`; the helper defaults to `high`. DeepSeek has no ChatGPT-style
quota window, so its usage dashboard shows the account-wide balance returned by
the official `GET /user/balance` API plus this machine's local DeepSeek token
totals instead of a rate-limit graph. The helper does not make billable
inference calls; test the home separately before assigning a bot.

To add web search and page reading through [Exa MCP](https://exa.ai/docs/get-started/exa-mcp),
pass `--with-exa` when creating a new home. For an existing home, add this table to its `config.toml`:

```toml
[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
```

Use the table only once; preserve existing provider and tool settings. Direct
configuration avoids the automatic OAuth prompt from `codex mcp add` in Codex
0.153.4; the hosted server accepts unauthenticated tool calls.

Start a new session (or restart only the affected CCDM project) to load the tools.
Exa's hosted endpoint offers keyless, rate-limited access; searches and requested
page URLs go to Exa. Higher usage needs Exa authentication. Keep
`web_search = "disabled"`: this disables provider-native search, not MCP tools.
The setup flag writes configuration only and does not contact Exa. It cannot be
combined with `--rotate-key`. To remove it:

```sh
CODEX_HOME="$HOME/.codex-deepseek" codex mcp remove exa
```

References: [DeepSeek Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
and [DeepSeek model reference](https://api-docs.deepseek.com/quick_start/pricing/).

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

Claude projects can pin their account, model, and effort per session:

```json
{
  "claude_home": "~/.claude-work",
  "model": "claude-fable-5",
  "claude_effort": "high"
}
```

`scripts/start-session.sh` passes these values as `CLAUDE_CONFIG_DIR`,
`--model`, and `--effort`. Supported effort values are `low`, `medium`,
`high`, `xhigh`, and `max`.

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

### Claude Accounts

A Thread Conversation can run on another Claude home through a Claude account
alias. Map each alias to its Claude home in the top level of `registry.json`:

```json
"claude_accounts": {
  "work": "~/.claude-work"
}
```

The map only names homes a thread may select with `/thread … --account work`;
it does not change any project's `claude_home`. An absent key means no Claude
aliases, so a Claude thread can use only its project's home, or `~/.claude` for
a Claude thread in a Codex project. Each home needs the official Discord plugin
installed, like any Claude project home.

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
     "claude_accounts": {},
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

### Resuming a Codex conversation

Normal project launches and `/restart` start a new conversation. To explicitly
continue a saved conversation, get its UUID from the bridge's `Codex thread
started:` log line, then run:

```bash
scripts/stop-session.sh my-project
scripts/start-codex-session.sh my-project --resume <thread_uuid>
```

The selected Codex home must contain that saved thread. The bridge resumes it
and refreshes the Discord instructions and reply credentials. If that instruction
request is rejected, resumed startup also fails. A failed resume
stops startup instead of silently creating a fresh conversation. Resume launches
wait up to 60 seconds for listener readiness before reporting success. A failed
or timed-out startup returns an error and cleans up the session and saved PID. `/clear` still
starts a new conversation; the resume argument applies only at startup.

To change Codex accounts while retaining the conversation, first locate its
`sessions/.../rollout-...-<thread_uuid>.jsonl` file in the old home and verify
the thread ID and project directory in its session metadata. Stop the project,
copy that file into the same relative `sessions/` location in the target home
without overwriting an existing file, and set the project's `codex_account` to
the target alias. Then launch with `--resume <thread_uuid>`. Keep the original
file and account selection for recovery. The target account must already be
logged in; do not copy credentials between homes. This preserves the saved
conversation, not running tools or child-agent processes.

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

## Project Conversation state

The opt-in foreground [Project Conversation state service](docs/conversation-reminders.md) records owner replies, `/close`, reopening, and due times for registered Claude and Codex channels. It sends a `👀` from each channel's assigned bot one hour after a conversation starts awaiting the owner; while reminders are ignored, the gap grows to 2, 4, 6 … hours and settles at one a day. Run `scripts/conversation-reminder-service.py enable` to check prerequisites and opt in, then `run` to start the worker. On macOS, `scripts/install-conversation-reminder-service.sh` can supervise the same worker as an opt-in LaunchAgent. It validates configuration first and keeps credentials out of the plist. It never changes the Usage Stats Poster. After a restart, reconnect, or re-enable, the service reconciles missed activity before sending. Each overdue channel then gets at most one catch-up, spaced at least five seconds apart.

## Thread Supervisor

The Thread Supervisor is a separate root-level service that watches Discord threads in registered project channels. It binds a thread to its project when the thread is public (type 11), its parent is a registered local project channel (not a `remote:` project, forum, or media channel), and the CCDM owner or one of the project's guests created it. Private threads, threads under unregistered or root channels, and threads created by anyone else are ignored. A re-sent thread event never binds a thread twice. When a thread binds, the supervisor sets its auto-archive to one week (10080 minutes) with the project's bot. If that bot lacks Manage Threads, the thread stays bound and the failure is logged.

The first message from the owner or a guest in a bound thread of a Claude project starts that thread's own Claude session, whether or not the project's Channel Conversation is running. Strangers' messages start nothing. The supervisor reacts 👀 to the triggering message while the session boots and removes it once the session is ready. It launches `scripts/start-thread-session.sh <project> <thread_id>`, which shares its model, effort, and account mapping with `start-session.sh` through `scripts/claude-launch.py`. The session runs in tmux `<screen_name>-t-<last 6 digits of the thread id>`, from the project path, behind the conversation-scoped proxy pinned to the thread. Its private state dir `<bot state_dir>/threads/<thread_id>/` holds a symlink to the bot's `.env` (the token never enters the environment), an `access.json` that allows only the parent channel's group for the owner and guests, and its own launch files. It runs with `DISCORD_ACCESS_MODE=static`, and its read-only exporter's `CHANNEL_ID` is the thread id. The supervisor accepts the development-channel consent and workspace-trust prompts in the pane. The session's first prompt is a bootstrap naming the thread and carrying its starter message (for a thread started from a channel message) plus every owner or guest message sent during boot, each exactly once. `status` then shows the thread `live` with its Claude session id. If the session is not ready within 120 seconds, the supervisor posts a one-line reason in the thread and marks it `stopped` with `start-failed`; it never retries on its own, and the next owner message tries again. `scripts/stop-session.sh <project>` stops only the Channel Conversation and leaves thread sessions running; `--threads` and `--all` are described below.

In a Codex project, the same first message opens the thread's own Codex conversation on the project's Codex thread host, `scripts/codex-thread-host.js`, with the same 👀, boot-time buffering, 120-second boot timeout, and failure line. The supervisor starts the host in tmux `<screen_name>-threads` when it is not running. The host logs into the project bot's Gateway, accepts messages and reactions only in the threads it hosts and only from the owner and the project's guests, and never changes the bot's nickname. It runs one `codex app-server` per Codex Home in use; the first listens on the project's `thread_ws_port` (default `ws_port + 1000`) and each further home on the next port. A thread uses the project's Codex Home (resolved like `start-codex-session.sh`), `codex_model`, `codex_reasoning_effort`, and the optional `codex_sandbox` (default `danger-full-access`); effort goes through `config.model_reasoning_effort` on `thread/start` and `effort` on every turn. Every `thread/start` carries a per-conversation `config.mcp_servers` override: a Discord server whose `CHANNEL_ID` is the thread id, with `default_tools_approval_mode: "approve"` unless the sandbox is `danger-full-access`, and `enabled: false` for every other `discord-*` server in the home. The host never calls `config/value/write` for `mcp_servers.*`, so no Discord credential reaches the home's `config.toml` or a rollout. The conversation gets the no-action bootstrap turn first, then one turn with the starter message and every message sent before the handoff, each exactly once. The supervisor drives the host through a private control socket, `control.sock` (`0600`) in `<state dir>/hosts/<project>/`, with `open`, `stop`, `config`, and `command`; the host reports `conversation-id`, `ready`, `failed`, `turn-started`, and `turn-ended` back through `scripts/thread-supervisor.py host-event`, and `status` shows the thread `live` with its Codex conversation id. Every `thread/resume` carries the same override, rebuilt. Before each turn the host re-reads the home's `discord-*` servers; if one was added or removed since the override was built, it unloads the conversation (`thread/unsubscribe`) and resumes it with a refreshed override before the turn runs.

The owner or a guest can also open a thread from a project channel with one line:

```text
/thread <name> [--provider claude|codex] [--account X] [--model Y] [--effort Z] [first message…]
```

The supervisor handles it; the command never reaches the channel's model. It records a creation request, has the project bot create a standalone public thread named `<name>` with a one-week auto-archive, and binds that thread because it fulfils the request. A thread the project bot or root creates without a pending request is never bound. The overrides are stored on the thread: `--provider` picks `claude` or `codex` (default: the project's type), `--account` must be an alias in `codex_accounts` for Codex or in `claude_accounts` for Claude (a raw path is refused), `--model` picks the model, and `--effort` must be a value the provider's launch accepts (Claude: `low`, `medium`, `high`, `xhigh`, `max`; Codex: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`). Each option falls back to the project's setting. A thread that runs the other provider inherits nothing provider-specific from the project: with no `--account` it uses that provider's default account (the Default Codex Account, or the default `~/.claude` home), so a Claude project's thread can run on Codex through the project's Codex thread host (from `thread_ws_port`) and a Codex project's thread can run Claude. With a first message, the session starts at once with 👀 on the `/thread` message; without one, the thread waits for the first owner or guest message in it. An invalid option posts exactly one error line in the channel and creates no thread, request, or session. `/thread` from anyone but the owner or a guest does nothing, and `status` lists each project's creation requests under `creation_requests`. Both Channel Conversations drop `/thread` and `/config`; `/config` in a channel gets a one-line hint that it works inside threads.

Root and a project's Channel Conversation agent open threads through the same creation path, without anyone typing `/thread`. Root runs:

```sh
scripts/threads.sh create <project> <name> [--provider claude|codex] [--account X] [--model Y] [--effort Z] [first message…]
```

A Channel Conversation's Discord MCP has a `create_thread` tool (`name`, and optional `provider`, `account`, `model`, `effort`, and `message`): the Codex bridge's scoped server and the Claude channel's read-only supplementary server. The tool always targets its own `CHANNEL_ID`'s project; it takes no channel or project. Root and thread sessions do not get it. Both submit a creation request, with requester `root` or `channel-agent`, over the supervisor's private request socket, `requests.sock` (`0600`) in its state dir, which the running worker owns. Options are validated exactly like `/thread`: an invalid one fails with the same one-line error and creates nothing, and nothing is posted in Discord. With a first message, the project bot posts it in the new thread as `From root: …` or `From the channel agent: …`, reacts 👀 on that post while the session boots, and the session starts with it. If the supervisor is not running, `threads.sh create` exits nonzero and the tool returns an error, each saying so, and nothing is created.

Root sees and manages every project's threads without knowing their ids:

```sh
scripts/threads.sh list <project>                        # name, thread id, provider/model, state, idle time
scripts/threads.sh stop|restart|close [<project>] <thread> # <thread>: exact name, Discord thread link, or id
scripts/stop-session.sh <project> --threads              # the project's thread sessions and Codex thread host only
scripts/stop-session.sh <project> --all                  # the Channel Conversation and every thread session
```

`list` reads the thread store, so it works without the supervisor. It prints one row per thread: its name, id, `provider/model` (the thread's override or the inherited value), state with any stop reason (such as `stopped/operator` or `stopped/auto-archive`), and idle time since the owner's last message or the last turn end (or creation), such as `45m` or `2h05m`. `stop`, `restart`, and `close` act through the running supervisor's `requests.sock` and fail with the reason when it is not running. A thread is named by `https://discord.com/channels/<guild>/<thread>`, by its id, or by its exact name: a name matching more than one thread fails with every match listed (`review in demo (<id>), review in codexy (<id>)`), and a project before the name narrows the lookup to that project. `stop` ends a live, queued, or registered thread's session and marks it `stopped` / `operator`, posting `Stopped by root; the owner's next message resumes this thread.` in it. `restart` resumes a live or stopped thread's conversation, posting `Restarting this thread's session for root; the conversation resumes.` with 👀 on that post while it boots; a stopped thread takes a session slot like any other start. `close` works on any thread that is not booting or already closed, including a stopped one: it records the close intent, archives the thread with the project bot, stops the session, and marks it `closed`, as the owner's `/close` does, without posting. `stop-session.sh <project>` without a flag stops only the Channel Conversation. `--threads` marks every booting, live, or queued thread of the project `stopped` / `operator`, sweeps each thread's tmux session and listener, and stops tmux `<screen_name>-threads`, leaving the Channel Conversation and its registry fields untouched; it works with or without the supervisor running. `--all` does both.

Registry and guest changes reach live threads through `scripts/thread-supervisor.py project-changed --project <project>`, which root runs beside `conversation-reminder-service.py assignment-changed` after registration changes, and which `scripts/guest-access.js` `invite`, `grant`, and `revoke` run themselves. It works with or without the supervisor running. When the project is gone from the registry (deregistration), it stops every thread session and marks every thread `closed`. Otherwise it restarts each live thread and resumes its conversation: `bot-changed` when the thread's last session started under a different bot than the project's current one, posting `Restarting this thread's session on the project's new bot; the conversation resumes.` with the new bot, and `guest-changed` otherwise, posting `Restarting this thread's session because guest access changed; the conversation resumes.`. A Claude thread relaunches with `--resume <session id>` and a state dir rebuilt under the new bot's `state_dir` (so `access.json` carries the current guests), and the old bot's thread state dir is removed. A Codex project's thread host is replaced, so the new host logs in with the current bot and reads the current guests, and each conversation resumes with `thread/resume`. Stopped, queued, and closed threads stay as they are.

Inside a thread, the owner manages what serves it with `/config`, a plain-text command the supervisor handles. It never reaches the thread's model: the Claude thread proxy and the Codex thread host both drop it, and guests' `/config` is ignored.

```text
/config [provider=claude|codex] [account=X] [model=Y] [effort=Z]
```

With no arguments, the project bot posts the thread's provider, account, model, and effort in one line, marking each value the thread inherits from the project with `(inherited)`. `model=` and `effort=` store the thread's override; on a live thread the supervisor stops the session and resumes the same conversation with them (`claude --resume <session id> --model …`, or `thread/resume` with the stored Codex conversation id, the new `model`, and `config.model_reasoning_effort`), with 👀 on the `/config` message while it restarts. A thread that is not live uses them from its next start. `provider=` or `account=` starts a fresh conversation, so the bot first posts a one-line warning in the thread and reacts ✅ on it, recording a pending switch. Only the owner's ✅ on that warning applies it: the session stops and a fresh conversation starts in the same thread with the new settings. A provider switch keeps only the overrides it names, and an account switch keeps the model and effort. The old conversation stays in its Claude home or Codex Home but is never resumed again. Another user's ✅ does nothing. Options are validated like `/thread`: a raw account path, an unknown alias, a bad provider, or a bad effort posts one error line and changes nothing.

The same thread also takes the management commands, each acting on that thread only and never on the Channel Conversation or a sibling thread. The supervisor answers each with exactly one line from the project bot, and none reaches the thread's model: the Claude thread proxy and the Codex thread host drop them.

```text
/restart  /clear  /compact  /pause  /unpause  /close
```

`/restart` stops the session and resumes the same conversation (`claude --resume <session id>`, or Codex `thread/resume` with the stored conversation id), with 👀 on the command while it restarts. `/clear` stops the session and starts a fresh conversation in the same thread, storing its new id. `/compact`, `/pause`, and `/unpause` go to the Codex thread host's `command` operation (a paused Codex thread queues its messages until `/unpause`), or are typed into the Claude thread's own tmux session. These need a live thread; otherwise the bot answers that the session is not running. `/close` records a close intent, posts its line, archives the thread with the project bot (`PATCH archived: true`, which needs Manage Threads), stops the session, and marks the thread `closed`. The archive's audit-log actor is then the project bot, which counts as a close only while the thread holds that intent; an archive by the project bot without one is an auto-archive. Guests follow the Codex channel policy: a guest may use `/restart`, `/clear`, `/compact`, `/pause`, and `/unpause`, but only the owner's `/close` counts, and a guest's is dropped without a reply.

Archiving or deleting a thread stops its session. The supervisor reads who archived it from the root guild audit log (action 111). An archive by the owner or root closes the conversation (`closed`). Any other actor, or none, counts as Discord's inactivity auto-archive: the session stops (`stopped` / `auto-archive`) and the conversation stays open. If no audit-log entry appears within 60 seconds, or root cannot read the audit log, the archive is treated as an auto-archive and `status` shows `archive-actor-unknown` for the thread. Deleting a thread forgets it: its store row and runtime files are removed. Whenever a session stops, its per-thread runtime files (`<bot state_dir>/threads/<thread_id>/`: launch files, inbox, and bootstrap) are removed, while the row and the Claude conversation in the Claude home stay. The owner's next message in a stopped or closed thread resumes the same conversation with `claude --resume <session id>` under the same Claude home and project path, with 👀 while it boots. For a Codex thread, stopping unloads its conversation from the thread host with `thread/unsubscribe` and never calls `thread/archive`; once the last hosted thread of a project stops, the host stops its app-servers and exits, ending tmux `<screen_name>-threads`. The owner's next message relaunches the host, which calls `thread/resume` with the stored conversation id on the app-server for the stored Codex Home (after `thread/unarchive` if Codex reports the conversation archived), re-sends the bootstrap, and hands over the new message. A guest message never resumes a thread, and neither does a bot post that reopens an archived thread (Discord then re-sends the thread's creation event, which never binds it twice). The root bot therefore needs View Audit Log, which `preflight` checks.

Live thread sessions are capped per provider by `thread_session_caps` in `registry.json` (default `{ "claude": 6, "codex": 12 }` when absent). Only Thread Conversations count, never a Channel Conversation: for Claude, the thread sessions that are booting or live; for Codex, the thread conversations loaded on every project's thread host together. The supervisor tracks each session's turn: a Claude turn starts when the thread proxy relays an inbound message and ends on Claude Code's `Stop` or `StopFailure` command hook (`scripts/claude-thread-turns.js`), and a Codex turn follows the host's `turn-started` and `turn-ended`; `status` shows `turn_running` for a session mid-turn. A session is idle when no turn is running and the owner has not written in its thread for 30 minutes. When a start would pass its provider's cap, the supervisor evicts the idle session with the oldest activity (the later of the owner's last message and its last turn end): it stops the session, marks the thread `stopped` / `evicted`, and posts `Paused to free a session slot; reply to resume.` in it. The owner's next message there resumes the same conversation under the same rules. A session mid-turn is never evicted. If no session is idle, the new thread is marked `queued` and the bot posts `Queued, N sessions busy.` in it; messages sent while it waits are held for its bootstrap. Queued threads start first-in, first-out per provider as soon as a slot frees: a session stops, closes, or is deleted, or a live session goes idle while others wait, in which case it is evicted for the oldest waiter.

Every CCDM tool that takes a project channel id also takes one of its thread ids, through one shared conversation resolver:

```bash
scripts/resolve-conversation.py <channel_or_thread_id>   # {"project", "thread_id", "provider", "bot", "channel_id"}
```

It reads `registry.json` and the thread store read-only and never calls Discord. A project channel gives its project with `thread_id: null`; a thread the supervisor bound gives the parent project and the thread, with the thread's provider. An unknown id, or a channel two projects claim, exits nonzero with the reason. `scripts/send-claude-command.sh --channel <thread id> compact` types into that thread's own tmux session (`<screen_name>-t-<last 6 digits>`), never the Channel Conversation's. `scripts/guest-access.js` given a thread id grants, revokes, or lists on the parent project. `scripts/export-discord-range.js <thread id> …` exports the thread with the parent project bot's token. Root's Discord MCP in multi-channel mode and the Codex root bridge treat a thread under an allowed root `groups` channel as that channel, and refuse a thread under any other.

```bash
scripts/thread-supervisor.py preflight   # read-only: owner, root credentials, store, View Audit Log
scripts/thread-supervisor.py run         # foreground worker; Ctrl-C stops it
scripts/thread-supervisor.py status      # bound threads per project, with name, creator, state, and session
```

Project bots need Create Public Threads (bit 35) and Manage Threads (bit 34) on their own channel. New registrations grant them through the member overwrite `326417615936`. For projects registered earlier, run the idempotent grant with root credentials:

```bash
scripts/thread-supervisor.py grant-thread-permissions --all              # every registered project
scripts/thread-supervisor.py grant-thread-permissions --project <project> # one project
```

It PUTs `{"allow":"326417615936","deny":"0","type":1}` for each project's assigned bot on that project's channel and changes nothing else. A project whose overwrite already matches gets no request, and an unknown project fails before any Discord call. `status` reports `thread_permissions.missing`: the projects whose bot still lacks either bit. Guest role permissions are unchanged.

`run` logs in with the root bot credentials from `ROOT_DISCORD_STATE_DIR/.env` (default `~/.claude/channels/discord/.env`). Only one worker runs at a time: a second `run` exits nonzero while the lock is held. The supervisor is independent of the Conversation Reminder service; neither needs the other running. State lives in `~/.local/state/ccdm/thread-supervisor/` (override with `CCDM_THREAD_STATE_DIR`): the directory is `0700` and the SQLite thread store and lock are `0600`. `preflight` creates nothing and names every blocker it finds.

On macOS, `scripts/install-thread-supervisor.sh` installs the same worker as the `com.discord.thread-supervisor` LaunchAgent. It runs `preflight` first and keeps credentials out of the plist. To restart the supervisor, run `scripts/thread-supervisor.py disable`, then `scripts/thread-supervisor.py enable`, then the installer. `disable` stops the worker and keeps launchd from relaunching it. For foreground debugging, `disable` and `enable`, then use `run`. See the [Thread Supervisor guide](docs/thread-supervisor.md) for install, restart, and foreground debug mode.

## Scheduled Usage Stats Poster

A separate, opt-in macOS LaunchAgent can post usage stats to Discord on a schedule. It is not installed by `setup.sh` and it is not the old tmux-based `usage-report-loop.sh` flow.

The tracked installer requires Python 3 only, then renders and validates `~/Library/LaunchAgents/com.discord.usage-stats-poster.plist` with absolute paths to Python, Codex, the poster, and its logs. Pillow is not required: the scheduled and manual poster output is text-only, so installation never probes for image libraries, and a missing `python3` exits before touching LaunchAgents or the existing plist. The separate `scripts/usage-dashboard-renderer.py` trend renderer keeps Pillow as an optional dependency when it is invoked manually. The LaunchAgent is interval-only and runs every 600 seconds, so installation does not trigger an immediate post. Every automated run records a local structured snapshot in UTC 10-minute slots; the original text Usage Report is posted on its own only once per UTC 30-minute slot. No trend or balance PNG is rendered or attached by the scheduled or manual output. Manual JSON-embed invocations remain independent of the history database. Reinstalling unloads the existing label before loading the new plist, so changing the interval is idempotent; if the new load fails, the prior plist and loaded/unloaded schedule are restored:

```bash
scripts/install-usage-stats-poster.sh                 # 600 seconds (10 minutes)
scripts/install-usage-stats-poster.sh --interval 900  # 15 minutes
```

The rendered LaunchAgent contains no token, channel ID, or poster configuration. The installer never sends a Discord request; it only schedules the poster.

History is stored at `~/Library/Application Support/CCDM/usage-stats/history.sqlite3` by default (override with the ignored config's `history_db_path`). The database and lock are private (`0700` directory, `0600` files), snapshots are retained for 365 days, and an advisory lock makes repeated LaunchAgent runs idempotent. History begins at the earliest actual stored snapshot; no artificial history is backfilled. Only feature-owned SQLite files count toward the 5 GiB warning; Codex session logs and Claude transcripts are never counted or deleted. A warning is emitted at most once every 24 hours while the feature-owned history directory remains over the limit.

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

Each automated Discord post sends only the original text Usage Report embed. Codex is displayed as a weekly allowance only. Claude API-key accounts have no comparable percentage limit, so their embed text shows sanitized local estimated Today and This month costs, request counts, and status. The credential-free trend renderer (`scripts/usage-dashboard-renderer.py`) is retained for back-compat but is no longer invoked by the posting workflow.

The poster reads the same named-account registry configuration shown in
[Codex Accounts](#codex-accounts); it does not need a separate list of Codex
Homes. Aliases that resolve to the same Codex Home are reported only once.
Older registries without `codex_accounts` remain supported: top-level and
project-level raw `codex_home` paths are discovered as **Legacy Codex Home**
entries. Direct `~/.codex` and `~/.codex-api` session paths are legacy
compatibility examples, not the recommended configuration.

Claude OAuth accounts are discovered from the default `~/.claude` login and
valid extra `~/.claude-*` config directories. The report labels them by
directory: `~/.claude` is **claude-p** and `~/.claude-<name>` is
**claude-<name>** (for example **claude-af**). Each extra directory must have a
`.claude.json` with an `oauthAccount`, which also records the email the home is
logged in to. Its Keychain service is derived from the first eight hex
characters of the SHA-256 hash of the config-directory path. The plain
`Claude Code-credentials` item holds whichever account a session without
`CLAUDE_CONFIG_DIR` last logged in to, so it can belong to any home. The poster
therefore tries a home's hashed item and the plain item, freshest first, and
reports only a login whose profile email matches that home's `.claude.json`;
when none matches it shows that home's re-login command instead of another
account's usage. No account names or local paths are hardcoded in the poster.

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

Guest management and the usage poster read `DISCORD_BOT_TOKEN` from the root bot’s `.env` at `~/.claude/channels/discord/.env`. Set `ROOT_DISCORD_STATE_DIR` to select a different root state directory (also set it in the poster LaunchAgent environment when applicable). They never borrow a project bot token or infer root from `bot1`; the old poster `root_bot_id` pool selector is no longer used. Missing root credentials cause an error before Discord requests. Project launches derive root’s identity from that state, with an explicit `root_bot_app_id` registry fallback, and do not pass management credentials to project bridges. Message exports require explicit credentials or a bot registered for the requested channel.

Configuration stays in the ignored root `.usage-stats-poster.json`. Start from the tracked placeholder example, edit the destination channel and any Claude API-account transcript paths, then validate it:

```bash
cp .usage-stats-poster.example.json .usage-stats-poster.json
python3 scripts/usage-stats-poster.py --validate-config
```

Run a live legacy JSON-embed post separately after validation; installation never triggers this command:

```bash
python3 scripts/usage-stats-poster.py
```

Configured Codex Homes that carry the `ccdm-deepseek.json` setup marker are reported from DeepSeek instead of the Codex rate-limit request. The poster reads the home's private `api-key` directly, fetches the account-wide balance from the fixed official `GET /user/balance` endpoint on `https://api.deepseek.com` (one request per distinct key per run), and pairs it with this month's local DeepSeek token totals from the DeepSeek session rollouts. The embed shows a compact `deepseek-flash (API)` block: a bold remaining balance, a paid/granted breakdown, this month's local token total and session count, an optional `Tokens:` split line, and a short `Balance: whole account · Usage: local Codex` footer instead of a technical coverage paragraph. No money history or spend figure is derived from the balance. A DeepSeek-backed root Codex session still runs through the Codex app-server; only this rate-limit query is skipped. Homes sharing a key are grouped under one labeled note, and a rollout copied between them is counted once; distinct keys stay separate because no account identifier is available. Reference: [Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/).

Coverage is this machine's local Codex sessions in the configured DeepSeek homes only. Other clients, other machines, ephemeral workers, and deleted rollouts are excluded, so the block never claims a provider-wide total. The API reports an account balance rather than spend or quota, so the balance is account-wide while the token totals stay local; responses that do not match DeepSeek's documented balance schema are reported as unavailable instead of shown.

For local tests only, `deepseek_base_url` may point at a literal `http://127.0.0.1:<port>` (or `localhost`/`[::1]`) fake; any other origin is refused at both config and request time.

Without a configured reference the block shows the real amounts only and never invents a percentage or bar. An optional `deepseek_balance_references` object in `.usage-stats-poster.json` supplies a per-alias display budget for an inline meter whose filled portion represents used balance, labeled with both percent used and percent left:

```json
{
  "deepseek_balance_references": {
    "deepseek-flash": { "currency": "USD", "amount": "50.00" }
  }
}
```

Each entry is a self-contained `{currency, amount}` pair: `currency` must be `USD` or `CNY`, and `amount` a positive decimal string. Extra fields, floats, zero, and negative values are rejected when the config is validated. A reference is a display budget, not a provider quota, so the poster never infers a top-up or deposit total from the current balance; a balance above the reference prints its honest percentage while the bar visually clamps. When a shared-key group is covered by more than one conflicting alias reference, the meter is omitted with a clear status line and both the real balance and the local usage are still shown.

To exercise the scheduled report manually, use `--scheduled --post-now`; `--collect-only` records a snapshot without contacting Discord. Scheduled runs outside a UTC 30-minute window collect history but do not post the text report.

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
    resolve-conversation.py  # Maps a channel or thread id to its project and thread
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
