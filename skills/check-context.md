Check your own context usage. The method depends on whether you're a Claude Code session or a Codex bridge session.

## Steps

1. **Find your tmux session name.** Run:
   ```bash
   tmux list-panes -a -F '#{session_name} #{pane_pid}'
   ```
   Then find which session owns your process. Your process runs inside a tmux pane — match by checking which `pane_pid` is an ancestor of your process. You can cross-reference with `pgrep -P <pane_pid>` to find the session that has your process tree.

2. **Determine your session type.** Look up your project in registry.json (at the CCDM root directory) and check the `type` field. If `type` is `"codex"`, you're a Codex session. Otherwise you're Claude Code.

3. **Get context usage.**

   **If Claude Code session:**
   Send the `/context` command to your tmux session:
   ```bash
   tmux send-keys -t <your_session_name> '/context' Enter
   ```
   This queues the command — it will execute after your current turn ends. Inform the user they need to send one more message so you get a new turn and can read the output. When they do, read the `/context` output from the conversation history.

   **If Codex session:**
   The Codex bridge logs context % updates to the tmux pane whenever `thread/tokenUsage/updated` notifications arrive. Capture the pane output:
   ```bash
   tmux capture-pane -t <your_session_name> -p | grep -i "nickname\|context\|token"
   ```
   The most recent "Nickname updated: <name> · X%" line shows the current context usage. If no nickname updates have been logged yet, the session hasn't processed enough messages to have meaningful token usage — report it as near 0%.

4. **Report the results** back to the user with a clean summary:
   - Total tokens used vs available (if known)
   - Percentage used
   - Breakdown by category (Claude Code only — system prompt, tools, messages, etc.)
   - How much free space remains
