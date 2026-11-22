# Claude Conversation Reminder adapter

This adapter observes a registered Claude Project Conversation. It does not schedule or send Conversation Reminders, close conversation state, or acknowledge `/close` with a checkmark; the [Conversation Reminder service](conversation-reminders.md) does that for every provider.

The adapter has two parts. Both run in every Claude project session:

- `scripts/ccdm-channel-server.js` is the session's channel. It is a Router client and holds no Discord credential. It records owner messages, delivered replies, input requests, and resumed work.
- `scripts/claude-reminder-hook.js` runs as Claude Code command hooks. It records turn completion and session end.

Both write events through `scripts/conversation-reminder-adapter.js`, following the shared [event contract](conversation-reminder-codex-adapter.md#event-contract).

## Launch

A plain launch provides the adapter. There is no opt-in variable and no plugin to install:

```sh
scripts/start-session.sh <project>
python3 scripts/conversation-reminder-readiness.py <project> --json
```

Stop an existing session first with `scripts/stop-session.sh <project>`. The launcher refuses to start while a listener still uses the project's launch key file, and it refuses a project without `webhook_id`.

`start-session.sh` writes private launch files (mode `0600`) under the Router state directory, in `launches/<project>/`:

- `mcp.json` defines one MCP server, `ccdm`, which runs `node scripts/ccdm-channel-server.js`. Its environment carries the launch key file path, the Router state directory, and the reminder context: project, channel ID, a new launch ID, the reminder state directory, the receipts directory, and the path of the settings file.
- `settings.json` disables `discord@claude-plugins-official` for this session and installs command hooks for `SessionStart`, `Stop`, `StopFailure`, and `SessionEnd`. Each hook runs `node scripts/claude-reminder-hook.js`. No hook invokes a model.
- `reminder-env.json` holds the same reminder context. The launcher exports it to the `claude` process so the hooks share the channel server's launch ID.

Claude starts in tmux with `--dangerously-load-development-channels server:ccdm`, `--mcp-config`, and `--settings`. The launch keeps the project's `claude_home`, model, and effort, and uses `zsh -ic`. The launcher accepts the development-channel confirmation itself, then waits for the channel server's Router hello (60 seconds by default, `CCDM_CLAUDE_LAUNCH_TIMEOUT_S`). A failed launch is cleaned up: the tmux session, launch key, launch files, and capability marker are removed.

The launcher does not check a Claude Code version. The repository requires Node `>=22.5` (`package.json`). The scripts call `python3`; `CCDM_REMINDER_PYTHON` selects another interpreter for the event receiver.

A Claude Thread Conversation (`scripts/start-thread-session.sh`) runs the same channel server and hook. Its events name the thread as the conversation. It writes no capability marker, so only the channel session proves the project's readiness.

## Readiness

After its Router hello, the channel server writes a capability marker at `capabilities/<project>.json` in the reminder state directory. The marker records the project, channel ID, assignment generation, `transport: "ccdm-channel-server"`, `server_version: "1.0.0"`, `hooks_configured`, `reply_tool_verified`, the launch ID, and the server's process ID. It holds no credentials or message text.

`hooks_configured` is true only when the launch settings file is private (no group or other access), disables `discord@claude-plugins-official`, and has this checkout's `claude-reminder-hook.js` as a command hook for all four events.

The marker is removed:

- by every `scripts/start-session.sh` launch, before the new server can write its own;
- by `scripts/stop-session.sh`;
- by the channel server when it exits or its Router session ends.

If the Router moves the session to another channel, the server rewrites the marker for the new channel. If the registry no longer assigns that channel to this Claude project, the server removes it.

`python3 scripts/conversation-reminder-readiness.py <project> --json` reports `ready-observe-only` (exit status 0) only when all of these hold:

- the project is registered with an owner, a channel, and a `webhook_id`, and no other project uses its channel;
- the project's `path` does not start with `remote:`;
- the marker matches the current assignment generation and channel, names the `ccdm-channel-server` transport and server version `1.0.0`, and has `hooks_configured` and `reply_tool_verified` set to true;
- the marker's process is still running and is `ccdm-channel-server.js`;
- the durable event receiver is available.

Otherwise it reports `blocked` (exit status 2) and lists the reasons under `assignment_mismatches` and `unsupported_capabilities`. A missing or mismatched marker reads `Claude launch-scoped transport is not verified for this assignment`. A dead server reads `is not running`. Both name the fix: `scripts/start-session.sh <project>`.

The report also lists recent committed events and the pending outbox count. It never prints credentials or message bodies. A ready result proves the running local launch, not a current Discord connection. `delivery_enabled` and `reminders_enabled` are always `false` in this report; delivery state is in `scripts/conversation-reminder-service.py status`. See [Provider readiness](conversation-reminders.md#provider-readiness) for how the service uses the result.

## What the adapter observes

### Owner activity

The Router delivers a project channel's messages to that project's session only. For each message whose author is the registered owner, the channel server emits `owner_activity` with the message ID and an `activity_kind` of `message` or `attachment`. It also remembers the message as an interaction that a reply can name. Guest messages reach Claude but emit no owner event.

The channel server forwards reactions to Claude without recording them. Management commands (`/pause`, `/unpause`, `/compact`, `/clear`, `/restart`) arrive as Router commands, not messages, and the server records nothing for them. The reminder service's observer records owner reactions and management commands itself, through the Router.

### `/close`

The Router drops an exact trimmed `/close` in a project channel before any session sees it. This applies to the owner and to guests, so Claude never receives it. The reminder service's observer sees the message through the Router and emits `close_requested` for the registered owner only. As with the Codex adapter, `close_requested` is a command event, not a completed closure or acknowledgment.

An owner message that mentions the root bot goes to root, not to the project session. The observer also treats a root mention followed by whitespace and `/close` as a close request. Nothing classifies natural language, and no prompt hook intercepts commands.

### Replies

The `reply` tool schema requires `chat_id`, `text`, and `conversation_interaction_id`. It accepts optional `conversation_disposition`: `progress` (the default) or `input-needed`. The server's instructions tell Claude to copy `conversation_interaction_id` from the owner `message_id` being answered, and to set `input-needed` only when the delivered reply asks the owner for input. The server strips both fields before it sends the reply to the Router.

A reply qualifies only when all of these hold:

- the Router confirms delivery and returns Discord message IDs;
- `conversation_interaction_id` names an owner message this session received;
- `chat_id` is that conversation's channel.

Each delivered message ID then emits `response_delivered` and leaves a private receipt marker in `claude-receipts/`. A reply split into several messages emits one receipt per part. With `input-needed`, only the last part carries that disposition and also emits `input_needed`.

A reply without a valid interaction ID is still delivered, but it creates no receipt. Failed replies, `edit_message`, `react`, and tool starts create none either. Attachment replies use the same `reply` path.

If the owner sends a new message while an `input-needed` receipt marker still exists, the server emits `work_resumed`. Once a `Stop` or `StopFailure` hook has cleared that marker, later owner input does not claim resumed work.

### Hook events

The hooks ignore subagent events and any payload without `session_id`. They store no hook payload text and no transcript content.

- `SessionStart` binds the Claude `session_id` to the launch ID and assignment generation in a private file. It emits no event. The other hooks act only when their `session_id` and the current assignment generation match that binding.
- `Stop` emits `turn_completed` only when `background_tasks` and `session_crons` are both present and empty. It emits one event per interaction that has receipts, with the confirmed `delivered_message_ids`, then removes those receipts. Missing fields or running background work count as unfinished: nothing is emitted and the receipts stay for a later `Stop`. A turn without receipts emits nothing.
- `StopFailure` removes pending receipts and emits nothing.
- `SessionEnd` emits `session_terminated`, removes pending receipts without promoting them to a completion, and removes the binding.

## Outbox and receiver

Every event is written to the private `outbox/` directory before the adapter asks the receiver (`scripts/conversation-reminder-events.py`) to commit it. The receiver checks the event against the current registered assignment and returns `committed`, `duplicate`, `stale`, `rejected`, or `retryable_failure`. It rejects an `input_needed` or `turn_completed` event that has no matching `response_delivered` receipt, and a Claude event for a project that is now registered to another provider.

During a receiver outage the event stays in the outbox. The adapter drains the outbox after each new event, and the channel server drains it at startup. `scripts/conversation-reminder-events.py drain --project-root <root> --state-dir <dir>` drains it by hand. Stale and rejected records move to a private `rejected/` directory.

State lives under `~/.local/state/ccdm/conversation-reminders` by default; `CCDM_REMINDER_STATE_DIR` selects another private directory. Events hold IDs, timestamps, dispositions, and assignment metadata, never conversation text or credentials.

## Root

Root Claude (`restart-root-agent.sh`) runs the same channel server with `CCDM_ROUTER_ROLE=root`. In that role the server records no Conversation Reminder events and writes no capability marker, and its `reply` tool does not require `conversation_interaction_id`. Its launch settings disable the official Discord plugin and install no reminder hooks.

Root receives the owner's root-bot mentions from project channels, including a mention followed by `/close`. The project session never sees those messages. The reminder service's observer classifies them.

Reminders themselves are sent by the Conversation Reminder service with root's credentials. No Claude session sends one.

## Remote projects and tests

A project whose `path` starts with `remote:` stays blocked. Local readiness cannot verify an adapter on another host, and nothing here installs one remotely.

The default E2E suite (`tests/e2e/conversation-reminder-claude.test.js` and `tests/e2e/conversation-reminder-router-claude.test.js`) proves this behaviour with Local Fakes. It does not log in to Claude or Discord. A real provider and Discord check belongs to the opt-in Live Smoke Suite.

References: [Claude channels contract](https://code.claude.com/docs/en/channels-reference), [Claude command-hook payloads](https://code.claude.com/docs/en/hooks), [Claude settings precedence](https://code.claude.com/docs/en/settings).
