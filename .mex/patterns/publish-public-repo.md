---
name: publish-public-repo
description: Audit a CCDM publication candidate for private data before an authorized commit and push.
triggers:
  - "public repo audit"
  - "commit and push"
edges:
  - target: context/conventions.md
    condition: always before staging changes
  - target: context/discord-security.md
    condition: when reviewing credentials and local operational notes
last_updated: 2026-09-07
---

# Publish The Public Repository

## Steps
1. Fetch the target branch and inspect working changes and outgoing commits. Preserve unrelated work and upstream changes; use an isolated worktree when integrating a dirty feature branch.
2. Audit the exact candidate tree for real credentials, Discord identifiers, private account/project labels, personal paths, local reports, databases, and generated files. Compare against known local secrets in memory without printing them. Run secret detection without online credential verification and review findings individually.
3. Keep machine-specific audit outcomes in ignored `CLAUDE.local.md`. Publish general procedures rather than a local server inventory or credential status. Keep agent event journals, Python caches, and usage databases ignored.
4. Review commit metadata as well as files. Use the user's verified GitHub no-reply address when avoiding publication of a personal email. Review every commit that would become reachable; a sanitized squash onto the current target can exclude unwanted feature-branch history without rewriting existing public history.
5. Stage explicit reviewed changes, run the tests and scaffold checks against the integrated candidate, and scan the staged tree again. Preserve the authorization's target branch and never force-push to resolve a race.
6. Push only after checks pass. Verify the remote target hash matches the published commit and report any remaining limitations.

## Gotchas
- CCDM's live registry and root state contain real credentials; never copy them into an audit worktree or a test fixture.
- Dummy fixture tokens, example email addresses, and the PNG magic bytes can trigger secret scanners. Inspect them rather than suppressing whole files.
- A clean final tree does not remove sensitive data from earlier commits included in a normal merge.
- An isolated worktree can select a different Python installation than the working checkout. Verify its interpreter and Pillow dependency before running the full suite; use the validated development interpreter without copying local credentials.
- Fresh integration tests may expose fixtures that depended on an implicit pool-root identity. Update fixtures to represent the explicit root configuration and re-run the failing case and required suite.

## Verify
- [ ] No secrets, local configuration, private operational notes, or generated artifacts are staged.
- [ ] The integrated candidate retains upstream changes and passes required tests.
- [ ] New commit metadata is suitable for publication.
- [ ] Remote branch and published commit hashes match after pushing.
