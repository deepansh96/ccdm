---
name: operate-conversation-reminders
description: Install, enable, inspect, disable, re-enable, or recover the Conversation Reminder service and its opt-in macOS LaunchAgent.
triggers:
  - "conversation reminders"
  - "reminder service"
  - "reminder launchagent"
  - "enable reminders"
edges:
  - target: context/architecture.md
    condition: when the reminder service's relationship to adapters or sessions is unclear
  - target: context/session-management.md
    condition: when a registration or deregistration also changes reminder assignments
last_updated: 2026-11-10
---

# Operate Conversation Reminders

## Context
Read `docs/conversation-reminders.md`. The service runs independently of coding sessions and uses the root bot to observe. It observes as the Router's read-only `observer` client and sends every reminder as the root bot. On macOS the LaunchAgent supervises the same `run` worker, so foreground and supervised launches share one worker lock.

The worker runs on both OSes. On Windows nothing supervises it yet, so it runs in the foreground with `scripts/ccdm reminders run`; `scripts/ccdm reminders --help` lists the verbs. A step that still waits for Windows is marked pending with the issue that adds it.

## Steps
1. Install supervision only when the operator asks.
   - macOS: run `scripts/install-conversation-reminder-service.sh`. It runs the read-only `preflight` and exits with status 2, with nothing changed, if a check fails.
   - Windows: pending (#249). No scheduled task runs the worker yet; start it by hand as in step 7.
2. macOS: opt in with `scripts/conversation-reminder-service.py enable`. A blocked enable changes nothing, including the state directory. Discovery runs in the worker. Wait for each channel's `history` to reach `ready` in `status`.
3. macOS: inspect with `scripts/conversation-reminder-service.py status`. Each `readiness.projects.<project>.blockers` entry names the fix.
4. macOS: to stop, run `scripts/conversation-reminder-service.py disable`. The supervised worker exits successfully and launchd does not relaunch it.
5. macOS: to re-enable, run `enable`, then rerun the installer to start the supervised worker. Channels reconcile before sending.
6. macOS: the running worker resolves uncertain sends by itself: it replays the intent's nonce inside Discord's duplicate-check window, and afterwards releases the channel only when history proves nothing was sent. If one stays unresolved, or cleanup is stuck, run `disable`, wait for `worker_running: false`, then `enable` and `recover`. Then rerun the installer. If `recover` lists unbound `candidates`, delete a stray reminder in Discord and recover again, or run step 8.
7. Windows: steps 2 to 6 go through `scripts/ccdm reminders`, and the worker runs in a terminal that stays open.
   - Windows: opt in with `scripts/ccdm reminders enable`, then start the worker with `scripts/ccdm reminders run`. A blocked enable changes nothing, including the state directory. Wait for each channel's `history` to reach `ready` in `scripts/ccdm reminders status`.
   - Windows: inspect with `scripts/ccdm reminders status`. Each `readiness.projects.<project>.blockers` entry names the fix; where it names a shell script, run the `scripts/ccdm` command of the same name.
   - Windows: to stop, run `scripts/ccdm reminders disable` from another terminal. The worker asks its observer to stop by closing its input, waits up to 15 seconds for it, and exits; `status` then shows `worker_running: false`. If the worker is ended any other way, the observer sees its input close and exits by itself.
   - Windows: to re-enable, run `scripts/ccdm reminders enable`, then `scripts/ccdm reminders run` again. Channels reconcile before sending.
   - Windows: if a send stays unresolved or cleanup is stuck, run `scripts/ccdm reminders disable`, wait for `worker_running: false`, then run `scripts/ccdm reminders enable` and `scripts/ccdm reminders recover`, and start the worker again. Unbound `candidates` are handled as in step 6.
8. After registration or deregistration, on both OSes run `scripts/ccdm reminders assignment-changed --project <project>`. It deletes retired reminders at once as root; check `retired_cleanup` in its output and delete any `inaccessible` message manually.

## Gotchas
- Never edit or delete the private databases to clear state; a new owner message reopens a closed conversation.
- Recovery never adopts or deletes a bot `👀` found in history; only a nonce replay or a recorded message ID identifies a reminder.
- A reaction, including one on a reminder, can pause a conversation indefinitely until the next qualifying agent response; this is expected.
- A Claude channel is ready only while its launch's CCDM channel server runs; `scripts/ccdm start-session <project>` relaunches it. The retired reminder proxy and `CCDM_CLAUDE_REMINDER_ADAPTER=1` no longer exist.
- `scripts/ccdm start-session` accepts the `--dangerously-load-development-channels server:ccdm` first-use consent in the session itself; the capability marker written after the channel server's Router hello is the real proof.
- Sleep or a clock jump is handled like a restart: channels reconcile before any send, and overdue channels get spaced catch-ups.
- Do not run live Discord or launchd checks as part of default tests; the Live Smoke Suite is separately gated.
- macOS: the installer never touches the Usage Stats Poster LaunchAgent or its storage.

## Verify
- [ ] `status` shows `worker_running: true` and `delivery_ready` for the intended projects, or blockers with actionable causes.
- [ ] macOS: `~/Library/LaunchAgents/com.discord.conversation-reminders.plist` contains paths only, with no tokens.
- [ ] macOS: the state directory is mode `0700`.
- [ ] Windows: `scripts/ccdm reminders status` answers without a `permissions are not private` reason. The state directory must be protected from inherited permissions; `scripts/ccdm reminders enable` creates it that way.
- [ ] Windows: after `scripts/ccdm reminders disable`, no `conversation-reminder-observer.js` process is left.

## Debug
- macOS: check `service.log` and `service.err` in the state directory for the worker's status JSON.
- Windows: the foreground worker prints its status JSON and errors in its own terminal.
- `already running` in the logs means another worker holds the lock. On macOS launchd retries every 30 seconds. On Windows the foreground worker prints the same reason and exits with status 2.
- A preflight failure lists its blockers on the installer's stderr.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` state if supervision behavior changes.
- [ ] Update `docs/conversation-reminders.md` for operator-visible changes.
