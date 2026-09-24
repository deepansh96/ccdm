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
```

`run` is the foreground observer and delivery worker. One worker may run at a time. It checks due work every half second while healthy. `disable` stops it after its current pass and persists the disabled setting; `enable` clears that setting but does not start a worker or bypass reconciliation. Use `status` to inspect the worker lock, channel access/capability status, and each conversation's state, revision, last acknowledgment, response, due time, cleanup IDs, and reconciliation checkpoint. The output contains no conversation bodies or credentials. `sync` performs one foreground pass over committed adapter events for diagnosis.

State is stored privately under `~/.local/state/ccdm/conversation-reminders/` by default. `CCDM_REMINDER_STATE_DIR` selects another private state directory. The conversation store is separate from the adapter event receiver and Usage Stats storage. Keep both the event and conversation databases across restarts; an unsupported or corrupt store blocks operation rather than being replaced. Do not delete them to clear a closed conversation; send a new normal owner message to reopen it.

For a reconciled channel, the assigned bot sends exactly `👀` with mentions disabled one hour after a qualifying response, then replaces the recorded message hourly. Each successful send starts a new hour from its actual send time. An owner Conversation Reply or `/close` cancels due work and queues deletion by recorded message ID; an accepted send that returns after cancellation is also queued for deletion. A failed send keeps the previous reminder. Discord 429 timing and bounded transient retries are respected; 401/403 suspends delivery. A lost response or interrupted send suspends as `suspended-uncertain-send` instead of risking a duplicate. Failed deletions remain pending and block replacement; Discord 404 completes cleanup. The private recorded-ID list excludes reactions on reminders from coding turns.

Discovery and observation-gap recovery are not implemented yet. New channels stay `suspended-incomplete-discovery`; a previously ready channel is set to `suspended-restart-reconciliation` on worker restart. No operator command can promote either state in this slice. The Local Fake E2E tests seed a reconciled prerequisite and drive the real foreground service with an external clock to demonstrate delivery. Do not edit the private database to enable production delivery. If access is lost, restore the assigned bot and channel permissions and inspect status; recovery from uncertain sends and historical gaps belongs to later slices.
