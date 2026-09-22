---
name: setup-deepseek-codex
description: Configure and test a separate DeepSeek Flash Codex home without changing other accounts.
triggers:
  - "DeepSeek"
  - "V4.1 Flash"
edges:
  - target: context/session-management.md
    condition: when selecting the home on a registered project
  - target: context/discord-security.md
    condition: when handling credentials or testing Discord integration
last_updated: 2026-09-22
---

# Set Up DeepSeek For Codex

## Steps
1. Verify the requested model's API name against DeepSeek's current model reference. V4.1 Flash uses `deepseek-flash` as of 2026-09-22.
2. Run `python3 scripts/setup-codex-deepseek.py --home <external-home>`. Supply the key through the hidden prompt, environment, or stdin. Existing homes and checkout paths are refused.
3. Test strict Codex configuration, a short answer, file editing/shell execution, image input, and app-server MCP tools in a disposable directory. Test agents must not use Discord tools and must return only to their parent.
4. For computer-use testing, read the installed skill and use a public page or local fixture. Image support alone does not configure GUI tools. Stop at permission or website barriers; do not claim success for a blocked page.
5. Add a named account using structured JSON in ignored `registry.json`, preserving defaults and unrelated projects. Select/restart only requested projects using the existing lifecycle scripts.
6. Replace keys with `--rotate-key`, then restart affected sessions. Restore the previous project selector to roll back.

## Gotchas
- The helper downloads the vendor setup script as data and extracts its literal JSON; it never executes downloaded shell code. If the layout changes, use a verified `--catalog-file` or update the extractor.
- DeepSeek requires its own standard Responses metadata (`use_responses_lite: false`, `shell_type: shell_command`), not the MiMo catalog.
- For CLI image tests, separate the prompt from variadic image arguments: `codex exec -i image.png -- 'Describe this image'`. Otherwise the prompt can be consumed as another image argument.
- Keep the private `api-key` and all home contents outside the checkout. Do not copy unrelated provider credentials or MCP configurations into the new home.
- Pi may store a key-provider command rather than a literal key. Resolve a reviewed credential reference privately and pass its output through stdin; never print the resolved credential.
- The helper is scoped to Flash. Other DeepSeek models and provider quota reporting require separate work and validation.

## Verify
- [ ] Generated home/files use `0700`/`0600`; no credentials reach source, logs, or tmux arguments.
- [ ] Local-fake setup, catalog rejection, rotation, and named-account launch tests pass.
- [ ] Live model, file, vision, and tool checks match the capabilities being reported.
- [ ] Existing defaults, unrelated projects, and Discord listeners are unchanged.
- [ ] Update relevant scaffold state and run `npx mex-agent check` after scaffold edits.
