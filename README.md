# CCDM — Claude Code Discord Manager

Manage multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and Codex sessions from Discord through **one bot**. A local **Router** holds that bot's token and connects each project channel to the one session serving it.

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

## How It Works

The **Router** (`scripts/router.js`) is a local daemon supervised by launchd. It is the only CCDM component that holds a Discord bot credential: the root bot token. It receives every Discord event and delivers each message to the one session serving that channel. It also performs Discord actions (replies, edits, reactions, typing, reads, attachment downloads) on a session's behalf. Sessions talk to it over a private Unix socket with a per-launch key and never see a Discord token.

The root agent is a Claude Code or Codex session that is itself a Router client. When you message it in `#root`, it can:

- **Register projects** to Discord channels (it creates the channel and the project's webhook)
- **Deregister projects** (it deletes the webhook and the registry entry; the channel stays)
- **Start/stop/restart** Claude Code and Codex sessions for registered projects
- **Report context usage** across all running sessions
- **Show rate limits and usage stats** with visual progress bars
- **Restart itself** without manual intervention
- **Transcribe voice messages** using Whisper

Each project has its own channel, its own session, and its own **Project Identity**: a per-channel webhook `ccdm-<project>` whose messages post as `<project>-<claude|codex> · N%`, with live context usage in the name. You chat with each project in its own channel, no `@mention` needed. The root agent listens in `#root` without `@mention`, and `@mentioning` the bot in a project channel reaches root only, never the project.

Each session has a **Session Scope**: the one channel it may read and act in. The Router rejects anything outside it with `scope_violation` and logs the attempt. A new launch writes a new key, which disconnects the previous listener, so two sessions never answer the same channel. Messages to a channel with no live session get 💤 and are not replayed later (a project not yet migrated, with no `webhook_id`, gets no 💤).

> **Windows:** the sections below describe macOS and Linux. To set up CCDM on a Windows PC, follow [Running on Windows](#running-on-windows).

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Yes | See docs |
| `tmux` | Yes | `brew install tmux` / `apt install tmux` |
| `zsh` | Yes | Default on macOS / `apt install zsh` on Linux |
| `python3` | Yes | `brew install python3` / `apt install python3` |
| Node.js 22.5+ | Yes | `brew install node`, then `npm install` in this repo (the Router, channel server, and Codex bridge) |
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

Before selecting the home on a project, test it in a disposable directory:

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
inference calls; test the home separately before selecting it on a project.

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

You also need:
- A Discord account
- A Discord server where you can add bots
- One Discord bot for root — see [Creating the root bot](#creating-the-root-bot)

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

The setup script will:
1. Check that all prerequisites are installed
2. Ask for your Discord user ID and server ID
3. Create `registry.json` with the one-bot fields (`root_channels`, `root_allowed_user_ids`, `projects`, and the Codex account fields)
4. Ask for the root bot's token and write it to `~/.claude/channels/discord/.env`, the only place it is stored
5. Print the remaining steps: add your root channel, install the Router, and start root

Then message root in your root channel to start managing projects!

## Manual Setup

If you prefer to set things up by hand:

1. **Copy the registry template:**
   ```bash
   cp registry.example.json registry.json
   ```

2. **Edit `registry.json`** — fill in your Discord user ID, server ID, and root channel, and replace the example project with `"projects": {}`:
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
   To find your Discord user ID: Settings > Advanced > enable Developer Mode, then right-click your name > Copy User ID. For the server ID, right-click the server name > Copy Server ID; for a channel ID, right-click the channel > Copy Channel ID.

   - `root_channels` are the channels where root listens without an `@mention`. The first is the primary root channel.
   - `root_allowed_user_ids` are extra users (besides you, the owner) who may talk to root there. Channel guests can never reach root.
   - `category_ids` are the CCDM-managed categories that guest roles are denied on.
   - Each project entry gets its `webhook_id` from `scripts/router.js ensure-webhook <project>`, which registration runs. The registry never holds a bot or webhook token.

3. **Store the root bot token** (the only token CCDM uses):
   ```bash
   mkdir -p ~/.claude/channels/discord
   (umask 077; echo "DISCORD_BOT_TOKEN=your_token_here" > ~/.claude/channels/discord/.env)
   ```
   `ROOT_DISCORD_STATE_DIR` selects a different directory. The Router, guest management, message exports, and the usage poster all read the token from here.

4. **Install the Router** — see [The Router](#the-router):
   ```bash
   scripts/install-router-service.sh
   node scripts/router.js status
   ```

5. **Start the root agent:**
   ```bash
   ./restart-root-agent.sh
   ```
   This launches root Claude as a Router client: the CCDM channel server (`scripts/ccdm-channel-server.js`) in the root role, with root's own Router key and no Discord token. It accepts the per-launch development-channel confirmation and succeeds only once root has connected to the Router.

   To run the root bot through Codex instead:
   ```bash
   ./restart-root-codex-agent.sh [channel_id]
   ```
   Root Codex runs `scripts/codex-bridge.js` in root mode as a Router client. The selected channel must be in `root_channels` (omit it when there is only one); allowed users are the owner and `root_allowed_user_ids`. The script checks this before stopping the current root agent. `restart-root-agent.sh` switches back to Claude.

   An older install that kept root's channels in root's `access.json` can move them into the registry once with `node scripts/router.js migrate-root-config`.

## Commands

Message the root agent on Discord with any of these:

| Command | Description |
|---------|-------------|
| `list` / `status` | Show all registered projects and their status |
| `start <project>` | Start a project's Claude Code or Codex session |
| `stop <project>` | Stop a project's session |
| `restart <project>` | Restart a project's session |
| `register` / `setup` | Register a project to a channel (interactive — asks for channel, path, and provider) |
| `deregister` / `remove` / `unregister` | Deregister a project: stop it, delete its webhook and registry entry (the channel stays) |
| `router status` | Show the Router's gateway state, connected sessions and scopes, webhook health, and recent scope violations |
| `guest invite <project> <user_id>` | Create a project-scoped guest invite |
| `guest revoke <project> <user_id>` | Remove project guest access |
| `context report` | Get context window usage for all running sessions (via tmux) |
| `usage` / `limits` | Show rate limits, usage stats, and account info |
| `restart yourself` | Self-restart the root agent |
| `create a poll` | Create a native Discord poll in any channel |

In a project channel, these plain commands are handled by that project's session for both Claude and Codex, never as an agent turn:

| Command | Description |
|---------|-------------|
| `/pause` / `/unpause` | Queue new messages without interrupting the active turn, then deliver them in order |
| `/compact` / `/clear` | Compact or clear that project's conversation |
| `/restart` | Restart that project's session only (never root) |
| `/close` | End Conversation Reminders for the channel; it reaches only the reminder service |
| `/model` | Show the model, thinking level and account/home the channel's session runs with; the Thread Supervisor answers it (in a root channel, root does), with no agent turn |

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

### Resuming a Claude conversation

Claude launches take the same explicit resume, with the Claude session UUID
(the registry's recorded `session_id`, or the transcript's file name):

```bash
scripts/stop-session.sh my-project
scripts/start-session.sh my-project --resume <session_id>
```

The transcript must exist in the Claude home the project launches with
(`claude_home`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`) at
`projects/<project path with each non-alphanumeric character as ->/<session_id>.jsonl`;
a missing transcript, a non-UUID, or an already running session is refused
before anything starts. A resume launch that fails to reach the Router cleans up
and exits non-zero instead of starting a fresh conversation.

### Registering a New Project

Once the root agent and the Router are running, message root in `#root`:

```
register
```

The root agent will ask you:
1. **Which channel?** — provide a channel name or ID (it can also create one)
2. **Project path?** — the local directory for the project
3. **Claude or Codex?**

Then it:
1. Creates or resolves the channel with the root bot's credentials
2. Writes the project entry (`path`, `screen_name`, `channel_id`, `type`)
3. Runs `scripts/router.js ensure-webhook <project>`, which finds or creates the `ccdm-<project>` webhook, records `webhook_id` in the registry, and keeps the webhook token only in private Router state
4. Issues a fresh Conversation Reminder assignment
5. Starts the session

There is no bot to create, assign, or rename. The Router reloads `registry.json` on change, so the new channel is routed without restarting anything.

Deregistering stops the session, runs `scripts/router.js delete-webhook <project>` (deleting the webhook and its token and clearing `webhook_id`; a rerun is a no-op), removes the registry entry, and retires the project's reminders. The Discord channel is not deleted.

If a project's webhook is deleted in Discord, the Router recreates it once on the next reply and updates `webhook_id`. A second deletion in a row fails replies with `webhook_deleted` until `ensure-webhook` runs again.

### Session Scope

The Router enforces each session's scope on every operation:
- A project session may read, post, edit, react, and type only in its registered channel, and `message_id` targets must belong to that channel. Anything else is rejected with `scope_violation` and logged; `router status` lists recent violations.
- A project's replies post through its own webhook and it may edit only its own webhook messages. Reactions and typing show as the root bot.
- The root session may act in root channels and every registered project channel.
- Only messages and reactions from the owner (`discord_user_id`) and that channel's guests are forwarded. Bot and webhook messages are never forwarded to sessions.
- An `@mention` of the bot in a project channel, or a native reply to a root message, reaches root only. A reply to a project's webhook message goes to the project. Guests' mentions reach no one.

Discord permissions are no longer the isolation boundary: the old `project-bot` role and per-channel override model is obsolete. The root bot needs Send Messages, Read Message History, Add Reactions, and Manage Messages in every project channel, plus Manage Webhooks; `router status` names any that are missing.

### Project Guests

To invite someone into one project channel only, run:

```sh
scripts/guest-access.js invite <project-or-channel-id> <discord-user-id>
```

This creates a one-use invite and a per-project `ccdm-guest-<project>` role. The role is denied on CCDM-managed categories and other project channels, then allowed on the target channel with text, message history, attachments, reactions, and thread replies. The guest user ID is recorded in the project's `guest_user_ids`. The Router reloads guests from `registry.json`, so the guest reaches the project session on their next message without a restart. Guests can never reach root.

For users already in the server, use `grant` instead of `invite`. Use `revoke` to remove their project guest role, registry entry, and outstanding invites.

## Thread Conversations

Open a public thread under a registered project channel and type a task: it becomes a **Thread Conversation**, a fresh Claude Code or Codex conversation for that project, running in the project checkout. The Router scopes it to that thread alone, so the Channel Conversation and sibling threads never see its traffic. Replies post into the thread through the project's webhook as `<project>-<provider> · N%`. The owner and the channel's guests drive threads without an @mention. Full details are in [docs/thread-supervisor.md](docs/thread-supervisor.md).

- **Create** by hand, with `/thread <name> [--provider claude|codex] [--account <alias>] [--model <model>] [--effort <effort>] [first message…]` in the project channel, from the channel agent's `create_thread` tool, or with `scripts/threads.sh create <project> <name> [flags] [message]`. Created threads auto-archive after a week.
- **In a thread:**
  - `/config` shows or changes the thread's provider, account, model and effort. A provider or account change applies only after your ✅.
  - `/model` shows the model, thinking level and account/home the thread runs with.
  - `/restart` resumes the conversation, and `/clear` starts a fresh one.
  - `/compact`, `/pause` and `/unpause` work as in a channel.
  - `/close` archives the thread, stops its session and closes its reminders.
- **Lifecycle:** your archive, root's archive or `/close` closes the conversation. Discord's inactivity auto-archive only stops the session. Your next message resumes the same conversation, and only your message reopens a closed one.
- **Capacity:** live thread sessions are capped per provider by the registry's `thread_session_caps` (default `{"claude": 6, "codex": 8}`). At the cap the longest-idle session is paused, or the new one is queued.
- **Accounts:** a thread may use an alias from `codex_accounts`, or from the new `claude_accounts` map (alias → Claude home).
- **Operate:**
  - `scripts/threads.sh list|stop|restart|close` takes a thread name, link or id.
  - `scripts/stop-session.sh <project> --threads` stops only the thread sessions, and `--all` stops the channel too. A plain `stop-session.sh <project>`, or a channel restart, leaves threads alone.
  - `node scripts/router.js status` lists thread sessions and the supervisor.

**Install the Thread Supervisor**, the separate service that starts, stops and resumes thread sessions. It holds no Discord credential:

```bash
scripts/install-thread-supervisor.sh      # read-only preflight, then the com.ccdm.thread-supervisor LaunchAgent
scripts/thread-supervisor.py status        # worker, caps and bound threads
```

Root needs four extra permissions, granted once by hand: Create Public Threads, Send Messages in Threads and Manage Threads in the project channels, and View Audit Log on the guild. `router status` reports any that are missing while threads are enabled. The post-merge live smoke steps are in the [operator checklist](docs/thread-supervisor.md#operator-checklist).

## Creating the root bot

CCDM needs exactly one Discord bot application, used by root and the Router.

1. **Create an application**: Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.

2. **Set up the bot**: In the sidebar, go to **Bot**. Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this, the bot receives messages with empty content.

3. **Copy the token**: On the **Bot** page, click **Reset Token** and copy it immediately — it's only shown once. `setup.sh` stores it in root's state directory; never put it in `registry.json`.

4. **Generate an invite link**: Go to **OAuth2** > **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:
   - View Channels, Send Messages, Send Messages in Threads, Read Message History
   - Attach Files, Add Reactions, Manage Messages
   - Manage Webhooks (Project Identity webhooks)
   - Manage Channels, Manage Roles, Create Instant Invite (registration and guest access)
   - Create Public Threads, Manage Threads, View Audit Log (Thread Conversations)

   Set Integration type to **Guild Install**. Copy the generated URL.

5. **Invite the bot**: Open the URL in a browser and add the bot to your Discord server.

## The Router

The Router is a Node daemon (`scripts/router.js serve`, modules in `scripts/router/`) with one discord.js gateway connection. Its private state lives in `~/.local/state/ccdm/router/` (0700; `CCDM_ROUTER_STATE_DIR` overrides it): the socket `router.sock` (0600), per-session keys, webhook tokens, launch files, and logs.

**Install it** as the `com.ccdm.router` LaunchAgent:

```bash
scripts/install-router-service.sh
```

The installer first runs the read-only `node scripts/router.js preflight` (Node 22+, registry with `discord_user_id`, root token present, socket directory ownership and 0700 mode) and touches nothing if a blocker remains. It then renders a secret-free plist with private logs (`router.log` and `router.err` in the state directory), relaunches the Router only after a crash, and restores the prior plist and loaded service if the new load fails. Foreground and supervised Routers share one lock, so a second `router.js serve` exits non-zero without disturbing the running one.

**Check it** with `router status`:

```bash
node scripts/router.js status         # human-readable
node scripts/router.js status --json  # for scripts
```

It reports the gateway state, the registry's last good load time and any load error, connected sessions with role, project, scope, and connect time, webhook presence and root's missing channel permissions per project, and recent scope violations. It exits non-zero when the Router is unreachable.

**Admin commands** (run by root's register and deregister workflows):

| Command | What it does |
|---------|-------------|
| `node scripts/router.js ensure-webhook <project>` | Find or create `ccdm-<project>` in the project's channel and record its `webhook_id` |
| `node scripts/router.js delete-webhook <project>` | Delete the project's webhook and its private token and clear `webhook_id` |
| `node scripts/router.js probe <project>` | Post one short connection notice through the project's webhook and check Discord returned the expected `webhook_id` |
| `node scripts/router.js migrate-root-config` | Copy root channels and users from root's legacy `access.json` into the registry, once |

**Registry reloads**: the Router watches `registry.json` and applies guest, channel, and project changes to the next message. An invalid registry (malformed JSON, or valid JSON with a missing owner, a non-object `projects`, a project without `channel_id`, or one channel claimed twice) keeps the last good routing table without disconnecting any session, and `router status` shows the error.

**Router down**: launchd restarts a crashed Router, and every session reconnects on its own with capped backoff. While disconnected, Discord operations fail with `router_unavailable` instead of queueing. If the Router stays unreachable for about 2 minutes (`CCDM_ROOT_FALLBACK_AFTER_MS`, default 120000), root opens an **emergency** direct gateway connection with the root token for root channels only (owner and `root_allowed_user_ids`), and posts a one-line notice in the primary root channel, so you can diagnose and restart the Router from Discord. While it is engaged, root replies, reacts, types, and edits its own messages in root channels directly as the bot; reads and attachments wait for the Router. When the Router is back, root stops those direct operations and closes the emergency connection before reconnecting, so both paths never deliver at once. `restart-root-agent.sh` and `restart-root-codex-agent.sh` refuse to run while the Router is not answering, so a restart never takes down the emergency root.

**Rate limits** stop at the Router: it queues REST per route bucket, honors `Retry-After`, and coalesces repeated edits to one message. Sessions see eventual success or a typed `rate_limited` failure.

### Cutover and retirement

These tools move an existing Bot Pool install to the Router, and are kept for installs that still have pool fields in `registry.json`. A project launch now requires the project's `webhook_id`: `start-session.sh` and `start-codex-session.sh` refuse a project without one before writing a key, starting tmux, or recording a PID, and point at `migrate-to-router.sh`. Do the cutover in this order:

1. **Stop every pool session.** Run `scripts/stop-session.sh <project>` for each project. While a project still names its former pool bot (`bot_id`), the stop also sweeps that bot's leftover official-plugin listener by its `DISCORD_STATE_DIR`.
2. **Move root's configuration.** Run `node scripts/router.js migrate-root-config` once, install the Router with `scripts/install-router-service.sh`, check `node scripts/router.js status`, and restart root with `./restart-root-agent.sh` (or `./restart-root-codex-agent.sh`).
3. **Migrate each project.** Run `scripts/migrate-to-router.sh <project>` per project (details below). It records the webhook and starts the session on the Router.
4. **Retire the pool.** Run `scripts/retire-pool.sh` (a dry run), review it, then `scripts/retire-pool.sh --apply`.

`scripts/migrate-to-router.sh <project>` records one project on the Router. It checks that the Router is healthy, the project is registered and not yet on the Router, and root has its channel permissions. It then stops the session (including a leftover pool listener), runs `ensure-webhook`, records the project on the Router, issues the reminder `assignment-changed`, starts the session through its launcher, and verifies the round trip: `router status` shows it connected in its channel, and `router.js probe <project>` posts a notice under the project's `webhook_id`. Each step prints `<step>: ok` or `<step>: failed — <reason>`. A preflight failure changes nothing, and any later failure restores the project's previous registry state, restarts its session, and exits non-zero naming the failed step. `--rollback` refuses, since no pool bot remains to return to. The script runs `node` unless `CCDM_ROUTER_NODE` names another binary.

`scripts/migrate-to-router.sh --resume <project>` also keeps the conversation. Before the stop step (which clears `pid` and `session_id`) it prints `resume: <id> (<source>)` or `resume: skipped — <reason>`, and the start step, and a rollback's start, pass that id to the launcher's `--resume`. For Claude the id is the running session's own `sessionId` from `<claude home>/sessions/<pid>.json`, else the registry's `session_id`, and its transcript must exist in the project's Claude home. Codex launches record no thread id (`session_id` stays `null`), so the id is the newest `codex-discord-bridge` rollout (not a subagent's) whose `cwd` is the project directory in the project's resolved Codex home, skipped when another Codex project or the CCDM checkout shares that directory. Without an id or transcript/rollout, or when the launcher cannot resume it, the project starts fresh and the migration continues. Because the step-1 stop clears `session_id`, run `--resume` on projects that are still running (the migration stops them itself).

`scripts/retire-pool.sh` removes what is left of a Bot Pool. It refuses (naming the projects) while any project still tied to a pool bot (by `bot_id`, `bot_display_name`, or a pool entry's `assigned_to`) lacks `transport: "router"`; a project registered after the cutover needs no `transport`. By default it is a dry run that prints each action and changes nothing. With `--apply` it uses the root token to remove every old pool bot from the server and moves their state directories (`~/...` paths included) into a private backup at `~/.local/state/ccdm/pool-retirement/` (0700; `CCDM_POOL_BACKUP_DIR` overrides it). It also deletes the obsolete `project-bot` role, saves a 0600 copy of the registry in the backup, and strips the pool fields from `registry.json`. Bot applications are kept. A state directory it cannot move (none recorded, not an absolute path, or missing) is reported as skipped, and `--apply` then exits 2 with the list instead of claiming success. An interrupted `--apply` finishes the remaining work when rerun, and a rerun after retirement does nothing.

Every registry rewrite (the lifecycle scripts, webhook recreation, migration, retirement, guest access, and reminder reassignment) holds one lock, a `registry.json.lock` directory beside the registry, and commits through an adjacent temporary file renamed into place with the registry's mode kept, so concurrent writers never drop each other's changes and the Router's reload never reads a partial file. A lock left by a writer that died is reclaimed; a writer waits up to 30 s for a live holder (`CCDM_REGISTRY_LOCK_TIMEOUT_MS`) and then fails naming its pid.

## Usage Report

CCDM includes a usage reporting script (`scripts/claude-usage.sh`) that shows:

- **Live data** (macOS only): Account profile, 5-hour session limits, 7-day limits, extra usage billing
- **Local data** (all platforms): Lifetime stats, monthly breakdowns, top projects, busiest days, streaks

The live data section uses the macOS Keychain to retrieve your Claude Code OAuth token. On Linux, this section gracefully skips and local stats still work.

Ask the root agent for a usage report by messaging `usage`, `limits`, or `how much usage left`.

## Project Conversation state

The opt-in foreground [Project Conversation state service](docs/conversation-reminders.md) records owner replies, `/close`, reopening, and due times for registered Claude and Codex channels. It watches every project channel as a read-only Router client and sends a `👀` as the root bot one hour after a conversation starts awaiting the owner; while reminders are ignored, the gap grows to 2, 4, 6 … hours and settles at one a day. Run `scripts/conversation-reminder-service.py enable` to check prerequisites and opt in, then `run` to start the worker. On macOS, `scripts/install-conversation-reminder-service.sh` can supervise the same worker as an opt-in LaunchAgent. It validates configuration first and keeps credentials out of the plist. It never changes the Usage Stats Poster. After a restart, reconnect, or re-enable, the service reconciles missed activity before sending. Each overdue channel then gets at most one catch-up, spaced at least five seconds apart.

## Scheduled Usage Stats Poster

A separate, opt-in macOS LaunchAgent can post usage stats to Discord on a schedule. It is not installed by `setup.sh` and it is not the old tmux-based `usage-report-loop.sh` flow.

The tracked installer requires Python 3 only, then renders and validates `~/Library/LaunchAgents/com.discord.usage-stats-poster.plist` with absolute paths to Python, Codex, the poster, and its logs. Pillow is not required: the scheduled and manual poster output is text-only, so installation never probes for image libraries, and a missing `python3` exits before touching LaunchAgents or the existing plist. The separate `scripts/usage-dashboard-renderer.py` trend renderer keeps Pillow as an optional dependency when it is invoked manually. The LaunchAgent is interval-only and runs every 600 seconds, so installation does not trigger an immediate post. Every automated run records a local structured snapshot in UTC 10-minute slots; the original text Usage Report is posted on its own only once per UTC 30-minute slot. Any run inside the slot posts if the ledger has no post for it yet, so a run skipped during sleep or a Discord request that never reached Discord is retried by the next run in the same slot. If Discord received the request but its reply was lost (timeout or dropped connection), the slot is recorded as posted to avoid a duplicate report. No trend or balance PNG is rendered or attached by the scheduled or manual output. Manual JSON-embed invocations remain independent of the history database. Reinstalling unloads the existing label before loading the new plist, so changing the interval is idempotent; if the new load fails, the prior plist and loaded/unloaded schedule are restored:

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

Guest management, message exports, and the usage poster read `DISCORD_BOT_TOKEN` from the root bot’s `.env` at `~/.claude/channels/discord/.env`. Set `ROOT_DISCORD_STATE_DIR` to select a different root state directory (also set it in the poster LaunchAgent environment when applicable). Missing root credentials cause an error before Discord requests. Project sessions never receive a Discord token; they export history only through the Router's `export_message_range` operation, while the operator-run `scripts/export-discord-range.js` reads the root token.

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

To exercise the scheduled report manually, use `--scheduled` (`--post-now` is a compatibility alias); `--collect-only` records a snapshot without contacting Discord. Scheduled runs whose UTC 30-minute slot is already in the posts ledger collect history but do not post the text report again.

To roll back the schedule, unload and remove only CCDM's rendered LaunchAgent. Keep the older external poster directory and its LaunchAgent available until the replacement has been verified; deleting that external rollback copy is out of scope.

```bash
launchctl unload ~/Library/LaunchAgents/com.discord.usage-stats-poster.plist
rm ~/Library/LaunchAgents/com.discord.usage-stats-poster.plist
```

## Context Usage in the Project Identity

Each project reply posts as `<project>-<claude|codex> · N%`, where `N` is the session's context window usage at send time. No bot nickname is changed.

- **Codex** sessions report `N` from the bridge's tracked token usage.
- **Claude** sessions report it through Claude Code's `statusLine` setting: the status script writes the latest percentage to a private file in the project's Router launch directory, and the CCDM channel server sends it with each reply.

Add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "/path/to/ccdm/scripts/cc-discord-nicknames.sh",
  "padding": 0
}
```

| Script | What it does |
|--------|-------------|
| `scripts/cc-discord-nicknames.sh` | Records the context percentage only — no terminal UI dependency |
| `scripts/cc-statusline-wrapper.sh` | Records the percentage AND pipes through [ccstatusline](https://github.com/sirmalloc/ccstatusline) for a terminal status bar |

`scripts/statusline-context.js` does the same recording in Node, with no bash or `jq`, so use it on Windows. It prints nothing by itself. To keep a status bar, pass that bar's existing command with `--chain`: it gets the same input, and its output is shown. Write Windows paths with forward slashes:

```json
"statusLine": {
  "type": "command",
  "command": "node 'C:/path/to/ccdm/scripts/statusline-context.js' --chain 'npx -y ccstatusline@latest'",
  "padding": 0
}
```

The chained command runs in `/bin/sh` on macOS and Linux. On Windows it runs in Git Bash when installed, otherwise in PowerShell.

All of these scripts use the `CCDM_ROUTER_KEY_FILE` that CCDM sets for its Claude sessions, and do nothing in other Claude sessions. When no percentage is available, replies post as `<project>-claude` with no suffix. Discord rejects webhook names containing `discord` or `clyde`, so the Router breaks those substrings with a zero-width joiner and truncates the project name first so the ` · N%` suffix survives the 80-character limit.

## Preventing Sleep

CCDM needs your machine to stay awake — if it sleeps, the Router and all tmux sessions go offline.

**macOS:**
- Install [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704) (free) and set it to keep the Mac awake indefinitely
- Or use the built-in command: `caffeinate -s` (keeps the system awake while the command runs)
- Or disable sleep entirely: `sudo pmset -a disablesleep 1` (undo with `sudo pmset -a disablesleep 0`)

**Linux:**
- `systemd-inhibit --what=idle sleep infinity` (prevents idle sleep while running)
- Or configure via `systemctl mask sleep.target suspend.target`

## Auto-Start on Reboot (macOS)

The Router's `com.ccdm.router` LaunchAgent (see [The Router](#the-router)) starts on login by itself. tmux sessions don't survive reboots, so set up a macOS Launch Agent to start the root agent on login too:

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

If tmux Continuum or Resurrect also restores sessions at login, add this to
`~/.tmux.conf` before the plugin loader:

```tmux
# Keep session restoration from replacing an agent already started by launchd.
set -g @resurrect-never-overwrite 'on'
```

Apply it to an already-running tmux server with
`tmux set-option -g @resurrect-never-overwrite on`. Resurrect otherwise treats a
server with only one pane as a restore from scratch and can replace that pane
with a saved shell, stopping a newly started root agent. Restoring saved pane
contents does not restart the agent process.

This LaunchAgent launches a detached tmux session once; it does not supervise
the bridge after startup. A successful launchd exit therefore does not prove
root is still connected. Check `node scripts/router.js status` for a live root
listener when Discord is online but messages receive 💤.

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
7. On every other category of the server, add the bot and deny it View Channel. The bot then sees only its own category.
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

Root asks for the channel, the project folder and the provider. Give this PC's projects a name that ends in `-win`, for example `my-app-win`. The project's channel must be inside the Windows category, because the bot sees no other.

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
- **Mentions.** Each bot sees only its own category. An `@mention` reaches only the bot that can see the channel. Mentioning the Mac's bot in a Windows channel does nothing, and the other way round.
- **Resume.** A conversation is stored on the machine that ran it. `--resume` works only on that machine. You cannot continue a Mac conversation on Windows, or a Windows conversation on the Mac.
- **Each machine works alone.** One machine keeps working while the other sleeps or is off. You set up, upgrade and restart each one by itself.
- **Usage.** Both machines can use the same accounts. Only the Mac posts the usage report; Windows only collects.
- **What the Windows bot can still do in the server.** Whatever `@everyone` may do, and read the audit log.

## Security Note

CCDM uses the `--dangerously-skip-permissions` flag when starting Claude Code sessions. This is necessary because automated bot sessions cannot interactively confirm permission prompts.

This means Claude Code will have unrestricted access to the file system and shell within each project directory. Only run CCDM on machines you trust, and be mindful of what projects you connect.

Discord access is contained by the Router instead: the root bot token lives only in root's state directory and the Router, webhook tokens live only in private Router state (0600), and no session environment, file, or MCP config holds a Discord token. Session Scope is software-enforced by the Router, not an OS sandbox: local sessions run as your user, so keep the Router state directory private.

## Global Skills

CCDM includes reusable skills (custom slash commands) that any Claude Code agent can use. Copy them to `~/.claude/commands/` on any machine to make them available globally.

| Skill | File | Description |
|-------|------|-------------|
| `/restart-self` | `skills/restart-self.md` | Agent restarts its own session. It tells the user first, then runs the one `scripts/ccdm` command for its kind of session: `restart-session` for a project, `threads restart` for a thread, `restart-root` for root. It works for Claude and Codex sessions, on macOS and Windows |
| `/check-context` | `skills/check-context.md` | Agent reports its own context window usage. It reads the percentage from its launch record (`context.json`). A Claude session can also type `/context` into itself for the breakdown by category |

### Installing skills

**On your local machine (all agents get them automatically):**

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

**On a remote VM:**
```bash
mkdir -p ~/.claude/commands
# Copy each .md file, or tell the running agent to save them
```

Or just send the files to the agent on Discord and ask it to save them to `~/.claude/commands/`.

## Remote VM Sessions

Remote VM sessions are not supported with the Router yet: a remote session would need its own connection to the local Router ([#125](https://github.com/deepansh96/ccdm/issues/125)). Deregister unused VM projects rather than giving a VM a Discord token.

## File Structure

```
ccdm/
  CLAUDE.md                  # Agent instructions (read by Claude Code)
  README.md                  # This file
  LICENSE                    # MIT
  .gitignore                 # Excludes registry.json, .claude/, .env
  registry.example.json      # Template — copy to registry.json
  registry.json              # Your config (not committed; holds no tokens)
  restart-root-agent.sh      # Start or restart root Claude as a Router client
  restart-root-codex-agent.sh # Start or restart root Codex as a Router client
  setup.sh                   # Interactive first-run setup
  scripts/
    router.js                # The Router daemon and its CLI (status, preflight, webhooks, probe)
    router/                  # Router modules: socket server, client library, ops, webhooks, emergency fallback
    install-router-service.sh # Install the com.ccdm.router LaunchAgent
    ccdm-channel-server.js   # CCDM channel server for Claude sessions (project and root)
    codex-bridge.js          # Codex app-server bridge (project and root) in Router mode
    discord-mcp-server.js    # Scoped Discord tools for Codex, backed by the Router
    migrate-to-router.sh     # One-project cutover onto the Router
    retire-pool.sh           # Remove leftover pool bots, state, role, and registry fields
    guest-access.js          # Project-scoped guest invites, grants, and revokes
    _update-nickname.sh      # Shared statusline helper — records context %
    cc-discord-nicknames.sh  # StatusLine script — records context %
    cc-statusline-wrapper.sh # StatusLine script — context % + ccstatusline terminal UI
    claude-usage.sh          # Usage reporting script
    send-claude-command.sh   # Types /compact or /clear into a Claude tmux session
    start-session.sh         # Start a registered Claude project
    start-codex-session.sh   # Start a registered Codex project
    stop-session.sh          # Stop any registered project (--threads, --all)
    start-thread-session.sh  # Start one Thread Conversation (run by the Thread Supervisor)
    thread-supervisor.py     # The Thread Supervisor worker and CLI (run, status, enable, disable, preflight)
    install-thread-supervisor.sh # Install the com.ccdm.thread-supervisor LaunchAgent
    threads.sh               # List, create, stop, restart, or close Thread Conversations
  skills/
    restart-self.md          # /restart-self skill — agent self-restart
    check-context.md         # /check-context skill — context window usage check
```

## Troubleshooting

**Bot doesn't respond to messages**
- Run `node scripts/router.js status`: the Router must be reachable with its gateway ready, and the project's session connected in its channel
- A 💤 reaction means the channel has no live session — start it
- Ensure **Message Content Intent** is enabled in the Discord Developer Portal (Bot settings)
- Check the bot is in the same server as you, and your user ID is `discord_user_id` in `registry.json`
- In a root channel, check the channel is in `root_channels`
- Check the Router logs in `~/.local/state/ccdm/router/router.err`

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
- One session serves one project channel; a project cannot span channels
- Voice message transcription requires `whisper` (optional)
- Webhooks cannot send native replies, so a project's reply to a specific message starts with a `↪ [jump](…)` link
- The Router is a single point of failure, mitigated by launchd restarts, session reconnects, and root's emergency fallback
- Claude sessions load the CCDM channel with `--dangerously-load-development-channels`, a research preview that may change between Claude releases

## License

MIT — see [LICENSE](LICENSE)
