Restart your own Claude Code session. This kills your current process and starts a fresh one in the same screen session.

## Steps

1. **Detect your screen session name.** Run:
   ```bash
   # Find the screen session this process is running in
   SCREEN_NAME=$(ps -o ppid= -p $PPID | xargs -I{} ps -o ppid= -p {} | xargs -I{} ps -o ppid= -p {} | xargs -I{} screen -ls | grep -oP '\d+\.\K[^\t]+(?=\t)' | head -1)
   ```
   If that doesn't work, use a simpler approach — check `screen -ls` and match against your current working directory or find the screen PID that is an ancestor of your process:
   ```bash
   screen -ls
   ```
   Then figure out which screen session you're in by checking the process tree:
   ```bash
   pstree -p $$ | head -5
   ```

2. **Detect your environment.** Run these commands and note the values:
   ```bash
   echo "CWD: $(pwd)"
   echo "STATE_DIR: $DISCORD_STATE_DIR"
   echo "SCREEN: $(screen -ls | grep -i $(basename $(pwd)) | awk '{print $1}' | cut -d. -f2)"
   ```

3. **Determine the launch command.** Based on what you detected:
   - `SCREEN_NAME`: the screen session name (e.g., `quiz`, `viz`, `plio`)
   - `STATE_DIR`: the DISCORD_STATE_DIR value (e.g., `~/.claude/channels/discord4`)
   - `PROJECT_DIR`: your current working directory
   - Use `bash -ic` on Linux, `zsh -ic` on macOS (check `uname`)

4. **Tell the user you're restarting**, then run the restart:
   ```bash
   nohup bash -c '
     SCREEN_NAME="<screen_name>"
     STATE_DIR="<state_dir>"
     PROJECT_DIR="<project_dir>"
     SHELL_CMD="bash -ic"  # use "zsh -ic" on macOS

     # Kill current screen
     screen -X -S "$SCREEN_NAME" quit
     sleep 2

     # Start fresh
     screen -dmS "$SCREEN_NAME" $SHELL_CMD "cd $PROJECT_DIR && DISCORD_STATE_DIR=$STATE_DIR claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions"

     # Dismiss trust dialog
     sleep 8 && screen -S "$SCREEN_NAME" -p 0 -X stuff "\r"
   ' &>/dev/null &
   ```

5. **Important notes:**
   - Always use `nohup ... &` so the script survives your own process being killed.
   - Do NOT use `-c` flag (no conversation resume) unless the user explicitly asks.
   - Send a Discord message confirming the restart BEFORE running the nohup command, since you won't be able to message after.
   - The new session will be a completely fresh conversation with no memory of the previous one.
