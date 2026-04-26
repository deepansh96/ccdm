---
name: codex
description: "Run OpenAI Codex CLI (codex exec) to delegate tasks to a Codex sub-agent. Use when the user asks to 'get codex to do X', 'ask codex X', 'get this reviewed by codex', or similar."
---

# Codex Exec Skill

## When to Use

Use this skill when the user asks you to delegate work to OpenAI Codex. Trigger phrases include:
- "get codex to do this"
- "ask codex this"
- "get this reviewed by codex"
- "run this through codex"
- "have codex look at this"

## How to Run

**IMPORTANT:** Always append `< /dev/null` to every `codex exec` command. Without it, Codex hangs waiting on stdin in non-interactive shells.

The base command is:

```bash
codex exec "YOUR PROMPT" < /dev/null
```

Do not add extra flags by default. Let `codex exec` use its own defaults for model and reasoning effort.

### Optional: Reasoning Effort Override

Only add the reasoning effort flag if the user explicitly requests a specific level (e.g. "use medium thinking", "low effort", "high reasoning"):

```bash
codex exec -c 'model_reasoning_effort="medium"' "YOUR PROMPT" < /dev/null
```

Valid values: `low`, `medium`, `high`. Only pass this flag when the user asks for it.

### Optional: Model Override

Only add the model flag if the user explicitly requests a specific model:

```bash
codex exec -m gpt-5.4 "YOUR PROMPT" < /dev/null
```

Only pass `-m` when the user asks for it.

## Prompt Construction

- Write a clear, self-contained prompt. Codex has no context from your conversation.
- If the task involves a specific file, reference it by path in the prompt so Codex can read it.
- If you need Codex to review something, tell it what to look for and what kind of output you want.
- For long or multi-line prompts, write to a temp file first, then pass via `$(cat)`:

```bash
cat > /tmp/codex-prompt.txt << 'EOF'
Your long prompt here.
Multiple lines are fine.
EOF

codex exec "$(cat /tmp/codex-prompt.txt)" < /dev/null
```

- Do NOT use heredocs directly inside the `codex exec` argument — they can cause stdin hangs.

## Handling Output

- Codex output is returned directly in the terminal. Read it and relay the results to the user.
- If the output is long, summarize the key findings for the user.
- If Codex made file changes, review them before reporting to the user.

## Timeout

Codex exec can take a while for complex tasks. Use a generous timeout (up to 600000ms / 10 minutes) when running via Bash.

## Examples

Simple question:
```bash
codex exec "Review the file docs/plans/research.md and list any gaps or inconsistencies" < /dev/null
```

With medium reasoning:
```bash
codex exec -c 'model_reasoning_effort="medium"' "Summarize what this project does based on the README" < /dev/null
```

With specific model:
```bash
codex exec -m gpt-5.4 "Analyze the test coverage in backend/tests/" < /dev/null
```

Long multi-line prompt:
```bash
cat > /tmp/codex-prompt.txt << 'EOF'
Review this research doc against the actual codebase.
Fact-check every file path and line number.
Flag any hallucinations or missing files.
EOF

codex exec "$(cat /tmp/codex-prompt.txt)" < /dev/null
```
