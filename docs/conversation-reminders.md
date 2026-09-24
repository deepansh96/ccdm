# Project Conversation state service

This foreground service records owner acknowledgment, `/close`, reopening, and qualifying Claude or Codex responses, and sends hourly Conversation Reminders. It runs independently of coding sessions: stopping or restarting a project or root agent does not stop it or change conversation state. Reminders are opt-in. A registered channel reports `suspended-incomplete-discovery` and sends nothing until `enable` has run and discovery marks it `ready`.

## Requirements

- `registry.json` must have one owner and an unambiguous project channel and assigned bot per project.
- The root Discord bot token must be in `ROOT_DISCORD_STATE_DIR/.env` as `DISCORD_BOT_TOKEN`; the default root state directory is `~/.claude/channels/discord`.
- The root bot must be able to view and read project channels. Assigned project bots need view, history, send, and reaction permissions in their own channels. The service checks these permissions and does not change them.
- Claude projects require the verified launch-scoped reminder adapter and its capability marker. Codex projects require the current bridge adapter. Unsupported and remote Claude assignments remain excluded.
- Both provider adapters must be installed: `scripts/codex-bridge.js`, `scripts/discord-mcp-server.js`, `scripts/claude-reminder-channel.js`, `scripts/claude-reminder-hook.js`, and `scripts/conversation-reminder-adapter.js`. If any is missing, no channel receives reminders, including Codex channels. There is no Codex-only override.

## Enabling reminders

From the repository root:

```sh
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py run
```

`enable` is the manual opt-in. It checks the provider prerequisites, the registry owner, and that root Discord credentials are present. It also creates the private state directory with mode `0700`. If a check fails, it exits with status 2, lists the blockers under `preflight`, and changes nothing. It never prints tokens. On success it clears `disabled`, requests discovery of older conversations, and sends every previously ready channel back through restart reconciliation. `run` starts the foreground worker. The worker verifies each channel's Discord permissions when it connects and records failures per channel.

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

`delivery_ready` is true only when `blockers` is empty. Each blocker names an action, such as `run enable`, `run recover`, or the history reason. `enable`, `disable`, `status`, the final output of `run`, and `recover` all include this report. The output contains no conversation bodies or credentials.

`recover` is a bounded, one-pass operator command. Stop the foreground worker with `disable`, wait for it to exit, then `enable` and run `recover`. It takes the same exclusive worker lock, so a concurrent manual or supervised worker cannot be taken over. It first applies committed events, looks for uncertain sends in up to three pages of recent Discord history per intent, then retries known cleanup and ✅ actions by their recorded IDs. It never starts a new reminder send. Run `status` afterward; repeat `recover` after fixing a transient lookup or cleanup failure. A dead worker releases the lock and can be recovered without removing the store. A confirmed send leaves the channel `suspended-restart-reconciliation`; the next `run` reconciles it and, if it is overdue, sends its single catch-up.

Recovery confirms a reminder only when the assigned bot's message has the original durable nonce, exact `👀` content, a valid send timestamp, and a unique identity in the bounded history window. Discord documents `enforce_nonce` uniqueness for only the [past few minutes](https://docs.discord.com/developers/resources/message#create-message); recovery does not retry a POST, even during that window. A missing nonce, denied history lookup, multiple matches, or incomplete bounded history leaves `suspended-uncertain-send` and the original intent in `status`. Do not delete a matching emoji by eye, force a new send, or reset the database. Restore bot access and retry; if identity remains unavailable, investigate the listed nonce and keep delivery suspended. Restart reconciliation never releases a channel with an unresolved intent.

State is stored privately under `~/.local/state/ccdm/conversation-reminders/` by default. `CCDM_REMINDER_STATE_DIR` selects another private state directory. The conversation store is separate from the adapter event receiver and Usage Stats storage. Keep both the event and conversation databases across restarts; an unsupported or corrupt store blocks operation rather than being replaced. Do not delete them to clear a closed conversation; send a new normal owner message to reopen it.

For a reconciled channel, the assigned bot sends exactly `👀` with mentions disabled one hour after a qualifying response, then replaces the recorded message hourly. Each successful send starts a new hour from its actual send time. An owner Conversation Reply or `/close` cancels due work and queues deletion by recorded message ID; an accepted send that returns after cancellation is also queued for deletion. A failed send keeps the previous reminder. Discord 429 timing and bounded transient retries are respected; 401/403 suspends delivery. A lost response or interrupted send suspends as `suspended-uncertain-send` instead of risking a duplicate. Failed deletions remain pending and block replacement; Discord 404 completes cleanup. The private recorded-ID list excludes reactions on reminders from coding turns.

