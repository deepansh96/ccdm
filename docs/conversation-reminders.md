# Project Conversation state service

This service sends Conversation Reminders. It records owner acknowledgment, `/close`, reopening, and qualifying Claude, Codex, or Gemini responses. A reminder is a `👀` posted by the root bot. Reminders back off while they are ignored.

The service covers each registered project channel (its Channel Conversation) and each of its Thread Conversations.

Run it in the foreground, or supervise the same worker with the opt-in macOS LaunchAgent described below. It runs independently of coding sessions: stopping or restarting a project session or the root agent does not stop it or change conversation state.

Reminders are opt-in. A registered channel reports `suspended-incomplete-discovery` and sends nothing until `enable` has run and discovery marks it `ready`.

## How it fits the Router

- Projects have no bot of their own. A project's agent posts through its `ccdm-<project>` webhook, and the registry records that webhook's `webhook_id`.
- The service identifies a project's speaker as `router:<webhook_id>`. An agent reply is a message whose `webhook_id` equals the project's own. Any other bot or webhook message is not a reply.
- The worker observes project channels and their threads as the Router's read-only `observer` client. It never logs in to the Discord Gateway.
- The root bot sends every `👀` reminder and every `✅` acknowledgment, and deletes old reminders, over Discord's REST API.
- Session adapters record turn events in a private, durable event ledger: `scripts/ccdm-channel-server.js` with `scripts/claude-reminder-hook.js` for Claude, `scripts/codex-bridge.js` for Codex, and `scripts/gemini-bridge.js` for Gemini. The Thread Supervisor records thread lifecycle events the same way.

## Requirements

- `registry.json` must have one owner (`discord_user_id`). Each project needs a `channel_id` that no other project shares, and a `webhook_id`.
- The root Discord bot token must be in `ROOT_DISCORD_STATE_DIR/.env` as `DISCORD_BOT_TOKEN`. The default root state directory is `~/.claude/channels/discord`.
- The Router must be running. Start it with `scripts/install-router-service.sh` or `scripts/router.js serve`.
- Root needs Send Messages, Read Message History, Add Reactions, Manage Messages, and Manage Webhooks in each project channel. While Thread Conversations are enabled, root also needs Create Public Threads, Send Messages in Threads, and Manage Threads in the channel, and View Audit Log in the guild. The service reports missing permissions and never changes them.
- Python 3 and Node 22 or newer. The supervised worker uses the interpreters the installer resolved, not the login shell's `PATH`.
- All three provider adapters must be installed: `scripts/ccdm-channel-server.js`, `scripts/claude-reminder-hook.js`, `scripts/codex-bridge.js`, `scripts/gemini-bridge.js`, `scripts/discord-mcp-server.js`, and `scripts/conversation-reminder-adapter.js`. If any file is missing, no channel receives reminders. There is no single-provider override.
- A Claude channel is ready only while its session's channel server is running. See [Provider readiness](#provider-readiness).

## Enabling reminders

From the repository root:

```sh
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py run
```

`enable` is the manual opt-in. It checks the provider adapter files, the registry owner, and that root Discord credentials are present. Each blocker names its fix; for example, missing root credentials ask for `DISCORD_BOT_TOKEN` in `ROOT_DISCORD_STATE_DIR/.env`.

If a check fails, `enable` exits with status 2, lists the blockers under `preflight`, and changes nothing. It does not create the state directory or change its permissions. Only after every check passes does it create the private state directory, or reset its mode to `0700`. It never prints tokens.

On success it clears `disabled`, requests discovery of older conversations, and sends every previously ready channel back through restart reconciliation.

`run` starts the foreground worker. `enable` does not check the Router or root's channel permissions. `status` and `preflight` do, per project; see [Router prerequisites](#router-prerequisites).

## Supervised LaunchAgent (macOS)

The LaunchAgent is optional. It runs the same `conversation-reminder-service.py run` worker as the foreground command, so it uses the same single-worker lock, reconciliation, and catch-up rules. Install it from the repository root:

```sh
scripts/install-conversation-reminder-service.sh
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py status
```

The installer validates everything before it touches launchd:

- It needs `python3` and Node 22 or newer (`CCDM_REMINDER_NODE`, or `node` on `PATH`), the plist template, and the service script. If one is missing it exits with status 1.
- `CCDM_REMINDER_STATE_DIR` and `ROOT_DISCORD_STATE_DIR`, when set, must be absolute paths.
- It runs the read-only `conversation-reminder-service.py preflight`. That checks the provider adapter files, the registry owner, root Discord credentials, a private state directory, each project's Router prerequisites, and a usable conversation store. If preflight fails, the installer exits with status 2 and lists the blockers.

On any failure it does not create or change the plist, launchd, the state directory, or file permissions, and it leaves a working installation loaded. It never changes Discord permissions.

On success, it renders `~/Library/LaunchAgents/com.discord.conversation-reminders.plist` and loads it. The plist holds only absolute paths: the Python interpreter, the service script, the repository, the state directory, Node, and the root state directory. It holds no tokens, registry values, or channel IDs. The worker reads credentials from their existing private files.

- `RunAtLoad` starts the worker at login.
- `KeepAlive` relaunches it only after an unsuccessful exit, with a 30-second throttle. A crash or a lost lock race is retried.
- The worker's umask is `077`.
- Standard output and errors go to `service.log` and `service.err` in the private state directory. Those logs contain status JSON, never credentials or conversation bodies.

Running the installer again gives the same plist and reloads it. If launchd rejects the replacement, the installer restores the previous plist and reloads the previous service. The installer does not change the Usage Stats Poster, its schedule, its LaunchAgent, or its storage.

Only one worker runs at a time. If a foreground `run` holds the lock when launchd starts the worker, such as at login, the supervised launch exits with status 2. launchd retries it every 30 seconds, and it takes over once the foreground worker exits. A foreground `run` started while the supervised worker holds the lock is refused the same way.

Operating the supervised worker:

