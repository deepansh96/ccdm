# Scope a Claude session to one Discord thread

Research for wayfinder ticket #80 (map #77), 2026-09-27. Plugin paths are relative to `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/`; CCDM paths are relative to the repo root. Statements marked *inference* are not directly quoted from a source.

## Summary

A per-thread proxy works. The existing launch-scoped proxy already drops inbound traffic and blocks tool calls for any `chat_id` other than the selected one, so selecting a thread id pins a Claude session to that thread. What blocks a second session on the same bot is CCDM's own identity model: launch artifacts, listener detection, PID/session records, stop sweeps, and the reminder capability marker are keyed by bot state dir or project. Excluding thread traffic from the Channel Conversation also requires the proxy, which today is opt-in and tied to the reminder feature.

## 1. The proxy route

**How it wraps the plugin today.** `scripts/claude-reminder-channel.js` is a stdio MCP relay that spawns the plugin as its child (`:70`, default `bun <CCDM_CLAUDE_PLUGIN_ROOT>/server.ts`, `:57-60`). Its header (`:4-5`): "The official Discord channel remains the only Gateway client; this process relays its stdio protocol to Claude Code."

`scripts/start-session.sh` enables it only when `CCDM_CLAUDE_REMINDER_ADAPTER=1` (`:293,299-302`):
- It registers an MCP server `discord` running `node claude-reminder-channel.js` (`:371-375`).
- It launches with `--dangerously-load-development-channels server:discord` and `--settings <state>/ccdm-conversation-reminder-hooks.json` (`:300-301`).
- Those settings disable the installed plugin with `enabledPlugins: {"discord@claude-plugins-official": false}` (`:378`).

**Each proxy instance opens its own Gateway connection**: the child calls `client.login(TOKEN)` (`server.ts:890`), with the token read from `DISCORD_STATE_DIR/.env` (`server.ts:37-53`).

**What it filters today.**
- **Inbound:** only `notifications/claude/channel` is filtered, dropped when `meta.chat_id !== selectedChannel` (`:191`). Everything else passes through (`:186-188`), including `notifications/claude/channel/permission`.
- **Tools:** `reply`, `react`, `edit_message` and `download_attachment` must target `chat_id === selectedChannel`, and `fetch_messages` must target the selected `channel`. Any other tool is blocked with "channel not assigned" (`:260-272`).
- A thread's `chat_id` is the thread id (`server.ts:824,873`), and the plugin's outbound check accepts a thread whose parent is allowlisted (`server.ts:403-413`). So setting `CCDM_CLAUDE_CHANNEL_ID=<thread id>` already scopes inbound and tools to that thread.

**What must change for thread sessions.**
- **Capability marker and assignment.**
  - The capability marker is written only when `resolveAssignmentForChannel(selectedChannel)` resolves a project (`:144-147`). A thread id doesn't resolve, so the marker is deleted (`:165`).
  - Owner activity and `/close` also resolve from `meta.chat_id` (`:194-198,236-240`). Reminders would therefore be inert in threads until thread ids map to their parent assignment.
  - The marker is per project, at `capabilities/<project>.json` (`:31`), and is removed on exit and on handshake (`:35-39,181`). Concurrent thread proxies would clobber the Channel Conversation's marker.
- **Per-state-dir launch files.** `ccdm-conversation-reminder-hooks.json`, `ccdm-conversation-reminder-env.json` (`start-session.sh:381,388`) and `ccdm-message-export-mcp.json` (`:292`) would be overwritten by a thread launch sharing the bot's state dir.
- **Read-only export MCP.** It is scoped by the `CHANNEL_ID` env (`start-session.sh:321`, `scripts/discord-mcp-server.js:227`). A thread session needs `CHANNEL_ID=<thread id>`.
- **Parent-channel reads.** A thread session cannot read its parent channel, because `fetch_messages` is pinned (`:263-266`). Reading the starter message needs an explicit read-only exception, or the bootstrap must carry it.

**Plugin behaviour that survives or leaks.**
- **Typing indicator.** The plugin sends it before the proxy sees the message (`server.ts:845-847`), so every instance whose gate passes types in the thread. The effect is cosmetic.
- **`ackReaction`.** It runs on the same pre-filter path (`server.ts:851-853`), but it isn't set in current project `access.json` files (keys: `dmPolicy`, `allowFrom`, `groups`, `pending`).
- **Permission text replies.** The `yes/no <id>` intercept runs in every plugin instance (`server.ts:830-842`). Request ids are random, so only the owning session acts on one (*inference*).
- **Permission DMs.** They go to all `allowFrom` users (`server.ts:504-512`), and every instance handles the button interaction (`server.ts:744-800`), so the instances race (*inference*; errors are swallowed). Sessions run with `--dangerously-skip-permissions` (`start-session.sh:406`), so this path is rare.
- **Pairing.** Not relevant: project `dmPolicy` is `allowlist`.
- **Attachment inbox.** Attachments go to `STATE_DIR/inbox` (`server.ts:64,424-426`), which is shared unless each thread gets its own state dir.

## 2. Several plugin processes on one token or state dir

**What the plugin writes in `DISCORD_STATE_DIR`:**
- `chmod` on `.env` (`server.ts:46`).
- `access.json`, written through a fixed `access.json.tmp` then renamed (`:195-201`). This happens on prune, pairing and resend (`:236-237,254,270`) and on corrupt-file rename (`:168`).
- The `approved/` directory, polled every 5 seconds (`:325-365`).
- `inbox/*` (`:424-426`).

**Concurrency risks.** There are no lock files, pid files or single-instance checks in `server.ts`. A shared dir still races on the tmp filename, sends duplicate "Paired!" DMs, and shares one inbox.

