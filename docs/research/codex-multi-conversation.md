# Run several Codex conversations behind one bridge

Research for wayfinder ticket #81 (map #77), 2026-09-27. Evidence comes from three sources:
- **Local schema:** codex-cli 0.155.1 protocol schema, generated with `codex app-server generate-json-schema` / `generate-ts`. Cited as `SCHEMA/…`.
- **Upstream source:** openai/codex at tag `rust-v0.155.1`, cited as `codex-rs/…`.
- **Upstream protocol docs:** https://github.com/openai/codex/blob/rust-v0.130.0/codex-rs/app-server/README.md, cited as `README@0.130:line`. The current README no longer carries the protocol reference.

CCDM paths are relative to the repo root. Claims marked *inference* are not directly quoted from a source.

## Summary

One app-server can load several Codex conversations and tags every event with its `threadId`. Model and effort can be set per conversation and per turn. One app-server serves exactly one Codex Home, so per-thread account overrides need one app-server per home in use. Running two top-level turns at once in one app-server is very likely supported but untested. The bridge holds about 25 pieces of single-conversation global state that would move into a per-conversation object.

## 1. One app-server, several conversations

**Several conversations can be loaded at once:**
- `thread/start` and `thread/resume` subscribe the client to that conversation's events (README@0.130:145-147).
- `thread/loaded/list` lists the conversations currently in memory (README@0.130:150,354). The `thread_loaded_list_paginates` test starts two conversations on one server (`codex-rs/app-server/tests/suite/v2/thread_loaded_list.rs:43-83`).
- MCP refresh iterates over every loaded conversation (`codex-rs/app-server/src/mcp_refresh.rs:17-27`).

**Concurrent turns are likely but unproven.**
- `TurnStartParams.threadId` addresses each turn (`SCHEMA/ts/v2/TurnStartParams.ts:14`).
- A running turn survives `thread/unsubscribe` (`thread_unsubscribe.rs:200`).
- Codex subagents already run as parallel conversations inside one process.
- No test runs two top-level turns at once, and no concurrency limit is documented.

**Settings accepted per call:**

| Call | Settings | Source |
|---|---|---|
| `thread/start` | `model`, `modelProvider`, `serviceTier`, `cwd`, `approvalPolicy`, `sandbox`, free-form `config`, `baseInstructions`, `developerInstructions`, `personality`, `ephemeral` | `SCHEMA/ts/v2/ThreadStartParams.ts:12-19` |
| `turn/start` | `model`, `effort`, `summary`, `cwd`, `approvalPolicy`, `sandboxPolicy`, `serviceTier`, `personality`, `outputSchema`; each applies "for this turn and subsequent turns" | `TurnStartParams.ts:14-55`; README@0.130:637 |
| `thread/resume` | Same set as `thread/start` | `ThreadResumeParams.ts:26-40` |

- `thread/start` has no `effort` field. Set effort with `config.model_reasoning_effort` or on the first `turn/start`.
- On resume, the saved model and effort are kept unless one of `model`, `modelProvider`, `config.model` or `config.model_reasoning_effort` is supplied (README@0.130:286).
- Today the bridge sets model and effort per process with `-c` (`scripts/codex-bridge.js:582-592`). Those would become defaults that each conversation can override.

**Events can be split by conversation.** Turn and item notifications carry `threadId`:
- `AgentMessageDelta`, `TurnStarted`/`TurnCompleted`, `ItemStarted`/`ItemCompleted`, `Error`, `ThreadTokenUsageUpdated`, `McpToolCallProgress`, `ThreadStatusChanged`, `ThreadClosed` (`SCHEMA/ts/v2/<Name>Notification.ts`).
- `thread/started` carries it as `thread.id`.
- Approval and elicitation requests carry it too.
- The bridge already reads `threadId` (`codex-bridge.js:204-215`).

**Unloading.** A conversation with no subscribers stays loaded for 30 idle minutes, then `thread/closed` fires (README@0.130:164,389).

## 2. Accounts: one home per app-server

