Check how much of your context window you have used. This works for a Claude or Codex session, in a project channel or a thread, on macOS and on Windows.

Every session gets its percentage from a small file, its launch record. A Claude session can also get a breakdown by category.

## Steps

1. **Find out which session you are.** Print these three variables:
   ```sh
   echo "session=$CCDM_SESSION_NAME claude_project=$CCDM_CLAUDE_PROJECT codex_project=$CCDM_CODEX_PROJECT"
   ```
   A Codex session on Windows runs its commands in PowerShell: print `$env:CCDM_SESSION_NAME` and `$env:CCDM_CODEX_PROJECT` there.
   - Your project is the value of `claude_project` or `codex_project`, whichever is set. If `claude_project` is set you are a Claude session; if `codex_project` is set you are a Codex session.
   - Session that ends in `-t-` and a number, for example `alpha-t-1234567890`: you are a **thread session**. The number is your thread id.
   - Session `root_agent`: you are **root**.
   - Any other session name: you are a **project session**.
   - If the values are empty, you cannot find your launch record. Tell the user the percentage is not available from here, and that it is shown after `·` in the name on each of your Discord replies.

2. **Read the percentage from your launch record.** Read this file with your file-reading tool:
   - Project session: `~/.local/state/ccdm/router/launches/<project>/context.json`
   - Thread session: `~/.local/state/ccdm/router/launches/<project>/threads/<thread id>/context.json`
   - Root: `~/.local/state/ccdm/router/launches/.root/context.json`

   The path is the same on macOS and Windows. If the variable `CCDM_ROUTER_STATE_DIR` is set, use its value in place of `~/.local/state/ccdm/router`. Otherwise, if `CCDM_STATE_ROOT` is set, use its value in place of `~/.local/state/ccdm`.

   The file holds one number, `context_pct`: the percentage of your context window in use, for example `{"context_pct": 37}`. It is updated while the session works.

   If the file does not exist, nothing has been recorded for this session. Say that the percentage is not recorded. Do not make up a number.

3. **Claude session only: ask for the breakdown by category.** Skip this step if you are a Codex session, or if the user only wants the percentage.

   Type `/context` into your own session:
   ```sh
   scripts/ccdm session send "$CCDM_SESSION_NAME" --literal /context --enter
   ```
   `scripts/ccdm` is a file in the CCDM checkout, not in your project folder. The checkout is the folder in the variable `CCDM_REMINDER_PROJECT_ROOT`, so run it with the Bash tool as `"$CCDM_REMINDER_PROJECT_ROOT/scripts/ccdm" session send "$CCDM_SESSION_NAME" --literal /context --enter`. If you are root, the checkout is your working directory. The command is the same on macOS and Windows.

   The command only types the text. `/context` runs when your current turn ends, so you cannot read its output in this turn.

   Never run `scripts/ccdm session context` on your own session. It waits for the context grid, and the grid cannot appear until your turn ends, so it times out.

4. **Report to the user.**
   - Give the percentage from step 2, and how much is free (100 minus the percentage).
   - If you ran step 3, tell the user: "The breakdown appears after your next message. Send one more message and I will read it." When their next message arrives, read the `/context` output in your conversation and report the tokens used and total, the percentage, the breakdown by category (system prompt, tools, messages and so on) and the free space.
   - If you are a Codex session, say that the breakdown by category is only available for Claude sessions.