**The single-instance assumption is CCDM's:**
- `start-session.sh` refuses to start when a listener already uses the same `DISCORD_STATE_DIR` (`:284-290`), detected from `ps` (`:37-44,111`).
- `record_claude_pid` records the first matching process into `projects[project].pid/session_id` (`:190-191,218-219`).
- `stop-session.sh` sweeps by state-dir identity (`:53-119`).

**Per-thread state dirs work.** Each gets a symlinked `.env` and a generated `access.json` containing only the parent group; the gate maps a thread to its parent (`server.ts:278-282,409`). Listener identity uses exact normalized-path equality (`start-session.sh:42`), so nested thread dirs stay distinct. Don't pass the token through the environment: the proxy spawns the child with `env: process.env` (`:72`), and CCDM's `ps axeww` scan prints environments (`start-session.sh:30`).

**`DISCORD_ACCESS_MODE=static`.** It snapshots access at boot and never writes it (`server.ts:177-196`), and turns off pairing and the `approved/` poller (`:365`). That removes every state-dir race except the inbox.

**Gateway budget.** Discord allows 1000 IDENTIFY calls per 24 hours per token (https://docs.discord.com/developers/events/gateway). N thread sessions mean N+1 Gateway connections, each receiving all events.

## 3. A CCDM-owned channel server as an alternative

- **Contract.** Declare `capabilities.experimental['claude/channel']: {}` and emit `notifications/claude/channel` with `content` plus `meta` (a `Record<string,string>` whose keys are limited to letters, digits and underscores). Permission relay is optional, via `'claude/channel/permission'`. Source: https://code.claude.com/docs/en/channels-reference.
- **The plugin already fits this contract.** It declares both capabilities (`server.ts:437-451`), and the proxy checks for them (`claude-reminder-channel.js:171-172`).
- **Loading.** During the research preview, `--channels` accepts only allowlisted `plugin:` entries. Custom servers need `--dangerously-load-development-channels server:<name>`, which prompts for confirmation (https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/channels). Being in `.mcp.json` alone does not let a server push messages.
- **CCDM already runs on these terms.** Adapter mode is a `server:discord` development channel, and first-use consent needs an Enter keypress in tmux (`.mex/patterns/operate-conversation-reminders.md:37`, `docs/conversation-reminder-claude-adapter.md:16`).
- **Managed orgs.** `channelsEnabled` must be on for Team/Enterprise orgs. This matters for a work-account Claude home.

## 4. Launch mapping and resume

- **Registry to flags** (`start-session.sh:234-277`):
  - `model` becomes `--model`.
  - `claude_effort` is validated, then becomes `--effort`.
  - `claude_home` becomes `CLAUDE_CONFIG_DIR`.
  - The final command is at `:406`.
- **Plugin per home.** The adapter resolves the plugin under `<claude_home>/plugins/cache/claude-plugins-official/discord/0.0.4` (`:353-356`), so every per-thread account home needs the plugin installed.
- **No Claude resume path exists today.** `start-session.sh` has no `--resume`; only Codex does (`start-codex-session.sh:2,14`).
- **Session id.** It is read from `<claude_home>/sessions/<pid>.json` after launch (`:205-214`) and stored in `projects[project].session_id` (`:219`). Stop clears it (`.mex/context/session-management.md:56`).
- **Resuming a thread session.**
  - `claude --resume <id>` accepts a session id (https://code.claude.com/docs/en/cli-reference).
  - A thread therefore needs its session id kept outside the fields that stop clears, and it must relaunch with the same `CLAUDE_CONFIG_DIR` and cwd (*inference*: transcripts live under the config dir).
  - An account change would need a transcript copy, as the Codex rollout procedure does.
  - `--session-id` works only with `-p`.

## 5. Does the Channel Conversation receive thread messages today?

- **Plain mode (default): yes.** The gate keys threads on their parent (`server.ts:278-282`). Project groups use `requireMention: false`, so owner messages in any thread reach the channel session with `chat_id` set to the thread id, and the session can reply there (`:409`).
- **Adapter mode: no, with two leaks.** Inbound thread messages are dropped (`claude-reminder-channel.js:191`) and tools aimed at threads are blocked (`:260-272`). What still leaks:
  - the typing indicator in the thread (`server.ts:845`);
  - a `yes/no <id>` permission verdict typed in a thread, which still reaches the channel session (`server.ts:830-842`, passed through at `:186-188`).
- **Minimum change.** Always run Claude project sessions behind the filtering proxy, split from the reminder feature. Today the proxy runs only with `CCDM_CLAUDE_REMINDER_ADAPTER=1` and requires reminder prerequisites (`start-session.sh:293,299,329-356`). The typing leak cannot be fixed without editing the plugin cache, which is forbidden (`docs/conversation-reminder-claude-adapter.md:16`).

## Researcher's opinion (not verified)

- **Phase 1.** Generalize the proxy into an always-on scoped transport keyed by conversation (project plus optional thread id), independent of reminders. Each thread gets:
  - its own state dir: symlinked `.env`, parent-only `access.json`, `DISCORD_ACCESS_MODE=static`;
  - its own markers, launch files and export `CHANNEL_ID`;
  - a registry record with a persisted session id for `--resume`.

  Separately, map thread ids to their parent assignment for reminders.
- **Risks:**
  - N+1 Gateway connections and the IDENTIFY budget.
  - Duplicate typing indicators and permission-DM races.
  - Development-channel consent on every launch.
  - Plugin installation and channels enablement for every account home.
  - Something must always be listening to spawn sessions for new threads; a proxy cannot.
- **Phase 2**, if connection count or the leaks matter: a CCDM-owned hub with one Gateway connection serving thin per-session `server:` channel endpoints.
