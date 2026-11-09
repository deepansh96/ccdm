---
name: manage-session
description: Start, stop, or restart a registered Claude or Codex project safely.
triggers:
  - "start project"
  - "stop project"
  - "restart project"
edges:
  - target: context/session-management.md
    condition: always before changing session state
  - target: patterns/root-commands.md
    condition: for the trigger words and the one-line command for each request
last_updated: 2026-11-10
---

# Manage A Session

## Steps
The commands are the same on macOS and Windows. Run them with the Bash tool from the CCDM checkout.

1. Read the project from `registry.json`; treat a missing `type` as `claude`. `scripts/ccdm status <project>` shows whether its session is live.
2. For start, run `scripts/ccdm start-session <project>` for Claude or `scripts/ccdm start-codex-session <project>` for Codex.
3. For stop, run `scripts/ccdm stop-session <project>`.
4. For restart, run `scripts/ccdm restart-session <project>`. It stops fully before it starts. If it fails, read `~/.local/state/ccdm/logs/restart-<project>.log`.
5. Read the session's screen with `scripts/ccdm session capture <screen_name>` and confirm the expected listener banner.
6. Confirm `registry.json` contains the current PID/session state without displaying secrets.

## Gotchas
- Never launch the bridge or Claude manually; the commands provide the required environment and duplicate-listener checks.
- A session being absent does not prove the listener is stopped. `scripts/ccdm stop-session <project>` sweeps leftover listeners.
- Remote projects cannot be controlled from this machine.
- After a failed stop, `scripts/ccdm restart-session <project>` starts nothing and leaves the registry as it was. Fix the cause and run it again.
- `scripts/ccdm session capture <screen_name>` exits 1 with `not running` when the session has ended.
- The owner can watch a live session from a terminal with `scripts/ccdm attach <project>`; Ctrl-] leaves it running. Root never attaches.
- Codex starts fresh unless explicitly launched with `--resume <thread_uuid>`. For account/home migration, follow the history-preserving restart procedure in `context/session-management.md`; verify the saved rollout before stopping and retain the source for recovery.

## Verify
- [ ] Exactly one assigned listener exists.
- [ ] `node scripts/router.js status` shows the session connected in the registered channel.
- [ ] Registry PID/session fields match the resulting state.

## Debug
Use `patterns/debug-discord-session.md`; do not bypass listener scans.

## Update Scaffold
- [ ] Update project state or lifecycle context if behavior changed.
