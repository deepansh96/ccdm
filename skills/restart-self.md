Restart your own Claude Code session. This kills your current process and starts a fresh one in the same tmux session.

## Steps

1. **Detect your tmux session name.** Run:
   ```bash
   tmux list-sessions
   ```
   Then figure out which tmux session you're in by checking the process tree:
   ```bash
   pstree -p $$ | head -5
   ```
   Match the ancestor PID to a tmux session.

2. **Detect your environment.** Run these commands and note the values:
   ```bash
   echo "CWD: $(pwd)"
   echo "STATE_DIR: $DISCORD_STATE_DIR"
   tmux list-sessions
   ```

3. **Determine the launch command.** Based on what you detected:
   - `SESSION_NAME`: the tmux session name (e.g., `quiz`, `viz`, `plio`)
   - `STATE_DIR`: the DISCORD_STATE_DIR value (e.g., `~/.claude/channels/discord4`)
   - `PROJECT_DIR`: your current working directory
   - Use `bash -ic` on Linux, `zsh -ic` on macOS (check `uname`)

4. **Tell the user you're restarting**, then run the restart:
   ```bash
   nohup bash -c '
     SESSION_NAME="<session_name>"
     STATE_DIR="<state_dir>"
     PROJECT_DIR="<project_dir>"
     SHELL_CMD="bash -ic"  # use "zsh -ic" on macOS

     # Kill current tmux session
     tmux kill-session -t "$SESSION_NAME"
     sleep 2

     # Start fresh
     tmux new-session -d -s "$SESSION_NAME" -- $SHELL_CMD "cd $PROJECT_DIR && DISCORD_STATE_DIR=$STATE_DIR claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"

     # Dismiss trust dialog
     sleep 8 && tmux send-keys -t "$SESSION_NAME" Enter
   ' &>/dev/null &
   ```

5. **Important notes:**
   - Always use `nohup ... &` so the script survives your own process being killed.
   - Do NOT use `-c` flag (no conversation resume) unless the user explicitly asks.
   - Send a Discord message confirming the restart BEFORE running the nohup command, since you won't be able to message after.
   - The new session will be a completely fresh conversation with no memory of the previous one.
