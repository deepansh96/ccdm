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
last_updated: 2026-09-24
---

# Operate Conversation Reminders

## Context
Read `docs/conversation-reminders.md`. The service runs independently of coding sessions and uses the root bot to observe. It sends through each project's assigned bot. The LaunchAgent supervises the same `run` worker, so foreground and supervised launches share one worker lock.

## Steps
1. Install supervision only when the operator asks: `scripts/install-conversation-reminder-service.sh`. It runs the read-only `preflight` and exits with status 2, with nothing changed, if a check fails.
2. Opt in with `scripts/conversation-reminder-service.py enable`. Discovery runs in the worker. Wait for each channel's `history` to reach `ready` in `status`.
3. Inspect with `status`. Each `readiness.projects.<project>.blockers` entry names the fix.
4. To stop, run `disable`. The supervised worker exits successfully and launchd does not relaunch it.
5. To re-enable, run `enable`, then rerun the installer to start the supervised worker. Channels reconcile before sending.
6. The running worker resolves uncertain sends from history by itself. If one stays unresolved, or cleanup is stuck, run `disable`, wait for `worker_running: false`, then `enable` and `recover`. Then rerun the installer.
7. After registration or deregistration, run `assignment-changed --project <project>`.

## Gotchas
- Never edit or delete the private databases to clear state; a new owner message reopens a closed conversation.
- A reaction, including one on a reminder, can pause a conversation indefinitely until the next qualifying agent response; this is expected.
- A Claude channel is ready only while its adapter launch runs. A plain `scripts/start-session.sh <project>` restart without `CCDM_CLAUDE_REMINDER_ADAPTER=1` leaves it blocked.
- Sleep or a clock jump is handled like a restart: channels reconcile before any send, and overdue channels get spaced catch-ups.
- Do not run live Discord or launchd checks as part of default tests; the Live Smoke Suite is separately gated.
- The installer never touches the Usage Stats Poster LaunchAgent or its storage.

## Verify
- [ ] `status` shows `worker_running: true` and `delivery_ready` for the intended projects, or blockers with actionable causes.
- [ ] `~/Library/LaunchAgents/com.discord.conversation-reminders.plist` contains paths only, with no tokens.
- [ ] The state directory is mode `0700`.

## Debug
- Check `service.log` and `service.err` in the state directory for the worker's status JSON.
- `already running` in the logs means another worker holds the lock. launchd retries every 30 seconds.
- A preflight failure lists its blockers on the installer's stderr.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` state if supervision behavior changes.
- [ ] Update `docs/conversation-reminders.md` for operator-visible changes.