- **Status:** `scripts/conversation-reminder-service.py status`. Each project's `readiness` lists its `blockers` with the action that clears them. See [Commands](#commands).
- **Stop or disable:** `scripts/conversation-reminder-service.py disable`. The worker finishes any in-flight Discord request and exits successfully, so launchd does not relaunch it. At the next login the worker starts, sees `disabled`, and exits without observing or sending. Closures, history, due times, and delivery state are kept.
- **Re-enable:** `scripts/conversation-reminder-service.py enable`, then rerun `scripts/install-conversation-reminder-service.sh` to start the worker. Every previously ready channel reconciles before its next send.
- **Foreground start:** `scripts/conversation-reminder-service.py run`. If the supervised worker is running, stop it first with `disable` and wait for `worker_running: false`. Then run `enable` and `run`. launchd does not restart the supervised worker until its next load, such as a login or rerunning the installer.
- **Recovery:** `disable`, wait until `status` shows `worker_running: false`, then `enable` and `recover`. Afterwards rerun the installer. See [Uncertain sends and recovery](#uncertain-sends-and-recovery).
- **Remove:** `disable`, then `launchctl unload ~/Library/LaunchAgents/com.discord.conversation-reminders.plist` and delete that file. Keep the state directory. Deleting it does not clear a closure and discards delivery history.

## Readiness and deployment

- **First enablement:** install the LaunchAgent (or start `run`), then run `enable`. `enable` requests discovery of older conversations. The worker scans each channel's history and its threads, then marks the project `ready`. Until then, `status` shows `history: discovering` or `suspended-incomplete-discovery`, and nothing is sent. A discovered channel that is already overdue gets one globally spaced catch-up. See [History discovery](#history-discovery).
- **State location:** `~/.local/state/ccdm/conversation-reminders/`, or `CCDM_REMINDER_STATE_DIR` when it is set at install time. The directory is mode `0700`. The databases, worker lock, and service logs are `0600`, and the supervised worker's umask keeps new files private. It holds the event database (`events.sqlite3`), the conversation database (`conversations.sqlite3`), the worker lock, the adapters' outbox and reply receipts, Claude capability markers, and the service logs. Keep it across restarts and upgrades.
- **No live test required:** the default `npm test` suite proves the installer, the supervised and foreground worker, and each provider's reply, reminder, and reply-or-close workflows with Local Fakes. It does not use Discord, Claude, Codex, Gemini, launchd, or credentials. Real Discord and provider checks belong to the opt-in Live Smoke Suite behind its Live Gate. Enabling reminders does not require one.
- **Cleanup and uncertain deliveries:** failed deletions stay pending by recorded message ID. An uncertain send suspends its project as `suspended-uncertain-send` until the running worker, or `recover`, identifies the reminder by replaying its nonce or proves from history that none was created.
- **Assignment retirement:** after any registration or deregistration, run `assignment-changed --project <project>`. See [Assignment changes](#assignment-changes).
- **History and reaction limits:** discovery and reconciliation cannot see deleted messages or reactions removed while nothing was observing. They cannot tell when an old reaction was added either. See [Time, order, and reaction limits](#time-order-and-reaction-limits).
- **Indefinite pauses:** any Conversation Reply, including a reaction (even one on a reminder), pauses the conversation until the agent next finishes a turn or asks for input. If no qualifying response follows, the conversation stays paused indefinitely. This is expected. Send a new message to restart the exchange.

### Provider readiness

`status` reports each project's provider (`claude`, `codex`, or `gemini`) and its adapter status. A channel whose adapter is blocked stays `suspended-adapter-capability` or `blocked-adapter-capability`. It does not fall back to guessing from silence.

- **Claude:** every Claude launch runs `scripts/ccdm-channel-server.js`, which records reminder events itself. After its Router hello, the server writes a capability marker at `capabilities/<project>.json` in the state directory. The channel is ready only while that marker matches the current assignment and its process is running. A stopped session suspends the channel. `scripts/start-session.sh <project>` brings it back, with no extra opt-in. The running worker notices within about 30 seconds and reconciles the channel before its next send.
- **Codex and Gemini:** the bridge records reminder events while its session runs. These channels need no capability marker.
- **Remote projects:** a project whose `path` starts with `remote:` stays `blocked-adapter-capability`, whatever its provider. Local readiness cannot verify an adapter on another host, and nothing here installs one remotely.
- **Other providers:** a project `type` other than `claude`, `codex`, or `gemini` has no reminder adapter and stays blocked.

The event contract that adapters follow is in the [Codex adapter guide](conversation-reminder-codex-adapter.md). To inspect one project's adapter, run `python3 scripts/conversation-reminder-readiness.py <project> --json`.

### Router prerequisites

`status` and `preflight` check each project's Router prerequisites through `scripts/router.js status --json`. `status` shows them under `readiness.projects.<project>.router`. `preflight` lists them as `<project>: <blocker>` and stays blocked until all are cleared. Each blocker names its fix:

- The Router is not reachable. Start it with `scripts/install-router-service.sh` or `scripts/router.js serve`.
- The Router is not connected to Discord yet. Retry once `scripts/router.js status` shows the gateway ready.
- The project's webhook is missing. Run `scripts/router.js ensure-webhook <project>`.
- Root lacks Send Messages, Read Message History, Add Reactions, Manage Messages, or Manage Webhooks in the project channel. Grant root that permission.
- Root lacks a thread permission. This is reported only while Thread Conversations are enabled: the Thread Supervisor's LaunchAgent is installed, the registry has `thread_session_caps`, or the Supervisor is connected to the Router.

## Commands

From the repository root:

```sh
scripts/conversation-reminder-service.py status
scripts/conversation-reminder-service.py preflight
scripts/conversation-reminder-service.py run
scripts/conversation-reminder-service.py disable
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py discover
scripts/conversation-reminder-service.py recover
scripts/conversation-reminder-service.py assignment-changed --project <project>
```

`run` is the foreground observer and delivery worker. One worker may run at a time. It applies committed adapter events every half second, and its observer checks due work every quarter second.

`disable` persists the disabled setting and stops the worker. A Discord request already in flight finishes first, and its result is recorded. Disabling keeps closures, history, due times, and delivery state.

`enable` clears the setting but does not start a worker. Every channel reconciles before its next send.

`preflight` is the read-only check the installer runs. It exits with status 2 when blocked.

`sync` performs one foreground pass over committed adapter events for diagnosis.

Use `status` to inspect:

- the worker lock (`worker_running`);
- each Channel Conversation under `conversations.<project>`, with its state (`open-paused`, `awaiting-owner`, or `closed`), due time, and `consecutive_reminders`;
- each Thread Conversation under `conversations.<project>.threads.<thread_id>`;
- unresolved intent nonces, pending cleanup or `✅` actions, and queued catch-ups.

`delivery_enabled` is true only after `enable`, while not disabled and with all three provider adapters installed. `readiness.projects.<project>` combines every gate for one project:

- `provider`: `claude`, `codex`, or `gemini`;
- `adapter`: the provider adapter readiness report;
- `observation`: whether the worker is observing the channel through the Router;
- `history`: the channel's discovery or reconciliation status;
- `assignment`: registry problems, or `ok`;
- `uncertain_delivery`: unresolved nonces;
- `pending_cleanup`: reminder IDs still to delete;
- `catch_up_queued`: whether a catch-up is waiting its turn;
- `router`: the project's [Router prerequisites](#router-prerequisites).

`delivery_ready` is true only when `blockers` is empty. Each blocker names an action, such as `run enable`, `run recover`, or the history reason. A Claude adapter blocker gives the relaunch command, `scripts/start-session.sh <project>`.

`history: untracked` means the service has no conversation state for the project yet. Clear its other blockers, then start the worker. After a registration change, run `assignment-changed --project <project>`.

`enable`, `disable`, `status`, the final output of `run`, and `recover` all include this report. The output contains no conversation bodies or credentials.

## Reminder timing

For a ready conversation, root posts exactly `👀` with mentions disabled one hour after a qualifying response. A qualifying response is a completed agent turn, or a request for owner input, whose reply was confirmed as delivered.

While the owner ignores it, each replacement waits longer: after `k` consecutive reminders the next is due `min(2k, 24)` hours later.

| Reminders already sent | Gap to the next reminder |
|---|---|
| 0 | 1h |
| 1 | 2h |
| 2 | 4h |
| 3 | 6h |
| 4 | 8h |
| 12 or more | 24h |

A response at 10:00 is therefore reminded at 11:00, 13:00, 17:00, 23:00, and 07:00 the next morning. Each further ignored reminder adds two hours to the gap, so it first reaches one reminder a day after the twelfth reminder, and stays there.

- Each replacement posts the new `👀` before deleting the recorded one.
- Each successful send starts its gap from its actual send time. A canceled or late send does not count.
- `status` shows the streak as `consecutive_reminders`.
- Any exit from awaiting the owner resets the streak: a Conversation Reply (message, attachment, or reaction), `/close`, or resumed work. The next qualifying response then arms a fresh hour.
- A new qualifying response while the conversation is still awaiting the owner also resets the streak. It is due one hour after that response.
- A discovery baseline built from history starts at zero, because history cannot identify earlier reminders. A live completion already recorded for the conversation keeps its streak.

Owner activity:

- An owner Conversation Reply or `/close` cancels due work and queues deletion of the reminder by its recorded message ID. An accepted send that returns after cancellation is also queued for deletion.
- A `/close` gets a `✅` from root. The Router never delivers a channel's `/close` to the session, so it never starts a turn.
- In a project channel, `/compact`, `/clear`, `/pause`, `/unpause`, `/restart`, `/model`, and any message that mentions root are management traffic. They acknowledge the conversation but never reopen a closed one.
- An owner reaction on a recorded reminder is a Conversation Reply like any other owner reaction. The private recorded-ID list keeps it out of coding turns.
- A guest's message or reaction acknowledges nothing.

Failures:

- A failed send keeps the previous reminder. Discord 429 timing and bounded transient retries are respected.
- A 401 or 403 on a send suspends delivery as `suspended-delivery-access`.
- A lost response or 5xx is retried with the same nonce. If it stays ambiguous, or a send was interrupted, the project suspends as `suspended-uncertain-send` instead of risking a duplicate.
- Failed deletions remain pending and block replacement. A Discord 404 completes cleanup.

Do not edit the private database to change a conversation's state. If access is lost, restore root's channel permissions, then restart the worker (`disable`, wait for it to exit, `enable`, `run`). A restart moves access and assignment suspensions back through revalidation and reconciliation.

## Thread Conversations

Each Thread Conversation of a registered project is tracked on its own, under its project's assignment. Its conversation ID is the thread ID.

- Root posts a thread's reminder in that thread, never in the channel.
- A reminder posted into an auto-archived thread reopens the thread. It does not start a session.
- An owner reply in one thread acknowledges only that thread.
- A Thread Supervisor notice in a thread is not an agent reply, so it never arms a reminder.
- In a thread, `/close`, `/restart`, `/clear`, `/config`, `/model`, `/compact`, `/pause`, and `/unpause` are Supervisor or session commands. They acknowledge without reopening.
- A thread's `/close` closes only that thread's reminders. The Supervisor reports the closure. An owner archive is reverted by the Supervisor and keeps the thread's reminders.
- An accepted provider or account switch (such as `/config provider=...`) resets the thread's reminder tracking: nothing the old provider answered can arm a reminder. `/clear` does not reset it.
- Deleting a thread drops its reminder state. Its siblings and the channel are untouched.
- Every thread reminder passes the global five-second spacing gate, so many threads never send at once.
- A thread shares its project's readiness status. Retiring a project's assignment retires its threads too.

## Uncertain sends and recovery

Every send attempt carries the claim's durable nonce with `enforce_nonce`. Discord documents that uniqueness for only the [past few minutes](https://docs.discord.com/developers/resources/message#create-message). A timeout, lost response, or 5xx may follow a created message, so the worker retries up to twice within seconds using the same nonce. Discord then returns the reminder it already created instead of posting another. A connection refused or a DNS failure before the request left the machine is an ordinary failure with backoff. A 429 is too. Neither is uncertain.

The running worker resolves uncertain sends by itself. It retries each unresolved intent with a backoff from five seconds to five minutes, so an ordinary network failure does not need an operator.

`recover` is a bounded, one-pass operator command for what stays stuck:

1. Stop the worker with `disable` and wait for it to exit.
2. Run `enable`, then `recover`.
3. Run `status`. Repeat `recover` after fixing a transient lookup or cleanup failure.

`recover` takes the same exclusive worker lock, so it cannot take over a running manual or supervised worker. It first applies committed events, resolves uncertain sends as described below, then retries known cleanup and `✅` actions by their recorded IDs. It never claims a new reminder; the only create it issues is the uncertain intent's own nonce replay. A dead worker releases the lock and can be recovered without removing the store. A resolved send leaves the project `suspended-restart-reconciliation`. The next `run` reconciles it and, if it is overdue, sends its single catch-up.

Recovery accepts only evidence bound to the intent:

- **Within two minutes of the claim,** well inside Discord's duplicate-check window, it repeats the claim's exact create with the same nonce and `enforce_nonce`. Discord answers with the reminder the lost request created, or, if that request never arrived, creates the one reminder this nonce allows. Either way the returned message ID and timestamp are recorded as the reminder. A refused replay (401, 403, or another 4xx) or an unanswered one leaves the intent unresolved and is retried.
- **After that window,** a replay could post a duplicate, and Discord does not return a message's nonce on a later history read. History can then only prove that nothing was created. Recovery pages back from the newest message, at most five pages of 100, only until it passes the claim window: from two minutes before to five minutes after the claim. It never scans to the start of the channel.
- If the whole window is visible, has closed, and holds no unrecorded `👀` from root, the request provably created nothing. The project then reconciles and may send again.
- An unrecorded root `👀` in the window is never adopted or deleted, because nothing ties it to the intent. Recovery lists it under `candidates` and keeps `suspended-uncertain-send`. If a listed message is a stray reminder, delete it in Discord and run `recover`. If it is an ordinary root message, run `assignment-changed --project <project>` to retire the unresolved intent with its generation.
- Denied history lookup, incomplete bounded history, or an empty window that has not closed also leave the intent in `status`.

Do not force a new send or reset the database. Restore root's channel access and retry. Restart reconciliation never releases a project with an unresolved intent.

## State storage

State is stored privately under `~/.local/state/ccdm/conversation-reminders/` by default. `CCDM_REMINDER_STATE_DIR` selects another private state directory. The conversation store is separate from the adapter event ledger and from Usage Stats storage.

Keep both the event and conversation databases across restarts. An unsupported or corrupt store blocks operation rather than being replaced. Do not delete the databases to clear a closed conversation; send a new normal owner message to reopen it.

Opening an older store upgrades it in place, to schema version 8. Before its first schema change, the service saves a private copy as `conversations.v<version>.backup.sqlite3` in the state directory. A store written before the reminder streak existed counts a conversation with a recorded reminder as one sent, and keeps its pending due time. Older code refuses an upgraded store. To roll back, stop the worker and restore the backup copy with the older code.

## Restart, reconnect, and catch-up

The following events may miss owner activity:

- a worker restart after a crash or `disable`;
- waking from sleep, or any other wall-clock jump of more than 30 seconds between the observer's quarter-second ticks;
- `enable`;
- a lost Router connection. While it is down, each project reports `suspended-observation-access`.

Each one sends every ready channel through `suspended-restart-reconciliation` before its next send. While observation is suspended, the worker neither scans nor sends. After a wake, the Router socket can look connected until the dead connection is noticed. The worker therefore holds scans and sends for about 45 seconds (`CCDM_REMINDER_WAKE_SETTLE_MS`) unless a reconnect replaces the socket first.

Adapter events for these channels stay unapplied in the durable event ledger. The worker then reruns the bounded, fair, checkpointed history traversal from discovery in `restart` mode (status `reconciling`). It uses the same per-pass page and reaction budgets, and it saves a cursor after every page, so an interrupted scan resumes. It pages backward only to the conversation's persisted acknowledgment, then forward to the newest message. It then checks reaction membership on messages after the owner's latest reply.

When the scan commits, missed changes apply in this order:

1. Newer owner messages, `/close`, and management commands, at their Discord times. A missed `/close` closes the conversation and still gets its `✅`.
2. The buffered adapter events, such as completions that a still-running agent recorded during the gap.
3. Owner reactions, if the conversation is still awaiting the owner. A reaction on the current answer, or on a later message, pauses it. A reaction on an earlier message that no recorded event dates pauses it conservatively as `reaction-ordering-unresolved`.

History alone never arms a reminder during reconciliation; only live adapter completions do. Closed state, assignment generations, and unresolved delivery intents are preserved. `status` shows the result as the `discovery.basis` with `mode: restart`: `no-missed-activity`, `missed-owner-activity`, `owner-reaction-after-answer`, or `reaction-ordering-unresolved`. Denied or unavailable history suspends the channel as `suspended-discovery-history` with the reason and retry time. Restore root's View Channel and Read Message History access.

A channel released while overdue, either by initial discovery or by reconciliation, gets at most one catch-up reminder. All catch-up sends, and every thread reminder, share one durable global gate, which spaces them at least five seconds apart. Neither a restart nor a second channel can bypass the gate. A Discord 429 on a catch-up pushes the gate to Discord's retry time. Missed intervals are never replayed.

A catch-up is a real send: it extends the ignored streak, and the next gap starts from its actual send. A first reminder sent as a catch-up confirmed at 15:20 is next due at 17:20. A queued catch-up waits for pending cleanup of the previous reminder. It is dropped if the owner replies or closes, or if the assignment is retired or changed, before its turn. Nothing is sent while the host is asleep or offline.

### Time, order, and reaction limits

- Historical messages carry Discord timestamps, not turn-completion metadata. Missed owner activity applies at its Discord time; adapter events apply at their recorded times.
- History cannot show deleted messages. A reaction that was added and then removed while nothing was observing cannot be seen either. Both may be unrecoverable.
- The observer and a session bridge can both report one live owner reaction. The service counts copies of the same reaction (the same message, owner, and emoji within two minutes) once, so a delayed copy cannot clear a later reminder. Re-adding that emoji later is a new acknowledgment.
- Reaction membership shows who reacted, not when. Each message's first accounted owner reaction is remembered. A later owner reaction on that same earlier message, added while disconnected, is not detected.
- A reaction acknowledges the conversation and pauses it until the agent next finishes a turn or asks for input. If no qualifying response follows, the conversation stays paused indefinitely. Send a new message to restart the exchange.

## History discovery

`discover` persists the operator's request to discover older Project Conversations. It does not read Discord itself: the `run` worker performs the scan while its observer is live, so owner activity during the scan is not missed. The request stays set, so a channel registered later is also discovered. `disable` stops scanning with the worker; progress is kept.

For each undiscovered channel, the worker records the newest message as an observation watermark and marks the channel `discovering`. Committed events for that assignment then stay unapplied in the event ledger until the scan commits.

The worker reads history with root's token:

- It pages backward, up to 100 messages per page, until it finds the owner's latest normal message or `/close`, or reaches the start of the channel. There is no fixed recent-history cutoff.
- It then pages forward from the watermark to the newest message and checks reaction membership.
- Each project gets at most 10 history pages and 10 reaction lookups per 30-second pass. The least-served project goes next, so a long channel cannot starve others.
- Cursors are saved after every page, so a crash or restart resumes where the scan stopped.
- Discord 429 responses pause that channel for the advertised time. Other failures retry after 30 seconds.

After the channel's own scan, an initial discovery walks its Thread Conversations. It adopts the channel's active threads, plus threads archived within the last seven days whose conversation is not closed. Each adopted thread is scanned the same way, into its own baseline. The project is released only once every thread's scan has committed. The channel and its threads share the project's per-pass budget.

A conversation becomes eligible only when the owner's latest Conversation Reply is followed by a message from the project's own webhook. The answer must come before any guest message that follows the reply. The first reminder is due one hour after that answer's Discord timestamp. Historical messages carry no turn-completion metadata, so status labels this basis `historical-owner-then-bot-approximation`. It is used only for discovery. Live completion and input-needed still require confirmed adapter receipts. These conversations stay `open-paused`:

- no owner participation, such as a guest-only exchange;
- no agent answer after the owner's latest reply, which means the conversation is waiting for the agent;
- a management command whose only follow-up is fixed CCDM command output, such as `Compaction queued.`;
- an interaction with recorded adapter lifecycle events (`active-turn`), which waits for the live completion.

A `/close` with no later normal owner message is `closed`. A closure already recorded by the service stays closed unless history shows a later normal owner message. Reminders are identified only by recorded message IDs; any other `👀` is an ordinary message.

When the scan commits, the service writes this baseline, applies the buffered events on top of it, and then marks the project `ready`. Newer owner messages, reactions, `/close`, and resumed work therefore win over the historical result. A live owner message that the scan already saw is not counted twice. The worker checks the assignment generation and conversation revision before committing. An assignment change discards the old scan, and the new generation is scanned from the start.

`status` shows `discovery_requested` and, for each conversation, a `discovery` object. It includes the phase, basis, pages scanned, passes, cursors, retry time, and reason. Denied or missing history, including a 403 on reaction lookup, suspends the channel as `suspended-discovery-history`. Delivery stays blocked, and the scan retries from its saved cursor after five minutes. Restore root's View Channel and Read Message History access. Do not reset state.

Limitations: discovery cannot see deleted messages. It cannot see reactions that were added and removed before the scan, or reactions on messages older than the owner's latest reply. Reaction membership shows who reacted, not when. An owner reaction on the answer, or on a later message, acknowledges it. A reaction on an earlier message counts only when a recorded reaction event dates it. Otherwise the conversation pauses as `reaction-ordering-unresolved`, which may last until the next qualifying agent response. A reaction list with 100 or more users is treated the same way. Discovery uses no model inference.

## Observation through the Router

Each worker start writes a fresh `0600` key to `<router state>/keys/.observer.key`. A newer observer hello replaces any older observer connection.

The Router sends the observer every message in a project channel or one of its threads, including webhook and bot messages, plus the owner's and guests' reactions. The observer can perform no Router operation.

An owner `/close` in a project channel reaches only the observer. The Router never delivers it to the session.

While the Router connection is down, each project reports `suspended-observation-access`. The worker retries the connection every two seconds. Once it returns, each project reconciles before any send. An unreachable Router at worker start blocks observation the same way; it does not crash the worker.

## Assignment changes

Each Project Conversation belongs to one assignment generation. The generation is the project's `assignment_generation` in `registry.json`, or, when that is absent, a hash of the project name, owner, channel, `router:<webhook_id>`, and `registered_at`.

The service reads the registry on every pass. When a project is deregistered, or its owner, channel, webhook, or generation changes, the old generation is retired before any further send:

- Its conversation state and due time are dropped, along with its Thread Conversations'.
- Queued or replayed adapter events for it are rejected.
- Pending `✅` acknowledgments are abandoned.
- A claimed send is canceled before its request. A reminder that Discord accepts during the change is queued for cleanup.

The replacement assignment starts fresh as `suspended-incomplete-discovery`.

### `assignment-changed`

Polling cannot see a delete and identical re-add between passes. After writing, changing, or removing a project's registry entry, run:

```sh
scripts/conversation-reminder-service.py assignment-changed --project <project>
```

Registration and deregistration are root-agent workflows, and both end with this command. The Router runs it by itself when it recreates a deleted webhook or moves a project's webhook to a new channel. `scripts/migrate-to-router.sh` runs it too.

The command:

- retires every known generation for that project;
- when the project is registered, writes a fresh `assignment_generation` into `registry.json`, under the shared registry lock and with the file's existing mode;
- deletes the retired assignment's recorded reminders at once over REST with root's token, even while the worker is stopped;
- reports the outcome under `retired_cleanup` (`completed`, `inaccessible`, `pending`).

A reminder it cannot delete, including one Discord refuses after bounded retries, is reported `inaccessible` with its reason rather than left pending. Only a failure to run the cleanup at all leaves it `pending`, with `guidance` to start the worker or run `recover`.

Never copy an old generation into a re-registration. If the service saw a deregistration and the identical identity returns, the channel reports `blocked-retired-generation` and `assignment_guidance` until this command issues a new generation. Running sessions use the new generation on their next event.

### Retired cleanup

Retired cleanup deletes only recorded reminder IDs, and root deletes them. It never changes permissions.

Rejected root credentials (401), lost channel access (403), or a missing root token move the message to `cleanup.inaccessible` under `retired_assignments` in `status`. `retired_cleanup_guidance` then asks you to delete it manually in Discord. Retired leftovers and a retired generation's unresolved nonces never block the new generation.

### Conversations from before the Router

A store written before the Router cutover may hold a conversation keyed by a `pool:<botId>` identity. Such rows stay readable as history.

Until `assignment-changed --project <project>` runs, that conversation keeps its old identity, nothing is sent, and readiness asks for the command. `assignment-changed` then retires the old generation and issues a new one. Root, with Manage Messages, deletes the retired identity's reminders. The open conversation carries into the new generation with its state, acknowledgment, response, due time, and reminder streak intact. The next reminder comes from root under the `router:<webhook_id>` identity.

### Suspensions

An ambiguous or incomplete entry, such as a shared channel, a missing owner, or a missing `webhook_id`, moves a ready or reconciling channel to `suspended-assignment`.

The observer revalidates the owner, channel uniqueness, the Router connection, and adapter readiness at startup, on each observed message, whenever `registry.json` changes, and at least every 30 seconds. A failure suspends only that assignment:

| Status | Cause |
|---|---|
| `suspended-assignment` | The registry entry is incomplete or ambiguous. |
| `suspended-observation-access` | The Router connection is down. |
| `suspended-adapter-capability` | The provider adapter is not ready, such as a stopped Claude session. |
| `suspended-delivery-access` | Discord refused a reminder send with 401 or 403. |

When the Router connection or the adapter returns, the running worker moves the channel to restart reconciliation by itself. It reconciles before any send, because observations may have been missed. A `suspended-assignment` or `suspended-delivery-access` channel is revalidated at the next worker start.

Root channels are never tracked. Stopping or restarting a project session or the root agent does not stop this service or change open or closed state.
