# Sync - Realign This Scaffold

## Recommended

```bash
npx mex-agent sync
```

Mex runs drift detection and then offers to invoke a configured AI tool, show the targeted prompts for manual use, or exit. Normal sync targets files with errors; include warning-only files with:

```bash
npx mex-agent sync --warnings
```

Preview without invoking an agent:

```bash
npx mex-agent sync --dry-run
```

## Manual Rules

When applying a generated prompt:

- Make surgical edits based on the current codebase.
- Preserve frontmatter fields and update only relevant edges.
- Never delete old decisions; mark superseded decisions and add the replacement.
- Update `last_updated` only in scaffold files that changed.
- Update `ROUTER.md` project state only when actual project state changed.
- Run `npx mex-agent check` afterward.

Mex's score checks structural drift, not factual completeness. Verify semantic claims against source and run the repository tests separately.
