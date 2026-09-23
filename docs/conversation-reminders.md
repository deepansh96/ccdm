# Project Conversation state service

This foreground service records owner acknowledgment, `/close`, reopening, and qualifying Claude or Codex responses. It runs independently of coding sessions. **Reminder delivery is disabled** in this slice; a due time in status does not cause a `👀` message.

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

`run` is the foreground observer. One worker may run at a time. `disable` stops it after its current pass and persists the disabled setting; `enable` clears that setting but does not start a worker. Use `status` to inspect the worker lock, channel access/capability status, and each conversation's state, revision, last acknowledgment, response, due time, cleanup IDs, and reconciliation checkpoint. The output contains no conversation bodies or credentials. `sync` performs one foreground pass over committed adapter events for diagnosis.

State is stored privately under `~/.local/state/ccdm/conversation-reminders/` by default. `CCDM_REMINDER_STATE_DIR` selects another private state directory. The conversation store is separate from the adapter event receiver and Usage Stats storage. Keep both the event and conversation databases across restarts; an unsupported or corrupt store blocks operation rather than being replaced. Do not delete them to clear a closed conversation; send a new normal owner message to reopen it.

The status `reconciliation_status` remains `suspended-incomplete-discovery` in this slice. Earlier channel history and observation gaps are not reconstructed yet. Existing closed state remains durable, and current events are still recorded, but the due time is informational until the later discovery and delivery slices are implemented. If a channel loses access or adapter capability, restore the existing assignment and permissions, then restart the foreground worker and inspect status; this service does not borrow another bot or enable delivery.
