---
name: agents
description: Always-loaded project anchor for CCDM.
last_updated: 2026-11-10
---

# CCDM - Claude Code Discord Manager

## What This Is
CCDM manages isolated Claude Code and Codex Discord sessions for multiple local projects from one root bot.

## Non-Negotiables
- Read `.mex/ROUTER.md` before acting; load only the context and pattern files it routes to.
- Read `CLAUDE.local.md` when present for machine-specific setup and access rules; never copy its contents into tracked files.
- Never expose or commit Discord bot tokens, Codex credentials, Claude credentials, or `registry.json` secrets.
- Treat a channel-scoped Discord MCP restriction as the transport boundary for user-visible messages and message tools, not as a ban on explicitly requested root-management work. For authorized registration, deregistration, channel/category creation, webhook, role, permission, or invite tasks, use the documented CCDM scripts/workflow and the root bot's authenticated Discord REST API when required; never use another Discord MCP, broaden the requested targets, or expose credentials. A missing MCP administration tool is not by itself a blocker for these workflows.
- One session serves one project channel, enforced by the Router; stop existing listeners before starting replacements.
- When a restart request comes from or names a registered project channel, restart that project's isolated session; restart the root agent only when the user explicitly asks to restart root.
- Thread Conversations are independent of their channel: "restart <project>" and `scripts/ccdm stop-session <project>` act on the channel's session only, unless the request names its threads (`--threads` for threads only, `--all` for both). To restart one thread:
  - macOS: `scripts/threads.sh restart <name|link>`.
  - Windows: pending (#241).
- Root's thread permissions, Create Public Threads, Send Messages in Threads, Manage Threads and guild View Audit Log, are granted once by hand; never PATCH them from a script. `router status` reports any that are missing.
- Launch sessions only through `scripts/ccdm` (`start-session`, `start-codex-session`, `restart-session`, `session new`). It starts each session the right way for the OS: tmux on macOS, `ccdm-host` on Windows. Never start `claude`, the bridge, tmux or `ccdm-host` sessions by hand.
- To restart yourself, run `scripts/ccdm restart-root`; it detaches itself, so never use `nohup` or a background `&`.
- Send free text (a login code, a message) to a session with `scripts/ccdm session send <name> --stdin` or `--file <path>`, never as a command argument.
- Project Codex conversations can resume across homes/accounts: copy the verified rollout into the target home's matching `sessions/` path, then start with `--resume <thread_uuid>`.
- Follow `.mex/context/session-management.md` for the stop/copy/account-switch sequence; retain the source rollout, never overwrite a target rollout, and never copy credentials.

## Commands
- Test: `npm test`
- All commands: `scripts/ccdm --help` (run in the Bash tool on both macOS and Windows)
- List: `scripts/ccdm list`; one project: `scripts/ccdm status <project>`
- Start: `scripts/ccdm start-session <project>` (Claude) or `scripts/ccdm start-codex-session <project>` (Codex)
- Stop: `scripts/ccdm stop-session <project>`
- Restart: `scripts/ccdm restart-session <project>`
- Root's command list with triggers: `.mex/patterns/root-commands.md`
- Mex check: `npx mex-agent check`

## Navigation
Read `.mex/ROUTER.md` at the start of every session. After meaningful work, follow its GROW checklist. Update only scaffold files whose facts, state, or recurring workflow changed, then run `npx mex-agent check` after scaffold edits.
