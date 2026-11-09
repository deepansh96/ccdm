---
name: root-commands
description: Root's everyday commands on macOS and Windows (list, status, start, stop, restart, context report, restart yourself, create a poll), each with its triggers and its `scripts/ccdm` command.
triggers:
  - "list"
  - "status"
  - "what's running"
  - "start project"
  - "stop project"
  - "restart project"
  - "context report"
  - "restart yourself"
  - "poll"
edges:
  - target: context/session-management.md
    condition: before changing session state, for the lifecycle rules behind these commands
  - target: patterns/manage-session.md
    condition: when a start, stop or restart needs its checks and gotchas
  - target: patterns/register-project.md
    condition: when the request is to register or deregister a project
  - target: patterns/debug-discord-session.md
    condition: when a command here fails or a session does not answer
last_updated: 2026-11-10
---

# Root Commands

## Context
Root runs every command here with the Bash tool, from the CCDM checkout. On Windows the Bash tool is Git Bash, so the same `scripts/ccdm` line works on both OSes. `scripts/ccdm --help` lists every command. `scripts/ccdm <command> --help` shows its arguments.

A session is a tmux session on macOS and a `ccdm-host` session on Windows. On both, its name is the project's `screen_name` in `registry.json`. Root's own session is `root_agent`.

Rules for every command:
- Start, stop and restart sessions only with the commands below. Never start one by hand.
- Never pass free text as a command argument. Send it with `scripts/ccdm session send <name> --stdin` or `--file <path>`.
- A restart request that comes from a project channel, or names a project, restarts that project. Restart root only when the user explicitly asks for root.

## Steps

### List and status
Triggers: `list`, `status`, `what's running`.

1. Run `scripts/ccdm list`. Each line has the project, its type, its `screen_name`, `live` or `stopped`, and the pid or `-`, separated by tabs.
2. For one project, run `scripts/ccdm status <project>`. It adds the conversation id. Add `--json` to either command when you need to parse the output.
3. Report which projects are live and which are stopped.
4. If the user asks about the Router, run `node scripts/router.js status`.

When no session host is running, both commands print a warning, show every project as stopped and exit 0.

### Start a project
Triggers: `start <project>`.

1. Read the project's `type` in `registry.json`. A missing `type` means `claude`.
2. For Claude, run `scripts/ccdm start-session <project>`. For Codex, run `scripts/ccdm start-codex-session <project>`.
3. A non-zero exit means the launch failed and was cleaned up. Report its error text.
4. Run `node scripts/router.js status` and confirm the project is connected in its channel.

To resume a saved conversation, add `--resume <session_id>` for Claude or `--resume <thread_uuid>` for Codex.

### Stop a project
Triggers: `stop <project>`.

1. Run `scripts/ccdm stop-session <project>`. It ends the session and its processes, sweeps leftover listeners, removes the launch key, and clears `pid` and `session_id`.
2. Tell the user that messages to the channel now get 💤.

This stops the channel's session only. Add `--threads` to stop only the project's Thread Conversations, or `--all` to stop both.

Never stop a project any other way:
- macOS: never use only `tmux kill-session`. It leaves listeners running.
- Windows: never use only `scripts/ccdm session kill`. It leaves listeners, the launch key and the registry state behind.

### Restart a project
Triggers: `restart <project>`, or a restart request from a project channel.

1. Run `scripts/ccdm restart-session <project>`. It stops the session fully, then starts it again for its type.
2. If it fails, read `~/.local/state/ccdm/logs/restart-<project>.log`. After a failed stop nothing is started and the registry is left as it was, so you can run the command again.
3. Run `scripts/ccdm status <project>` and `node scripts/router.js status` to confirm the session is live and connected.

It restarts the channel's session only. It never restarts the project's threads, and it refuses root.

### Context report
Triggers: `context report`, `context for all`.

1. Run `scripts/ccdm context report`. It sends `/context` to every live local Claude project and prints each context screen.
2. In each screen, find the tokens line (for example `20k/1m tokens (2%)`) and the category breakdown.
3. Report tokens used, total, percentage and free space for each project.

