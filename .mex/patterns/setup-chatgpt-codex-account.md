---
name: setup-chatgpt-codex-account
description: Add another ChatGPT subscription Codex Account Alias and home for CCDM sessions.
triggers:
  - "add codex account"
  - "codex home"
  - "codex login"
edges:
  - target: context/session-management.md
    condition: when selecting the new home on a registered project
  - target: context/discord-security.md
    condition: when handling credentials or testing Discord integration
last_updated: 2026-11-10
---

# Add A ChatGPT Codex Account

Use this when the request is a subscription (ChatGPT) account, not an API-key
provider. API-key providers have their own patterns (`setup-mimo-codex`,
`setup-deepseek-codex`).

## Steps
1. Confirm the target alias and an external home path. Never create a home inside the checkout, and never reuse an existing home for a second account.
2. Create the private home, then write `cli_auth_credentials_store = "file"` to `<home>/config.toml` to select file-backed credentials.
   - macOS: create it with `mkdir -m 700 -p <home>` and give `config.toml` mode `0600`.
   - Windows: create it with `mkdir -p <home>` inside the user profile folder. POSIX modes do not apply there.
3. Authenticate the account. In a Discord-mediated session use `codex login --device-auth`, which prints a URL and a one-time code and keeps polling; a plain `codex login` needs a local browser. Park it in an ad-hoc session so it survives between messages: `scripts/ccdm session new ccdm_codex_login --env CODEX_HOME=<home> -- codex login --device-auth`. Then read the URL and the code with `scripts/ccdm session capture ccdm_codex_login --join`.
4. Send the user only the public device URL and the one-time code. Codes expire in 15 minutes; regenerate rather than guessing when one lapses.
5. Poll `CODEX_HOME=<home> codex login status` until it reports `Logged in using ChatGPT`. Do not treat a still-pending login as success.
6. Add the alias to the existing `codex_accounts` object in ignored `registry.json`, preserving every other entry and `default_codex_account`.
7. Validate without starting anything. The resolver must still return the previous default, and the new alias must resolve for a probe project.
   - macOS: `python3 scripts/resolve-codex-home.py registry.json --root`.
   - Windows: `py -3 scripts/resolve-codex-home.py registry.json --root`.
8. Assign the alias to a project only when asked, then run `scripts/ccdm stop-session <project>` and `scripts/ccdm start-codex-session <project>`. Sessions already running keep their old `CODEX_HOME` until restarted.
9. To move an already-running project to the alias **with its history**, identify the live rollout first, stop the project, copy that rollout into the target home's matching `sessions/` path without overwriting, change the project's `codex_account`, then start with `scripts/ccdm start-codex-session <project> --resume <thread_uuid>` using the UUID from the rollout filename.
   - macOS: read the live rollout from the running app-server with `lsof -p <app-server-pid> | grep sessions/.*jsonl`.
   - Windows: pick the newest rollout by the rule in Gotchas.

## Gotchas
- `codex login --device-auth` is the only flow that works without a browser on this machine; `--with-api-key` is wrong for a subscription account and silently produces a non-subscription home.
- The device code is a bearer credential for that login flow. Post it only to the requesting user's own channel and never to logs, docs, or subagents.
- `auth.json`, `config.toml` credential lines, and Keychain data stay private. Never copy another home's `auth.json` and never print it.
- A new home has no trusted-project entries, so first runs may prompt for trust until the launcher or a manual `codex` run records them.
- The launcher strips and re-registers `[mcp_servers.discord-*]` entries per session, so a fresh home needs no Discord MCP configuration and must not carry stale ones.
- Adding the alias does not change the default account; several projects can share one alias, so confirm the intended project before editing it.
- The rollout filename's UUID is the resume thread ID, and a copied rollout must exist under the target home before `--resume` is used. Verify the switch by confirming the restarted app-server has that same rollout open under the new home.
- Capture the live rollout *before* stopping the old session. Once the listener is down, recover the thread by picking the newest `sessions/**/rollout-*.jsonl` under the old home whose `session_meta.cwd` matches the project path (cross-check that the file mentions the channel ID), because the bridge does not record the thread ID in `registry.json`. A restart launched without `--resume` also leaves a small throwaway rollout in the new home; ignore it.

## Verify
- [ ] No credential contents were printed or copied.
- [ ] macOS: the home is `0700` and `config.toml` is `0600`.
- [ ] `codex login status` for the new home reports ChatGPT, and the account is the intended one.
- [ ] `registry.json` stays valid JSON with the previous `default_codex_account` and all other aliases intact.
- [ ] The step-7 resolver output for `--root` is unchanged and the new alias resolves to the new home.
- [ ] Any assigned project starts, and its process `CODEX_HOME` matches the alias.
- [ ] Other projects and Discord listeners are untouched.

## Debug
- Login still pending after the code expires: regenerate with `--device-auth`; read the login session's screen (step 3) for `expired` or `denied` output.
- Alias rejected at start: confirm the alias exists in `codex_accounts`, the home exists, and the project does not also set `codex_home`.
- Session runs the wrong account: the bridge receives a resolved absolute `CODEX_HOME`, so restart the session after any selector change.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
