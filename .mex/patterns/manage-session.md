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
last_updated: 2026-09-28
---

# Manage A Session

## Steps
1. Read the project and assigned bot from `registry.json`; treat a missing `type` as `claude`.
2. For start, run `scripts/start-session.sh <project>` or `scripts/start-codex-session.sh <project>` based on type.
3. For stop, run `scripts/stop-session.sh <project>`. For restart, stop fully before starting.
4. Capture the exact tmux pane and confirm the expected listener banner.
5. Confirm `registry.json` contains the current PID/session state without displaying secrets.

## Gotchas
- Never launch the bridge/plugin manually; the scripts provide required environment and duplicate-listener checks.
- A tmux session being absent does not prove the listener is stopped.
- Remote projects cannot be controlled through local tmux.
- Claude project launches always run behind the conversation-scoped proxy (`--dangerously-load-development-channels server:discord`), with or without the reminder adapter. The first launch of each project after this change stops at a one-time development-channel consent prompt in the tmux pane. Accept it once, then confirm the listener banner. A launch fails before tmux when Claude Code is older than 2.1.281 or the official Discord plugin is not installed in the selected Claude home.
- Codex starts fresh unless explicitly launched with `--resume <thread_uuid>`. For account/home migration, follow the history-preserving restart procedure in `context/session-management.md`; verify the saved rollout before stopping and retain the source for recovery.

## Verify
- [ ] Exactly one assigned listener exists.
- [ ] The bot is listening in the registered channel.
- [ ] Registry PID/session fields match the resulting state.

## Debug
Use `patterns/debug-discord-session.md`; do not bypass listener scans.

## Update Scaffold
- [ ] Update project state or lifecycle context if behavior changed.
