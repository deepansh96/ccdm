---
name: manage-claude-home-login
description: Check, restore, or remotely complete a Claude home login (default, claude-af, claude-t4d-api and any future home).
triggers:
  - "claude login"
  - "logged out"
  - "oauth expired"
  - "claude home"
edges:
  - target: context/session-management.md
    condition: when a Claude session must be restarted after the login is restored
  - target: context/discord-security.md
    condition: when handing a login URL or code to the user
last_updated: 2026-09-24
---

# Manage A Claude Home Login

## Context
Claude credentials are per `CLAUDE_CONFIG_DIR` home (data + config together), and
they expire on idle. Homes in use: `~/.claude` (default when `claude_home` is
unset), `~/.claude-af`, `~/.claude-t4d-api` (api_key_helper, API billing).
Never print credentials or keychain contents; only auth metadata and the
one-time sign-in URL belong in a reply.

## Steps
1. Status only, no mutation: `CLAUDE_CONFIG_DIR=<home> claude auth status`. It
   prints `loggedIn`, `authMethod`, and for claude.ai logins the email, org, and
   `subscriptionType`.
2. Confirm for real with a cheap turn, because status alone has been wrong in
   both directions: `CLAUDE_CONFIG_DIR=<home> claude -p "Reply with exactly: OK"
   --output-format json` and read `is_error` / `result` / `total_cost_usd`.
3. To log in, park the flow so it survives between Discord messages:
   `tmux new-session -d -s ccdm_claude_login -- zsh -ic "CLAUDE_CONFIG_DIR=<home> claude auth login"`.
4. Read the pane and send the user the `https://claude.com/cai/oauth/authorize...`
   URL. They sign in, and the flow completes through the browser callback — the
   `Paste code here if prompted >` prompt is only a fallback, so a pasted code is
   usually unnecessary and may arrive after the login already finished.
5. Re-check `claude auth status` for the home. A successful login ends the
   process, which closes the tmux session — a missing session is expected on
   success, not a failure.
6. Verify end-to-end with step 2 again before telling the user it is fixed.
7. Restart the affected project sessions so they pick up the restored home.

## Gotchas
- Which Keychain item a home reads depends on whether `CLAUDE_CONFIG_DIR` is set
  for that run: set → `Claude Code-credentials-<first 8 hex of sha256(home path)>`;
  unset → plain `Claude Code-credentials`. A remote login for `~/.claude` driven
  with the variable set therefore lands in the hashed item while env-less
  launches read the plain one, so one home can silently hold two different
  logins. Check both items before concluding a home is logged out.
- The usage reports (`scripts/usage-stats-poster.py`, `scripts/claude-usage.sh`)
  read both `~/.claude` items and use the one whose `expiresAt` is latest; if
  the API rejects it with 401, they retry the other item when it is unexpired.
  A report showing the home as expired or needing re-login therefore means
  neither item works, not just the one sessions use.
- `claude auth status` reported `loggedIn: false` for a home whose live sessions
  were authenticating fine, and reported a home as usable before a real turn
  succeeded. Always finish with an actual `-p` call.
- The login process is short-lived; if the tmux session is gone, the flow either
  completed or timed out. Check status before regenerating a URL.
- The authorize URL is a one-time, time-limited capability tied to a PKCE
  challenge. Send it only to the requesting user's channel and regenerate rather
  than reusing an expired one.
- Signing in with the wrong browser session silently attaches the wrong account
  (personal gmail/max vs org/team). Report back the email + org + plan that
  landed and let the user correct it.
- A home can be logged out while its already-running sessions keep working on
  tokens held in memory; they only fail on the next start.
- A home that has never opened a project starts with an interactive "Is this a
  project you trust?" prompt that blocks the session, so the bot silently
  answers nothing. Check the tmux pane for it on the first launch after a login
  change and answer it before reporting success.

## Verify
- [ ] `claude auth status` for the home shows `loggedIn: true` and the intended email/org.
- [ ] A real `claude -p` turn returns `is_error: false` with the expected text.
- [ ] No credential contents or keychain material were printed or shared.
- [ ] Affected project sessions were restarted and their launcher env points at the intended home.

## Debug
- Still `OAuth session expired and could not be refreshed` after a login: confirm
  `CLAUDE_CONFIG_DIR` was set for **both** the login and the verification command,
  since each home keeps its own credentials.
- Wrong account landed in a home: run `claude auth logout` for that home first,
  then repeat the login and choose the account in the browser.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
