Report your own context window usage. This tells the user how much of your context window is consumed.

## Steps

1. **Capture your own screen output** to read the status bar. First, detect your screen session:
   ```bash
   pstree -p $$ 2>/dev/null | head -5
   screen -ls
   ```
   Find which screen session you're in from the process tree.

2. **Read the status bar** from your screen session:
   ```bash
   screen -S <your_screen_name> -X hardcopy /tmp/self_context_check.txt
   cat /tmp/self_context_check.txt
   ```
   Look for the line containing `Ctx:` — it shows your context usage percentage (e.g., `Ctx: 15.2%`).

3. **Parse and report** the context info. The status bar line looks like:
   ```
   Model: Opus 4.6 (1M context) | Ctx: 15.2% | ...
   ```
   Extract the percentage and calculate approximate tokens used (e.g., 15.2% of 1M = ~152k tokens).

4. **Reply with a clean summary:**
   - Context used: X% (Xk / 1M tokens)
   - Approximate free space: Xk tokens
   - If above 70%: warn that a restart may be needed soon
   - If above 90%: strongly recommend restarting immediately

5. **If you cannot detect your screen session**, fall back to estimating based on conversation length, or simply report that you couldn't determine exact usage and suggest the user ask the root agent for a context report.
