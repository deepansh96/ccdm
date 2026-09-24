# Project Conversation state service

This foreground service records owner acknowledgment, `/close`, reopening, and qualifying Claude or Codex responses. It runs independently of coding sessions. Its delivery worker is implemented, but public enablement remains gated by incomplete discovery and restart reconciliation. A fresh registered channel reports `suspended-incomplete-discovery` and will not send even when a due time appears in status.

## Requirements

- `registry.json` must have one owner and an unambiguous project channel and assigned bot per project.
- The root Discord bot token must be in `ROOT_DISCORD_STATE_DIR/.env` as `DISCORD_BOT_TOKEN`; the default root state directory is `~/.claude/channels/discord`.
- The root bot must be able to view and read project channels. Assigned project bots need view, history, send, and reaction permissions in their own channels. The service checks these permissions and does not change them.
- Claude projects require the verified launch-scoped reminder adapter and its capability marker. Codex projects require the current bridge adapter. Unsupported and remote Claude assignments remain excluded.

## Foreground commands

From the repository root:

```sh
scripts/conversation-reminder-service.py status
scripts/conversation-reminder-service.py run
scripts/conversation-reminder-service.py disable
scripts/conversation-reminder-service.py enable
scripts/conversation-reminder-service.py recover
scripts/conversation-reminder-service.py assignment-changed --project <project>
```

`run` is the foreground observer and delivery worker. One worker may run at a time. It checks due work every half second while healthy. `disable` stops it after its current pass and persists the disabled setting; `enable` clears that setting but does not start a worker or bypass reconciliation. Use `status` to inspect the worker lock, channel access/capability status, each conversation's state and due time, unresolved intent nonces, and pending cleanup or ✅ actions. The output contains no conversation bodies or credentials. `sync` performs one foreground pass over committed adapter events for diagnosis.

`recover` is a bounded, one-pass operator command. Stop the foreground worker with `disable`, wait for it to exit, then `enable` and run `recover`. It takes the same exclusive worker lock, so a concurrent manual or supervised worker cannot be taken over. It first applies committed events, looks for uncertain sends in up to three pages of recent Discord history per intent, then retries known cleanup and ✅ actions by their recorded IDs. It never starts a new reminder send. Run `status` afterward; repeat `recover` after fixing a transient lookup or cleanup failure. A dead worker releases the lock and can be recovered without removing the store. Keep the observer stopped until the separate observation/history reconciliation gate is resolved.

Recovery confirms a reminder only when the assigned bot's message has the original durable nonce, exact `👀` content, a valid send timestamp, and a unique identity in the bounded history window. Discord documents `enforce_nonce` uniqueness for only the [past few minutes](https://docs.discord.com/developers/resources/message#create-message); recovery does not retry a POST, even during that window. A missing nonce, denied history lookup, multiple matches, or incomplete bounded history leaves `suspended-uncertain-send` and the original intent in `status`. Do not delete a matching emoji by eye, force a new send, or reset the database. Restore bot access and retry; if identity remains unavailable, investigate the listed nonce and keep delivery suspended. An observation/history gap remains a separate gate, and a confirmed recovered send remains `suspended-restart-reconciliation` until that gate is cleared by the later reconciliation workflow.

State is stored privately under `~/.local/state/ccdm/conversation-reminders/` by default. `CCDM_REMINDER_STATE_DIR` selects another private state directory. The conversation store is separate from the adapter event receiver and Usage Stats storage. Keep both the event and conversation databases across restarts; an unsupported or corrupt store blocks operation rather than being replaced. Do not delete them to clear a closed conversation; send a new normal owner message to reopen it.

For a reconciled channel, the assigned bot sends exactly `👀` with mentions disabled one hour after a qualifying response, then replaces the recorded message hourly. Each successful send starts a new hour from its actual send time. An owner Conversation Reply or `/close` cancels due work and queues deletion by recorded message ID; an accepted send that returns after cancellation is also queued for deletion. A failed send keeps the previous reminder. Discord 429 timing and bounded transient retries are respected; 401/403 suspends delivery. A lost response or interrupted send suspends as `suspended-uncertain-send` instead of risking a duplicate. Failed deletions remain pending and block replacement; Discord 404 completes cleanup. The private recorded-ID list excludes reactions on reminders from coding turns.

Discovery and observation-gap recovery are not implemented yet. New channels stay `suspended-incomplete-discovery`; a previously ready channel is set to `suspended-restart-reconciliation` on worker restart. `recover` only resolves delivery identities and known side effects; it cannot promote either observation state. The Local Fake E2E tests seed a reconciled prerequisite and drive the real foreground service with an external clock to demonstrate delivery. Do not edit the private database to enable production delivery. If access is lost, restore the assigned bot and channel permissions and inspect status.

## Assignment changes

Each Project Conversation belongs to one assignment generation: the project's `assignment_generation` in `registry.json`, or a hash of project, owner, channel, bot, app ID, and `registered_at`. The service reads the registry on every pass. When a project is deregistered or its owner, channel, bot, or generation changes, the old generation is retired before any further send. Its conversation state and due time are dropped, queued or replayed adapter events for it are rejected, pending ✅ acknowledgments are abandoned, and a claimed send is canceled before its request. A reminder that Discord accepts during the change is queued for cleanup. The replacement assignment starts fresh as `suspended-incomplete-discovery`.

Retired cleanup deletes only recorded reminder IDs. It uses only the retired assignment's own bot, and only while that bot is still in the pool and not assigned to another channel. It never borrows another pool bot or changes permissions. A 401, a 403, a missing token, or a reassigned bot moves the message to `cleanup.inaccessible` under `retired_assignments` in `status`; delete it manually in Discord if needed. Retired leftovers and a retired generation's unresolved nonces never block the new generation.

Registration and deregistration are root-agent workflows, and polling cannot see a delete and identical re-add between passes. After writing, changing, or removing a project's registry entry, run `assignment-changed --project <project>`. It retires every known generation for that project and, when the project is registered, writes a fresh `assignment_generation` into `registry.json` with the file's existing mode. Never copy an old generation into a re-registration. If the service saw a deregistration and the identical identity returns, the channel reports `blocked-retired-generation` and `assignment_guidance` until this command issues a new generation. Running sessions use the new generation on their next event.

Ambiguous or incomplete entries, such as a shared channel, a missing token, or a duplicate bot record, move a ready channel to `suspended-assignment`. The observer revalidates owner, uniqueness, root observation access, assigned-bot permissions, and adapter capability at startup, on each observed message, and whenever `registry.json` changes. A failure suspends only that assignment as `suspended-assignment`, `suspended-observation-access`, `suspended-delivery-access`, or `suspended-adapter-capability`. Restoring configuration or access does not resume delivery by itself, because observations may have been missed; the channel waits for the reconciliation gate. Root and unassigned channels are never tracked. Remote Claude and Codex channels stay `blocked-adapter-capability` until an authenticated adapter is deployed and verified on that host. Stopping or restarting a project session or the root agent does not stop this service or change open or closed state.