- The app-server resolves its home once at startup (`codex-rs/app-server/src/lib.rs:518`) and builds one login manager from it (`lib.rs:538,804`).
- `ConfigManager` holds a single `codex_home` (`codex-rs/app-server/src/config_manager.rs:31,63-64`).
- No request takes a home or account.

**Confirmed:** a thread overridden to another account needs that home's own app-server.

## 3. Discord MCP scoping

**Today** (`codex-bridge.js:1392-1453`), the bridge:
1. lists MCP status and deletes every other `mcp_servers.discord-*` entry (`:1395-1404`);
2. writes `mcp_servers.discord-${CHANNEL_ID}` with env values `BOT_TOKEN`, `CHANNEL_ID` and `DISCORD_REPLY_TOKEN` (`:1409-1432`);
3. reloads MCP servers (`:1435`) and polls until `reply` appears (`:1438-1452`).

`config/value/write` persists to the home's `config.toml` (README@0.130:231), which every app-server on that home shares.

**Per-conversation MCP through `thread/start` `config`: possible, unverified.**
- `config` is applied when the conversation's config is built (`config_manager.rs:186-236`).
- MCP reload uses `rebuild_preserving_session_layers` (`config_manager.rs:155-168`; `mcp_refresh.rs:54-61`), which suggests per-conversation overrides survive a reload (*inference*).
- The env values, including the token, would sit in the conversation's config and possibly its saved history. That needs checking.

**Correction.** Project-mode `scope_token` is not per turn. It is one random value per bridge process (`codex-bridge.js:62`, checked at `scripts/discord-mcp-server.js:220-224`), and the target is always `CHANNEL_ID` (`:226-227`).

**How root mode does it, a reusable pattern:**
- The bridge signs `{author_id, channel_id, nonce}` with a per-process secret (`codex-bridge.js:264-274`).
- It writes the single active token to a private scope file (`:276-288`).
- The MCP server requires `channel_id` and `channel_scope_token`, checks the token against the file, verifies the signature, and checks that the channel is allowlisted and matches (`discord-mcp-server.js:226-274`).

**Adapted to project mode:**
- One shared `discord-${CHANNEL_ID}` server.
- Tokens are signed over `{channel_id: <thread or CHANNEL_ID>, conversation, nonce}`.
- The server accepts a token whose channel is `CHANNEL_ID`, or a thread whose parent is `CHANNEL_ID`.
- Because turns run at once, the single active-token file must become a set of active tokens, each removed when its turn completes.
- The reminder adapter's context file is also one per process (`codex-bridge.js:16`; `scripts/conversation-reminder-adapter.js:14,130-157,231-233`), so it must be keyed by channel.

## 4. Single-conversation state in `codex-bridge.js`

**Per-conversation state:**
- `threadId` (`:79`)
- `deltaBuffer`, `fallbackText` (`:82-83`)
- `turnActive` (`:84`)
- `bootstrapCompletion` (`:85`)
- `activeTurnId`, `activeTurnIdConfirmed` (`:86-87`)
- `mcpReplyCalled`, `suppressTurnOutput` (`:88-89`)
- `pendingBootstrapInstructionReason` (`:90`)
- `pendingCompactionChannelId` (`:91`)
- `messageQueue` (`:92`)
- `bridgePaused` (`:93`)
- `typingInterval`, `activeTypingChannel` (`:97,99`)
- `activeOutputChannelId` (`:98`)
- `threadResetting` (`:100`)
- `fallbackLoggedCompletedItemTypes` (`:102`)
- `pendingTerminalError`, `activeTurnHadProgress`, `activeTurnRecoveryAttempt` (`:103-105`)
- `activeTurnChannelScopeToken` (`:106`)
- `activeReminderContext` (`:107`)
- `lastOwnerInteraction` (`:110`)
- `lastResumedInputReceiptId`, `pendingInputNeededResumeTurnId` (`:111-112`)
- `sessionTerminationPromise` and `recordSessionTermination` (`:116,551-571`)

