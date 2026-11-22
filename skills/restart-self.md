Restart your own session. This works for a Claude or Codex session, on macOS and on Windows. You run one `scripts/ccdm` command. It ends your current process, so you cannot report afterwards.

## How to run `scripts/ccdm`

`scripts/ccdm` is a file in the CCDM checkout, not in your project folder. The command line is the same on macOS and Windows.

- The CCDM checkout is the folder in the variable `CCDM_REMINDER_PROJECT_ROOT`. If you are root, it is your working directory.
- Claude session: run it with the Bash tool, as `"$CCDM_REMINDER_PROJECT_ROOT/scripts/ccdm" <command>`.
- Codex session on macOS: run it the same way.
- Codex session on Windows: your commands run in PowerShell. Run `& "$env:CCDM_REMINDER_PROJECT_ROOT\scripts\ccdm.cmd" <command>`.
- If the variable is empty and you are not root, do not guess a path. Go to "If you cannot run the command".

The steps below write `scripts/ccdm` for short. Always run it in the form above.

## Steps

1. **Find out which session you are.** Print these three variables:
   ```sh
   echo "session=$CCDM_SESSION_NAME claude_project=$CCDM_CLAUDE_PROJECT codex_project=$CCDM_CODEX_PROJECT"
   ```
   In PowerShell, print `$env:CCDM_SESSION_NAME` and `$env:CCDM_CODEX_PROJECT`.
   - Session `root_agent`: you are **root**.
   - Session that ends in `-t-` and a number, for example `alpha-t-1234567890`: you are a **thread session**. The number is your thread id.
   - Any other session name: you are a **project session**.
   - Your project is the value of `claude_project` or `codex_project`, whichever is set.
   - If `session` is empty, go to "If you cannot run the command".

2. **Tell the user you are restarting.** Send this message before you run anything. Say which kind of restart it is:
   - Project session: "Restarting this session. The new session starts a fresh conversation."
   - Thread session: "Restarting this thread's session. It resumes the same conversation."
   - Root: "Restarting root. The new root starts a fresh conversation."

3. **Run the one command for your kind of session.** Run it as a normal foreground command. Do not put it in the background and do not wrap it in another command. It detaches itself where that is needed.

   - **Project session:**
     ```sh
     scripts/ccdm restart-session <project>
     ```
     Only a project session runs this command. It works for Claude and Codex projects. It hands the restart to a detached copy, prints `ccdm: restart-session continues in a detached process` with a log path, and exits 0 before the restart is done. The copy then stops your session and starts a new one.

   - **Thread session:**
     ```sh
     scripts/ccdm threads restart <project> <thread id>
     ```
     The Thread Supervisor does the restart. Your session ends as soon as it takes the request, so the command may print `Restarting thread ...` or nothing at all. Never run the project command above from a thread: it restarts the parent channel's session, not yours.

   - **Root:**
     ```sh
     scripts/ccdm restart-root
     ```
     If you are root Codex, run `scripts/ccdm restart-root --provider codex` instead, and add the root channel id as the last argument when the registry lists more than one root channel. Windows: root Codex is not supported, so `--provider codex` is refused there.
     It checks the Router first. If the Router does not answer, it prints the refusal, exits 1 and changes nothing: tell the user what it printed. Otherwise it hands the restart to a detached copy, prints that copy's log path and exits 0 before the restart is done.

4. **Stop.** Do not run anything else after the command. Your process ends shortly after it.

## If you cannot run the command

Do not try another way to restart. Tell the user to restart you from Discord instead:

- Project session: the user sends `/restart` in the project channel.
- Thread session: the user sends `/restart` in the thread.
- Root: the user runs `scripts/ccdm restart-root` from a terminal in the CCDM checkout.

## Notes

- A restart request is for your own session only. Never restart another project, and never restart root from a project or thread session.
- A project session's new session has no memory of this conversation. A thread session resumes its conversation.
- If the new session does not come up, the user can read `~/.local/state/ccdm/logs/restart-<project>.log` (project) or `~/.local/state/ccdm/logs/restart-root-root_agent.log` (root), and can watch a session from a terminal with `scripts/ccdm attach <project>` or `scripts/ccdm attach root`.
- If a command prints `the thread supervisor is not reachable`, the thread was not restarted. Tell the user, and ask them to send `/restart` in the thread once the Thread Supervisor runs again.
