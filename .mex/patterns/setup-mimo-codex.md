---
name: setup-mimo-codex
description: Prepare or rotate an isolated MiMo provider home for the existing Codex bridge.
triggers:
  - "MiMo"
  - "Xiaomi API"
edges:
  - target: context/session-management.md
    condition: when selecting the home for a registered project
  - target: context/discord-security.md
    condition: when handling credentials or testing Discord integration
last_updated: 2026-09-22
---

# Set Up MiMo For Codex

## Steps
1. Read the current vendor Codex integration guide and check the installed Codex version. Confirm pay-as-you-go versus Token Plan; keys and endpoints differ.
2. Run `python3 scripts/setup-codex-mimo.py --home <external-home> --billing payg|token-plan`. Supply credentials through the hidden prompt, environment, or stdin, never command arguments. Existing homes are refused.
3. Test `codex exec --strict-config` with that `CODEX_HOME`, first for a short answer, then a disposable file edit. Explicitly tell the test agent not to use Discord and to return only to the parent.
4. Verify app-server/tool compatibility with a local test tool before claiming bridge compatibility. Default E2E tests must use local fixtures and no live provider or Discord credentials.
5. Add an alias to ignored `registry.json` using structured JSON, preserving all defaults and unrelated project selectors. Assign/restart only explicitly requested projects through the standard lifecycle scripts.
6. Rotate a key with `--rotate-key` and the original billing mode; restart affected sessions to refresh authentication. Use a new home when changing billing endpoints.

## Gotchas
- The vendor catalog's `use_responses_lite` is necessary for custom tools. Do not replace the catalog with only a model name.
- Codex 0.153.4 rejects the guide's top-level `model_supports_reasoning_summaries`; the catalog supplies `supports_reasoning_summaries` instead.
- Provider auth commands allow `/bin/cat` to read the private credential without exporting keys in shell startup files or tmux arguments. Do not copy OpenAI credentials or unrelated MCP configuration into the new home.
- Keep `api-key`, `ccdm-mimo.json`, catalog, sessions, and configuration outside the checkout. Rotation preserves MCP edits and does not depend on shell-exported credentials.
- A successful inference does not establish remaining balance, and ChatGPT usage dashboards do not report MiMo quota.

## Verify
- [ ] Home is private (`0700`) and generated files use `0600`.
- [ ] Setup and rotation tests pass; existing homes and billing mismatches fail without overwrites.
- [ ] Strict Codex configuration, inference, file tools, and local app-server tool tests pass for the selected provider.
- [ ] Default account, unrelated projects, and Discord listeners are unchanged.
- [ ] Publication excludes local credentials, registry values, and test transcripts.
