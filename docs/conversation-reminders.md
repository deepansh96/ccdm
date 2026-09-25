# Project Conversation state service

This service records owner acknowledgment, `/close`, reopening, and qualifying Claude or Codex responses, and sends hourly Conversation Reminders. Run it in the foreground, or supervise the same worker with the opt-in macOS LaunchAgent described below. It runs independently of coding sessions: stopping or restarting a project or root agent does not stop it or change conversation state. Reminders are opt-in. A registered channel reports `suspended-incomplete-discovery` and sends nothing until `enable` has run and discovery marks it `ready`.

## Requirements

- `registry.json` must have one owner and an unambiguous project channel and assigned bot per project.
- The root Discord bot token must be in `ROOT_DISCORD_STATE_DIR/.env` as `DISCORD_BOT_TOKEN`; the default root state directory is `~/.claude/channels/discord`.
- The root bot must be able to view and read project channels. Assigned project bots need view, history, send, and reaction permissions in their own channels. The service checks these permissions and does not change them.
- Claude projects require the verified launch-scoped reminder adapter to be running; its capability marker proves only that live launch. Codex projects require the current bridge adapter. Unsupported and remote Claude assignments remain excluded.
- Python 3 and Node 22 or newer. The supervised worker uses the interpreters the installer resolved, not the login shell's `PATH`.
- Both provider adapters must be installed: `scripts/codex-bridge.js`, `scripts/discord-mcp-server.js`, `scripts/claude-reminder-channel.js`, `scripts/claude-reminder-hook.js`, and `scripts/conversation-reminder-adapter.js`. If any is missing, no channel receives reminders, including Codex channels. There is no Codex-only override.

## Enabling reminders

From the repository root:

```sh
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py run
```

`enable` is the manual opt-in. It checks the provider prerequisites, the registry owner, and that root Discord credentials are present. Each blocker names its fix; for example, missing root credentials ask for `DISCORD_BOT_TOKEN` in `ROOT_DISCORD_STATE_DIR/.env`. If a check fails, it exits with status 2, lists the blockers under `preflight`, and changes nothing: it does not create the state directory or change its permissions. Only after every check passes does it create the private state directory, or reset its mode to `0700`. It never prints tokens. On success it clears `disabled`, requests discovery of older conversations, and sends every previously ready channel back through restart reconciliation. `run` starts the foreground worker. The worker verifies each channel's Discord permissions when it connects and records failures per channel.

## Supervised LaunchAgent (macOS)

The LaunchAgent is optional. It runs the same `conversation-reminder-service.py run` worker as the foreground command, so it uses the same single-worker lock, reconciliation, and catch-up rules. Install it from the repository root:

```sh
scripts/install-conversation-reminder-service.sh
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py status
```

The installer validates everything before it touches launchd. It checks for `python3` and Node 22 or newer (`CCDM_REMINDER_NODE` or `node` on `PATH`), the plist template and service script, and both provider adapters. It also runs the read-only `conversation-reminder-service.py preflight`, which checks the registry owner and project assignments, root Discord credentials, a private state directory, and a usable conversation store. If any check fails, the installer exits with status 2 and lists the blockers. It does not create or change the plist, launchd, the state directory, or file permissions, and it leaves a working installation loaded. It never changes Discord permissions.

On success, it renders `~/Library/LaunchAgents/com.discord.conversation-reminders.plist` and loads it. The plist holds only absolute paths: the Python interpreter, the service script, the repository, the state directory, Node, and the root state directory. It holds no tokens, registry values, or channel IDs. The worker reads credentials from their existing private files. `RunAtLoad` starts the worker at login. `KeepAlive` relaunches it only after an unsuccessful exit, with a 30-second throttle; a crash or a lost lock race is retried. The worker's umask is `077`. Standard output and errors go to `service.log` and `service.err` in the private state directory. Those logs contain status JSON, never credentials or conversation bodies.

Running the installer again gives the same plist and reloads it. If launchd rejects the replacement, the installer restores the previous plist and reloads the previous service. The installer does not change the Usage Stats Poster, its schedule, its LaunchAgent, or its storage.

