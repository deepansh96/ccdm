---
name: agents
description: Always-loaded project anchor for CCDM.
last_updated: 2026-08-09
---

# CCDM - Claude Code Discord Manager

## What This Is
CCDM manages isolated Claude Code and Codex Discord sessions for multiple local projects from one root bot.

## Non-Negotiables
- Read `.mex/ROUTER.md` before acting; load only the context and pattern files it routes to.
- Read `CLAUDE.local.md` when present for machine-specific setup and access rules; never copy its contents into tracked files.
- Never expose or commit Discord bot tokens, Codex credentials, Claude credentials, or `registry.json` secrets.
- One project bot serves one assigned channel; stop existing listeners before starting replacements.
- When a restart request comes from or names a registered project channel, restart that project's isolated session; restart the root agent only when the user explicitly asks to restart root.
- Use `zsh -ic` for tmux launches so user-installed tools resolve correctly.

## Commands
- Test: `npm test`
- Start: `scripts/start-session.sh <project>` or `scripts/start-codex-session.sh <project>`
- Stop: `scripts/stop-session.sh <project>`
- Mex check: `npx mex-agent check`

## Navigation
Read `.mex/ROUTER.md` at the start of every session. After meaningful work, follow its GROW checklist. Update only scaffold files whose facts, state, or recurring workflow changed, then run `npx mex-agent check` after scaffold edits.