The report covers registered Claude projects only. It skips Codex projects, Thread Conversations, `remote:` projects and root.

For one session, run `scripts/ccdm session context <screen_name>`. Never run it on your own session: you are busy running the command, so it times out.

### Restart yourself
Triggers: `restart yourself`, `restart root`, `restart self`. Do this only when the user explicitly asks to restart root.

1. Send the user your message that you are restarting first. The command exits before the restart is done, and the restart stops you, so you cannot report afterwards.
2. Run `scripts/ccdm restart-root` for root Claude. For root Codex, run `scripts/ccdm restart-root --provider codex`, and add the root channel id as the last argument when the registry lists more than one root channel. A channel id without `--provider codex` is a usage error (exit 2).
3. Run it as a normal foreground command and do nothing else. It detaches itself: it hands the restart to a detached copy, prints that copy's log path (`~/.local/state/ccdm/logs/restart-root-root_agent.log`) and exits 0. The copy then stops you and starts a fresh root in the `root_agent` session.

Never put the command in the background yourself, and never wrap it in another launcher.

The command checks the Router before it hands off. If the Router does not answer, it prints the refusal at once, exits 1 and changes nothing, so you keep running. Tell the user what it printed, fix the Router, then ask again.

If the new root does not come up, the user can read that log and watch the session from a terminal with `scripts/ccdm attach root`.

- macOS: from a terminal, `./restart-root-agent.sh` and `./restart-root-codex-agent.sh [<channel_id>]` run the same command.
- Windows: root Codex is not supported yet, so `--provider codex` is refused.

### Create a poll
Triggers: `poll`, `create a poll`.

1. Post only in a root channel or a registered project channel the user named.
2. Read the root token from root's `.env` (`~/.claude/channels/discord/.env`, or `$ROOT_DISCORD_STATE_DIR/.env`) into `ROOT_TOKEN` inside the same shell command. Never print it.
3. Send the poll with the Discord API. The command is the same on macOS and Windows:
   ```sh
   curl -s -X POST "https://discord.com/api/v10/channels/<channel_id>/messages" \
     -H "Authorization: Bot $ROOT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "content": "",
       "poll": {
         "question": {"text": "<question>"},
         "answers": [
           {"poll_media": {"text": "<option1>"}},
           {"poll_media": {"text": "<option2>"}}
         ],
         "duration": 24,
         "allow_multiselect": false
       }
     }'
   ```
4. Check the response for an `id`. An error response names what was wrong.

- `duration` is in hours, from 1 to 168.
- `answers` holds up to 10 options. Each may add an emoji: `"emoji": {"id": null, "name": "🎉"}` inside `poll_media`.
- `allow_multiselect` lets users vote for more than one option.

## Gotchas
- `scripts/ccdm` must run in the Bash tool. In PowerShell or cmd the entry is `scripts\ccdm.cmd`, where `&` and `|` inside an argument can run as commands. That is why free text goes through `--stdin` or `--file`.
- A session that is stopped in `scripts/ccdm list` can still have a leftover listener. `scripts/ccdm stop-session <project>` sweeps it.
- `scripts/ccdm restart-session <project>` run from inside that project's own session hands off and exits 0 before the restart is done. Root is never inside a project session, so root sees the real result.
- On Windows a command's output says "session" where macOS says "tmux session". Accept both wordings.

## Verify
- [ ] `scripts/ccdm list` shows the state you reported.
- [ ] After a start or restart, `node scripts/router.js status` shows exactly one session for the project, in its channel.
- [ ] After a stop, the project is `stopped` and its `pid` and `session_id` are cleared in `registry.json`.
- [ ] No token, key or code was printed or passed as a command argument.

## Debug
- A command that is not in `scripts/ccdm --help` does not exist yet. Do not guess another name; tell the user.
- For a session that does not answer, follow `patterns/debug-discord-session.md`.

## Update Scaffold
- [ ] When a root command is added or changes, update this file, root's entry in `CLAUDE.md.example`, and `.mex/ROUTER.md` state.