Do not edit the private database to change a channel's state. If access is lost, restore the assigned bot and channel permissions, then restart the worker (`disable`, wait for it to exit, `enable`, `run`). A restart moves access and assignment suspensions back through revalidation and reconciliation.

## Restart, reconnect, and catch-up

The following events may miss owner activity:

- a worker restart after a crash, sleep, or `disable`;
- a Gateway disconnect, resume, or new session;
- `enable`.

Each one sets every ready channel to `suspended-restart-reconciliation`. While the Gateway is down, the worker neither scans nor sends. Adapter events for these channels stay unapplied in the durable event ledger. The worker then reruns the bounded, fair, checkpointed history traversal from discovery in `restart` mode (status `reconciling`). It uses the same per-pass page and reaction budgets, and it saves a cursor after every page, so an interrupted scan resumes. It pages backward only to the conversation's persisted acknowledgment, then forward to the newest message. It then checks reaction membership on messages after the owner's latest reply.

When the scan commits, missed changes apply in this order:

1. Newer owner messages, `/close`, and management commands, at their Discord times. A missed `/close` closes the conversation and still gets its ✅.
2. The buffered adapter events, such as completions that a still-running agent recorded during the gap.
3. Owner reactions, if the conversation is still awaiting the owner. A reaction on the current answer, or on a later message, pauses it. A reaction on an earlier message that no recorded event dates pauses it conservatively as `reaction-ordering-unresolved`.

History alone never arms a reminder during reconciliation; only live adapter completions do. Closed state, assignment generations, and unresolved delivery intents are preserved. `status` shows the result as the `discovery.basis` with `mode: restart`: `no-missed-activity`, `missed-owner-activity`, `owner-reaction-after-answer`, or `reaction-ordering-unresolved`. Denied or unavailable history suspends the channel as `suspended-discovery-history` with the reason and retry time. Restore the root bot's View Channel and Read Message History access.

A channel released while overdue, either by initial discovery or by reconciliation, gets at most one catch-up reminder. All initial and catch-up sends share one durable global gate, which spaces them at least five seconds apart. Neither a restart nor a second channel can bypass the gate. A Discord 429 on a catch-up pushes the gate to Discord's retry time. Missed hourly intervals are never replayed. The next reminder is due one hour after the catch-up's actual send, so a catch-up confirmed at 15:20 is next due at 16:20. A queued catch-up waits for pending cleanup of the previous reminder. It is dropped if the owner replies or closes, or if the assignment is retired or changed, before its turn. Nothing is sent while the host is asleep or offline.

### Time, order, and reaction limits

- Historical messages carry Discord timestamps, not turn-completion metadata. Missed owner activity applies at its Discord time; adapter events apply at their recorded times.
- History cannot show deleted messages. A reaction that was added and then removed while nothing was observing cannot be seen either. Both may be unrecoverable.
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

Retired cleanup deletes only recorded reminder IDs. It uses only the retired assignment's own bot, and only while that bot is still in the pool and not assigned to another channel. It never borrows another pool bot or changes permissions. A 401, a 403, a missing token, or a reassigned bot moves the message to `cleanup.inaccessible` under `retired_assignments` in `status`; delete it manually in Discord if needed. Retired leftovers and a retired generation's unresolved nonces never block the new generation.

Registration and deregistration are root-agent workflows, and polling cannot see a delete and identical re-add between passes. After writing, changing, or removing a project's registry entry, run `assignment-changed --project <project>`. It retires every known generation for that project and, when the project is registered, writes a fresh `assignment_generation` into `registry.json` with the file's existing mode. Never copy an old generation into a re-registration. If the service saw a deregistration and the identical identity returns, the channel reports `blocked-retired-generation` and `assignment_guidance` until this command issues a new generation. Running sessions use the new generation on their next event.

Ambiguous or incomplete entries, such as a shared channel, a missing token, or a duplicate bot record, move a ready or reconciling channel to `suspended-assignment`. The observer revalidates owner, uniqueness, root observation access, assigned-bot permissions, and adapter capability at startup, on each observed message, and whenever `registry.json` changes. A failure suspends only that assignment as `suspended-assignment`, `suspended-observation-access`, `suspended-delivery-access`, or `suspended-adapter-capability`. Restoring configuration or access does not resume delivery by itself, because observations may have been missed. The next worker start revalidates the channel and reconciles it before any send. Root and unassigned channels are never tracked. Remote Claude and Codex channels stay `blocked-adapter-capability` until an authenticated adapter is deployed and verified on that host. Stopping or restarting a project session or the root agent does not stop this service or change open or closed state.