Only one worker runs at a time. If a foreground `run` holds the lock when launchd starts the worker, such as at login, the supervised launch exits with status 2. launchd retries it every 30 seconds, and it takes over once the foreground worker exits. A foreground `run` started while the supervised worker holds the lock is refused the same way.

Operating the supervised worker:

- **Status:** `scripts/conversation-reminder-service.py status`. Each project's `readiness` lists its `blockers` with the action that clears them. See [Foreground commands](#foreground-commands).
- **Stop or disable:** `scripts/conversation-reminder-service.py disable`. The worker finishes any in-flight Discord request and exits successfully, so launchd does not relaunch it. At the next login the worker starts, sees `disabled`, and exits without observing or sending. Closures, history, due times, and delivery state are kept.
- **Re-enable:** `scripts/conversation-reminder-service.py enable`, then rerun `scripts/install-conversation-reminder-service.sh` to start the worker. Every previously ready channel reconciles before its next send.
- **Foreground start:** `scripts/conversation-reminder-service.py run`. If the supervised worker is running, stop it first with `disable` and wait for `worker_running: false`. Then run `enable` and `run`. launchd does not restart the supervised worker until its next load, such as a login or rerunning the installer.
- **Recovery:** `disable`, wait until `status` shows `worker_running: false`, then `enable` and `recover`. Afterwards rerun the installer. See uncertain-send recovery below.
- **Remove:** `disable`, then `launchctl unload ~/Library/LaunchAgents/com.discord.conversation-reminders.plist` and delete that file. Keep the state directory. Deleting it does not clear a closure and discards delivery history.

## Readiness and deployment

