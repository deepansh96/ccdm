---
name: manage-claude-home-login
description: Check, restore, or remotely complete a Claude home login for the default home or any claude_home-selected home.
triggers:
  - "claude login"
  - "logged out"
  - "oauth expired"
  - "claude home"
edges:
  - target: context/session-management.md
    condition: when a Claude session must be restarted after the login is restored
  - target: patterns/manage-session.md
    condition: when restarting a project the user confirmed
  - target: context/discord-security.md
    condition: when handing a login URL or code to the user
last_updated: 2026-09-25
---

# Manage A Claude Home Login

## Context
Claude credentials are per `CLAUDE_CONFIG_DIR` home (data + config together), and
they expire on idle. `~/.claude` is the default home; a project's `claude_home`
can select another, such as `~/.claude-<name>`. Keep the machine's actual home
inventory in `CLAUDE.local.md`, not in tracked files. Always pass `<home>` as
exactly the absolute path the launcher uses — the project's `claude_home` with `~`
expanded (for example `$HOME/.claude`, not `$HOME/.claude/`) — because the hashed
Keychain item name is derived from that literal string.
Never print credentials or keychain contents; only auth metadata, the one-time
sign-in URL, and the user's pasted code belong in the flow.

## Steps
1. Work out which projects are affected and how they launch.
   `scripts/start-session.sh` sets `CLAUDE_CONFIG_DIR` only when `claude_home`
   is present, so for `~/.claude` a project with `claude_home: "~/.claude"` reads
   the hashed Keychain item and a project with no `claude_home` reads the plain
   one (see Gotchas).
2. Status only, no mutation: `CLAUDE_CONFIG_DIR=<home> claude auth status`. It
   prints `loggedIn`, `authMethod`, `configDirectory` (confirms which home was
   checked), and for claude.ai logins the email, org, and `subscriptionType`.
   For `~/.claude`, also run `claude auth status` without the variable to check
   the plain item.
3. Confirm for real with a cheap turn, because status alone has been wrong in
   both directions: `CLAUDE_CONFIG_DIR=<home> claude -p "Reply with exactly: OK"
   --output-format json` and read `is_error` / `result` / `total_cost_usd`.
   Repeat it without the variable when env-less `~/.claude` projects are affected.
4. To log in, park the flow so it survives between Discord messages. Check
   `tmux has-session -t =ccdm_claude_login` first; a leftover session makes
   `new-session` fail. Launch it the same way the affected projects launch:
   `tmux new-session -d -s ccdm_claude_login -- zsh -ic "CLAUDE_CONFIG_DIR=<home> claude auth login"`
   for a variable-set home, or without `CLAUDE_CONFIG_DIR=<home>` for env-less
   `~/.claude` projects. If both kinds are affected, complete one login of each.
5. Read the pane with `tmux capture-pane -p -J -t =ccdm_claude_login` (`-J`
   joins the long URL that wraps at the default 80-column width) and send the
   user the printed `https://claude.com/cai/oauth/authorize...` URL. That URL uses the manual
   redirect: after sign-in the user's browser shows a `code#state` string, and the
   login finishes only when that string is entered at the
   `Paste code here if prompted >` prompt. Ask the user for the full string and
   send it with `tmux send-keys -t =ccdm_claude_login '<code>' Enter`.
6. Re-check step 2 for the home. A successful login ends the process, which
   closes the tmux session — a missing session is expected on success, not a
   failure.
7. Verify end-to-end with step 3 again before telling the user it is fixed.
8. Restart only projects that are failing or that the user names, after they
   confirm, using `patterns/manage-session.md`. Running sessions keep working on
   in-memory tokens, so a blanket restart is unnecessary.

## Gotchas
- Which Keychain item a home reads depends on whether `CLAUDE_CONFIG_DIR` is set
  for that run: set → `Claude Code-credentials-<first 8 hex of sha256(home path)>`;
  unset → plain `Claude Code-credentials`. For `~/.claude`, an explicit
  `claude_home: "~/.claude"` and an unset `claude_home` therefore use different
  items, so one home can silently hold two different logins, and a login run one
  way does not repair projects launched the other way.
- Check the two items by comparing `claude auth status` and the step-3 turn with
  and without the variable. If the item itself must be inspected, use
  `security find-generic-password -s "<service>"` for metadata only; never pass
  `-w` or `-g`, which print the secret.
- The plain item belongs to whichever account last logged in without the
  variable (for example the AF work account), not necessarily to `~/.claude`.
  `scripts/usage-stats-poster.py` tries each home's hashed item and the plain
  item, freshest first, and keeps only a login whose profile email matches the
  home's `.claude.json`, so a re-login prompt there means no item holds a usable
  token for that account. `scripts/claude-usage.sh` still reads both `~/.claude`
  items and prefers the one whose `expiresAt` is latest, without the email check.
- `claude auth status` reported `loggedIn: false` for a home whose live sessions
  were authenticating fine, and reported a home as usable before a real turn
  succeeded. Always finish with an actual `-p` call.
- A home configured with `apiKeyHelper` (API-key billing) is not repaired by
  `claude auth login`, which defaults to a Claude subscription login; fix the
  helper or its key instead. Its step-3 turn is billed API usage.
- `claude auth login` also opens a sign-in tab in the host Mac's default browser.
  That tab uses whichever account the host browser is signed into; ignore it when
  the user is completing the flow remotely.
- If the tmux session is gone, the flow completed, failed, or was killed. Check
  status before regenerating a URL.
- The authorize URL is a one-time, time-limited capability tied to a PKCE
  challenge. Send it only to the requesting user's channel and regenerate rather
  than reusing an expired one.
- Signing in with the wrong browser session silently attaches the wrong account
  (personal vs org/team). Report back the email + org + plan that landed and let
  the user correct it.
- A home can be logged out while its already-running sessions keep working on
  tokens held in memory; they only fail on the next start.
- A home that has never opened a project starts with an interactive "Is this a
  project you trust?" prompt that blocks the session, so the bot silently
  answers nothing. Check the tmux pane for it on the first launch after a login
  change and answer it before reporting success.

## Verify
- [ ] `claude auth status` for the home shows `loggedIn: true`, the intended `configDirectory`, and the intended email/org.
- [ ] A real `claude -p` turn returns `is_error: false` with the expected text, both with and without the variable when both kinds of `~/.claude` projects are affected.
- [ ] No credential contents or keychain material were printed or shared.
- [ ] Only user-confirmed project sessions were restarted, and their launcher env points at the intended home.

## Debug
- Still `OAuth session expired and could not be refreshed` after a login: confirm
  the login and the failing project used the same form (`CLAUDE_CONFIG_DIR` set to
  the same absolute path, or unset for both), since each form reads its own item.
- Wrong account landed in a home: a fresh login for that home usually replaces
  it. Only if it does not, and after the user confirms, run
  `CLAUDE_CONFIG_DIR=<home> claude auth logout` (or the bare command for the
  plain `~/.claude` item), then repeat the login. Logout clears that item for
  every session using that home; a bare logout affects every project without
  `claude_home`.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