**Functions that read those globals:**
- `isCurrentThreadNotification` / `isCurrentTurnNotification` (`:212-255`)
- `handleNotification` (`:688-783`). `thread/started` overwrites the global `threadId` at `:718-723`.
- `onTurnCompleted` (`:838-928`), `processQueue` (`:930-937`), `routeInput`/steering (`:951-1005`), `sendTurn` (`:1007-1075`)
- `sendBootstrapInstructionTurn` (`:1077-1128`), compaction (`:1130-1156`), `startCodexThread` (`:1455-1473`)
- `reminderEventContext` (`:328-335`), `flushDeltaBuffer` / `flushTextReplyFallback` (`:816-836`)

**Per process or per bot:**
- `ws`, `requestId`, `pendingRequests`, `codexProcess` (`:78-81,96`). These become one set per app-server.
- `discordClient`, `discordChannel` (`:94-95`), the scope secret and reply token (`:62-63`), `bridgeStopping`, `rootAccess`.
- The nickname context % (`:101,478-513`) is per bot, so it needs a rule for which conversation it reflects.

**Commands and handlers:**
- `/pause`, `/unpause`, `/compact`, `/clear` (`:1603-1686`; `/clear` archives the conversation at `:1653` and re-registers MCP at `:1666`) act on the single conversation. `/restart` restarts the project (`:1688-1707`).
- Inbound filters are exact `CHANNEL_ID` matches: messages `:368`, reactions `:394`, slash commands `:1588`.
- `buildReactionInput` (`:1358-1379`) and `lastOwnerInteraction` (`:1558-1561`) assume one conversation.
- Reminder assignment lookups by channel id (`:1534,1569,1590,1713`) miss thread ids.

**Minimal restructuring (*inference*):**
- A `Conversation` object holding the per-conversation state plus `discordChannelId`, `model`, `effort`, `account` and `runtime`.
- `conversations: Map<discordChannelId, Conversation>`, with `CHANNEL_ID` as the Channel Conversation, plus `byCodexThreadId: Map`.
- A `Runtime` per Codex Home: `{ws, pendingRequests, process, port}`.
- Route events by `params.threadId`.
- Accept `msg.channel.isThread() && msg.channel.parentId === CHANNEL_ID`.
- Lazily create or resume each conversation from a saved `{discordThreadId → codexThreadId, home, model, effort}` record.

## 5. Resume

- **Today.** `start-codex-session.sh <project> --resume <uuid>` passes `CODEX_RESUME_THREAD_ID` (`scripts/start-codex-session.sh:2,12-28,310,327-350`). The bridge calls `thread/resume` (`codex-bridge.js:1455-1462,1484-1485`) and re-sends the bootstrap.
- **A different app-server process on the same home works.** Resume loads saved history from disk (`ThreadResumeParams.ts:10-25`). A conversation owned by another live process is rejected (`thread_resume.rs:314-323`), so the old owner must stop or unload it first.
- **Archived Codex conversations.** Resume fails with "session … is archived" (`thread_resume.rs:2845-2889`); run `thread/unarchive` first (README@0.130:166,578-585). Archiving a Discord thread should not archive the Codex conversation.
- **Another home.** It cannot see the conversation. Use the documented stop, copy rollout into target `sessions/` (never overwrite), resume sequence (`.mex/context/session-management.md:52`). A thread's account override therefore moves its conversation to another app-server, which must not already have it loaded.

## Researcher's opinion (not verified)

- **Preferred: one bridge per project serving many conversations,** with one app-server per Codex Home in use. It gives:
  - one Discord login per bot;
  - one owner for the nickname, reminders and slash commands;
  - simple resume.
- **Risks of that route:**
  - Concurrent turns in one app-server are unproven. A roughly 30-minute two-conversation test should settle it.
  - The single active scope token must become a set.
  - Refactoring about 25 globals.
  - An app-server crash now affects several conversations. Today any runtime loss exits the bridge (`codex-bridge.js:573-579,622-624`).
  - Signed tokens are preferable to per-conversation config writes on a shared home.
- **Alternative: one bridge and app-server per thread.** It reuses today's code but:
  - duplicates Gateway logins;
  - makes bridges delete each other's `discord-*` MCP entries in the shared home config (`codex-bridge.js:1395-1404`);
  - multiplies ports;
  - breaks the one-listener-per-bot rule;
  - repeats the bootstrap per process.

  Choose it only if the concurrency test fails.