- **First enablement:** install the LaunchAgent (or start `run`), then run `enable`. `enable` requests discovery of older conversations. The worker scans each channel's history, then marks it `ready`. Until then, `status` shows `history: discovering` or `suspended-incomplete-discovery`, and nothing is sent. A discovered channel that is already overdue gets one globally spaced catch-up. See [History discovery](#history-discovery).
- **State location:** `~/.local/state/ccdm/conversation-reminders/`, or `CCDM_REMINDER_STATE_DIR` when it is set at install time. The directory is mode `0700`. The databases, worker lock, and service logs are `0600`, and the supervised worker's umask keeps new files private. It holds the event and conversation databases, the worker lock, Claude receipts, and the service logs. Keep it across restarts and upgrades.
- **Provider and version readiness:** `status` reports each project's provider and adapter status. Claude channels need the launch-scoped adapter at the pinned versions in the [Claude adapter guide](conversation-reminder-claude-adapter.md). Codex channels need the bridge adapter described in the [Codex adapter guide](conversation-reminder-codex-adapter.md). A channel whose adapter is blocked stays `suspended-adapter-capability` or `blocked-adapter-capability`. It does not fall back to guessing from silence. A Claude channel is ready only while its adapter launch is running: a stopped session, an adapter that exited, or a plain `scripts/start-session.sh <project>` restart without `CCDM_CLAUDE_REMINDER_ADAPTER=1` suspends it. When the adapter launch returns, the running worker notices within about 30 seconds and reconciles the channel before its next send.
- **Remote projects:** the operator deploys and verifies the authenticated, assignment-bound adapter on each remote host. Nothing here installs it remotely. A remote channel without it stays `blocked-adapter-capability`.
- **No live test required:** the default `npm test` suite proves the installer, the supervised and foreground worker, and both providers' reply, reminder, and reply-or-close workflows with Local Fakes. It does not use Discord, Claude, Codex, launchd, or credentials. Real Discord and provider checks belong to the opt-in Live Smoke Suite behind its Live Gate. Enabling reminders does not require one.
- **Cleanup and uncertain deliveries:** failed deletions stay pending by recorded message ID. An uncertain send suspends its channel as `suspended-uncertain-send` until the running worker, or `recover`, identifies the reminder by replaying its nonce or proves from history that none was created. See the recovery notes below.
- **Assignment retirement:** after any registration or deregistration, run `assignment-changed --project <project>`. See [Assignment changes](#assignment-changes).
- **History and reaction limits:** discovery and reconciliation cannot see deleted messages or reactions removed while nothing was observing. They cannot tell when an old reaction was added either. See [Time, order, and reaction limits](#time-order-and-reaction-limits).
- **Indefinite pauses:** any Conversation Reply, including a reaction (even one on a reminder), pauses the conversation until the agent next finishes a turn or asks for input. If no qualifying response follows, the conversation stays paused indefinitely. This is expected. Send a new message to restart the exchange.

## Foreground commands

From the repository root:

```sh
scripts/conversation-reminder-service.py status
scripts/conversation-reminder-service.py run
scripts/conversation-reminder-service.py disable
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py discover
scripts/conversation-reminder-service.py recover
scripts/conversation-reminder-service.py assignment-changed --project <project>
```

`run` is the foreground observer and delivery worker. One worker may run at a time. It checks due work every half second while healthy. `disable` persists the disabled setting and stops the worker. A Discord request already in flight finishes first, and its result is recorded. Disabling keeps closures, history, due times, and delivery state. `enable` clears the setting but does not start a worker, and every channel reconciles before its next send. `sync` performs one foreground pass over committed adapter events for diagnosis.

Use `status` to inspect the worker lock, each conversation's state and due time, unresolved intent nonces, pending cleanup or ✅ actions, and queued catch-ups. `delivery_enabled` is true only after `enable`, while not disabled and with both provider adapters installed. `readiness.projects.<project>` combines every gate for one channel:

- `adapter`: the provider adapter readiness report;
- `observation`: the worker's permission and access check;
- `history`: the channel's discovery or reconciliation status;
- `assignment`: registry problems, or `ok`;
- `uncertain_delivery`: unresolved nonces;
- `pending_cleanup`: reminder IDs still to delete;
- `catch_up_queued`: whether a catch-up is waiting its turn.

`delivery_ready` is true only when `blockers` is empty. Each blocker names an action, such as `run enable`, `run recover`, or the history reason. A Claude adapter blocker gives the relaunch command, `CCDM_CLAUDE_REMINDER_ADAPTER=1 scripts/start-session.sh <project>`. `history: untracked` means the service has no conversation state for the project yet: clear its other blockers, then start the worker, and after a registration change run `assignment-changed --project <project>`. `enable`, `disable`, `status`, the final output of `run`, and `recover` all include this report. The output contains no conversation bodies or credentials.

`recover` is a bounded, one-pass operator command. Stop the foreground worker with `disable`, wait for it to exit, then `enable` and run `recover`. It takes the same exclusive worker lock, so a concurrent manual or supervised worker cannot be taken over. It first applies committed events, resolves uncertain sends as described below, then retries known cleanup and ✅ actions by their recorded IDs. It never claims a new reminder; the only create it issues is the uncertain intent's own nonce replay. Run `status` afterward; repeat `recover` after fixing a transient lookup or cleanup failure. A dead worker releases the lock and can be recovered without removing the store. A resolved send leaves the channel `suspended-restart-reconciliation`; the next `run` reconciles it and, if it is overdue, sends its single catch-up. The running worker applies the same resolution by itself, retrying each unresolved intent with a backoff from five seconds to five minutes, so an ordinary network failure does not need an operator.

Every send attempt carries the claim's durable nonce with `enforce_nonce`. Discord documents that uniqueness for only the [past few minutes](https://docs.discord.com/developers/resources/message#create-message). A timeout, lost response, or 5xx may follow a created message, so the worker retries up to twice within seconds using the same nonce; Discord then returns the reminder it already created instead of posting another. A connection refused or a DNS failure before the request left the machine is an ordinary failure with backoff. A 429 is too. Neither is uncertain.

Recovery accepts only evidence bound to the intent. For two minutes after the claim, well inside Discord's duplicate-check window, it repeats the claim's exact create with the same nonce and `enforce_nonce`. Discord answers with the reminder the lost request created, or, if that request never arrived, creates the one reminder this nonce allows. Either way the returned message ID and timestamp are recorded as the reminder. A refused replay (401/403 or another 4xx) or an unanswered one leaves the intent unresolved and is retried.

After that window a replay could post a duplicate, and Discord does not return a message's nonce on a later history read. History can then only prove that nothing was created. Recovery pages back from the newest message only until it passes the claim window, from two minutes before to five minutes after the claim; it never scans to the start of the channel. If the whole window is visible, has closed, and holds no unrecorded `👀` from the assigned bot, the request provably created nothing; the channel then reconciles and may send again. An unrecorded bot `👀` in the window is never adopted or deleted, because nothing ties it to the intent: recovery lists it under `candidates` and keeps `suspended-uncertain-send`. If a listed message is a stray reminder, delete it in Discord and run `recover`; if it is an ordinary bot message, run `assignment-changed --project <project>` to retire the unresolved intent with its generation. Denied history lookup, incomplete bounded history, or an empty window that has not closed also leave the intent in `status`. Do not force a new send or reset the database. Restore bot access and retry. Restart reconciliation never releases a channel with an unresolved intent.

State is stored privately under `~/.local/state/ccdm/conversation-reminders/` by default. `CCDM_REMINDER_STATE_DIR` selects another private state directory. The conversation store is separate from the adapter event receiver and Usage Stats storage. Keep both the event and conversation databases across restarts; an unsupported or corrupt store blocks operation rather than being replaced. Do not delete them to clear a closed conversation; send a new normal owner message to reopen it.

For a reconciled channel, the assigned bot sends exactly `👀` with mentions disabled one hour after a qualifying response, then replaces the recorded message hourly. Each successful send starts a new hour from its actual send time. An owner Conversation Reply or `/close` cancels due work and queues deletion by recorded message ID; an accepted send that returns after cancellation is also queued for deletion. A failed send keeps the previous reminder. Discord 429 timing and bounded transient retries are respected; 401/403 suspends delivery. A lost response or 5xx is retried with the same nonce; if it stays ambiguous, or a send was interrupted, the channel suspends as `suspended-uncertain-send` instead of risking a duplicate. Failed deletions remain pending and block replacement; Discord 404 completes cleanup. An owner reaction on a recorded reminder is a Conversation Reply like any other owner reaction; the private recorded-ID list keeps it out of coding turns.

Do not edit the private database to change a channel's state. If access is lost, restore the assigned bot and channel permissions, then restart the worker (`disable`, wait for it to exit, `enable`, `run`). A restart moves access and assignment suspensions back through revalidation and reconciliation.

## Restart, reconnect, and catch-up

The following events may miss owner activity:

- a worker restart after a crash or `disable`;
- waking from sleep, or any other wall-clock jump of more than 30 seconds between the worker's quarter-second ticks;
- a Gateway disconnect, resume, or new session;
- `enable`.

Each one sets every ready channel to `suspended-restart-reconciliation`. While the Gateway is down, the worker neither scans nor sends. After a wake, the Gateway socket can look connected until discord.js misses a heartbeat. The worker therefore holds scans and sends for about 45 seconds unless a reconnect replaces the socket first. Adapter events for these channels stay unapplied in the durable event ledger. The worker then reruns the bounded, fair, checkpointed history traversal from discovery in `restart` mode (status `reconciling`). It uses the same per-pass page and reaction budgets, and it saves a cursor after every page, so an interrupted scan resumes. It pages backward only to the conversation's persisted acknowledgment, then forward to the newest message. It then checks reaction membership on messages after the owner's latest reply.

When the scan commits, missed changes apply in this order:

1. Newer owner messages, `/close`, and management commands, at their Discord times. A missed `/close` closes the conversation and still gets its ✅.
2. The buffered adapter events, such as completions that a still-running agent recorded during the gap.
3. Owner reactions, if the conversation is still awaiting the owner. A reaction on the current answer, or on a later message, pauses it. A reaction on an earlier message that no recorded event dates pauses it conservatively as `reaction-ordering-unresolved`.

History alone never arms a reminder during reconciliation; only live adapter completions do. Closed state, assignment generations, and unresolved delivery intents are preserved. `status` shows the result as the `discovery.basis` with `mode: restart`: `no-missed-activity`, `missed-owner-activity`, `owner-reaction-after-answer`, or `reaction-ordering-unresolved`. Denied or unavailable history suspends the channel as `suspended-discovery-history` with the reason and retry time. Restore the root bot's View Channel and Read Message History access.

A channel released while overdue, either by initial discovery or by reconciliation, gets at most one catch-up reminder. All initial and catch-up sends share one durable global gate, which spaces them at least five seconds apart. Neither a restart nor a second channel can bypass the gate. A Discord 429 on a catch-up pushes the gate to Discord's retry time. Missed hourly intervals are never replayed. The next reminder is due one hour after the catch-up's actual send, so a catch-up confirmed at 15:20 is next due at 16:20. A queued catch-up waits for pending cleanup of the previous reminder. It is dropped if the owner replies or closes, or if the assignment is retired or changed, before its turn. Nothing is sent while the host is asleep or offline.

### Time, order, and reaction limits

- Historical messages carry Discord timestamps, not turn-completion metadata. Missed owner activity applies at its Discord time; adapter events apply at their recorded times.
- History cannot show deleted messages. A reaction that was added and then removed while nothing was observing cannot be seen either. Both may be unrecoverable.
- The root observer and a Codex bridge both report a live owner reaction. The service counts copies of the same reaction (the same message, owner, and emoji within two minutes) once, so a delayed copy cannot clear a later reminder. Re-adding that emoji later is a new acknowledgment.
- Reaction membership shows who reacted, not when. Each message's first accounted owner reaction is remembered. A later owner reaction on that same earlier message, added while disconnected, is not detected.
- A reaction acknowledges the conversation and pauses it until the agent next finishes a turn or asks for input. If no qualifying response follows, the conversation stays paused indefinitely. Send a new message to restart the exchange.

## History discovery

`discover` persists the operator's request to discover older Project Conversations. It does not read Discord itself: the foreground `run` worker performs the scan while its observer is live, so owner activity during the scan is not missed. The request stays set, so a channel registered later is also discovered. `disable` stops scanning with the worker; progress is kept.

For each undiscovered channel, the worker records the newest message as an observation watermark and marks the channel `discovering`. Committed events for that assignment then stay unapplied in the event ledger until the scan commits. The worker pages backward with the root bot, up to 100 messages per page, until it finds the owner's latest normal message or `/close`, or reaches the start of the channel. There is no fixed recent-history cutoff. It then pages forward from the watermark to the newest message and checks reaction membership. Each channel gets at most 10 history pages and 10 reaction lookups per 30-second pass. The least-served channel goes next, so a long channel cannot starve others. Cursors are saved after every page, so a crash or restart resumes where the scan stopped. Discord 429 responses pause that channel for the advertised time. Other failures retry after 30 seconds.

A channel becomes eligible only when the owner's latest Conversation Reply is followed by a message from the currently assigned bot. The answer must come before any guest message that follows the reply. The first reminder is due one hour after that answer's Discord timestamp. Historical messages carry no turn-completion metadata, so status labels this basis `historical-owner-then-bot-approximation`. It is used only for discovery. Live completion and input-needed still require confirmed adapter receipts. These channels stay `open-paused`:

- no owner participation, such as a guest-only exchange;
- no bot answer after the owner's latest reply, which means the channel is waiting for the agent;
- a management command whose only follow-up is fixed CCDM command output, such as `Compaction queued.`;
- an interaction with recorded adapter lifecycle events (`active-turn`), which waits for the live completion.

A `/close` with no later normal owner message is `closed`. A closure already recorded by the service stays closed unless history shows a later normal owner message. Reminders are identified only by recorded message IDs; any other bot `👀` is an ordinary answer.

When the scan commits, the service writes this baseline, applies the buffered events on top of it, and then marks the channel `ready`. Newer owner messages, reactions, `/close`, and resumed work therefore win over the historical result. A live owner message that the scan already saw is not counted twice. The worker checks the assignment generation and conversation revision before committing. An assignment change discards the old scan, and the new generation is scanned from the start.

`status` shows `discovery_requested` and, for each conversation, a `discovery` object. It includes the phase, basis, pages scanned, passes, cursors, retry time, and reason. Denied or missing history, including a 403 on reaction lookup, suspends the channel as `suspended-discovery-history`. Delivery stays blocked, and the scan retries from its saved cursor after five minutes. Restore the root bot's View Channel and Read Message History access. Do not reset state.

Limitations: discovery cannot see deleted messages. It cannot see reactions that were added and removed before the scan, or reactions on messages older than the owner's latest reply. Reaction membership shows who reacted, not when. An owner reaction on the answer, or on a later message, acknowledges it. A reaction on an earlier message counts only when a recorded reaction event dates it. Otherwise the channel pauses as `reaction-ordering-unresolved`, which may last until the next qualifying bot response. A reaction list with 100 or more users is treated the same way. Discovery uses no model inference. A discovered channel that is already overdue receives one globally spaced catch-up, as described above.

## Assignment changes

Each Project Conversation belongs to one assignment generation: the project's `assignment_generation` in `registry.json`, or a hash of project, owner, channel, bot, app ID, and `registered_at`. The service reads the registry on every pass. When a project is deregistered or its owner, channel, bot, or generation changes, the old generation is retired before any further send. Its conversation state and due time are dropped, queued or replayed adapter events for it are rejected, pending ✅ acknowledgments are abandoned, and a claimed send is canceled before its request. A reminder that Discord accepts during the change is queued for cleanup. The replacement assignment starts fresh as `suspended-incomplete-discovery`.

Retired cleanup deletes only recorded reminder IDs. It uses only the retired assignment's own bot, and only while that bot is still in the pool and not assigned to another channel. It never borrows another pool bot or changes permissions. A 401, a 403, a missing token, or a reassigned bot moves the message to `cleanup.inaccessible` under `retired_assignments` in `status`, and `retired_cleanup_guidance` asks you to delete it manually in Discord. Retired leftovers and a retired generation's unresolved nonces never block the new generation.

Registration and deregistration are root-agent workflows, and polling cannot see a delete and identical re-add between passes. After writing, changing, or removing a project's registry entry, run `assignment-changed --project <project>`. It retires every known generation for that project and, when the project is registered, writes a fresh `assignment_generation` into `registry.json` with the file's existing mode. It then deletes the retired assignment's recorded reminders at once over REST with the retired bot, even while the worker is stopped, and reports the outcome under `retired_cleanup` (`completed`, `inaccessible`, `pending`). A reminder it cannot delete, including one Discord refuses after bounded retries, is reported `inaccessible` with its reason rather than left pending. Only a failure to run the cleanup at all leaves it `pending`, with `guidance` to start the worker or run `recover`. Never copy an old generation into a re-registration. If the service saw a deregistration and the identical identity returns, the channel reports `blocked-retired-generation` and `assignment_guidance` until this command issues a new generation. Running sessions use the new generation on their next event.

Ambiguous or incomplete entries, such as a shared channel, a missing token, or a duplicate bot record, move a ready or reconciling channel to `suspended-assignment`. The observer revalidates owner, uniqueness, root observation access, assigned-bot permissions, and adapter capability at startup, on each observed message, and whenever `registry.json` changes. A failure suspends only that assignment as `suspended-assignment`, `suspended-observation-access`, `suspended-delivery-access`, or `suspended-adapter-capability`. Restoring configuration or access does not resume delivery by itself, because observations may have been missed. The next worker start revalidates the channel and reconciles it before any send. Root and unassigned channels are never tracked. Remote Claude and Codex channels stay `blocked-adapter-capability` until an authenticated adapter is deployed and verified on that host. Stopping or restarting a project session or the root agent does not stop this service or change open or closed state.
