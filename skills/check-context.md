Check your own context usage by sending the `/context` command to your tmux session and reporting the results.

## Steps

1. **Find your tmux session name.** Run:
   ```bash
   tmux list-panes -a -F '#{session_name} #{pane_pid}'
   ```
   Then find which session owns your process. Your Claude Code process runs inside a tmux pane — match by checking which `pane_pid` is an ancestor of your `claude` process. You can cross-reference with `pgrep -P <pane_pid>` to find the session that has your process tree.

2. **Send the `/context` command to your tmux session** using:
   ```bash
   tmux send-keys -t <your_session_name> '/context' Enter
   ```
   This queues the command — it will execute after your current turn ends.

3. **Inform the user** that the command has been queued and they need to send you one more message (anything — even just "ok") so you get a new turn and can read the output.

4. **When the user messages you back**, read the `/context` output that appeared in the conversation history (it will show up as a `<local-command-stdout>` block from the `/context` command).

5. **Report the results** back to the user with a clean summary:
   - Total tokens used vs available
   - Percentage used
   - Breakdown by category (system prompt, tools, messages, etc.)
   - How much free space remains
