# Setup - Populate This Scaffold

This file covers mex setup, not the repository development environment. For development setup, read `context/setup.md`.

## Recommended

From the repository root, run:

```bash
npx mex-agent setup
```

The command detects the project, creates `.mex/`, asks which AI tools to configure, scans the codebase, and prints a targeted population prompt. This repository is already populated for Claude and Codex; rerun setup only when rebuilding the scaffold.

## Verify

```bash
npx mex-agent check
npx mex-agent doctor
```

Then start a fresh agent session and ask it to read `.mex/ROUTER.md`. It should identify the architecture, non-negotiables, current state, and task patterns without loading every project document.

## Keep It Current

- `npx mex-agent check` - deterministic drift report.
- `npx mex-agent sync` - build targeted prompts for error-bearing files.
- `npx mex-agent sync --warnings` - include warning-only files.
- `npx mex-agent log "<note>"` - record useful decisions, risks, todos, or notes.
- `npx mex-agent watch` - install the post-commit drift check.

Follow GROW in `ROUTER.md`; do not rewrite unchanged scaffold files after every task.

## Telemetry

Mex enables anonymous command telemetry by default. To disable it globally, run `npx mex-agent config set telemetry off` or set `DO_NOT_TRACK=1`.
