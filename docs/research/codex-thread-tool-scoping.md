# Scope Codex thread Discord tools to one thread

Research for wayfinder ticket #87 (map #77), 2026-09-28.

**Environment.** codex-cli 0.155.1, model `gpt-6-luna` at low effort, using the default ChatGPT Codex Home. Each run used a throwaway app-server on a private port with sandbox `read-only` and `approvalPolicy: never`, plus a local stdio echo MCP server. The server echoes a visible tag and receives, but never prints, a hidden env marker.

**Config safety.** The home's live `discord-*` servers were disabled for the test app-servers with `-c` flags. Nothing was written to `config.toml`, and every test conversation was archived afterwards.

## Options

- **(a)** One shared `discord-${CHANNEL_ID}` MCP server per host. It extends root mode's HMAC-signed channel scope tokens to a set of active tokens plus a thread-or-parent check.
- **(b)** A per-conversation `thread/start` / `thread/resume` `config.mcp_servers` override. Each thread gets its own Discord MCP process with `CHANNEL_ID` set to the thread id.

## Test results for (b)

| Check | Result |
|---|---|
| Override without an approval setting | The tool call fails: "MCP tool call requires approval, but approval policy is never". Trusting the working directory does not help. The live bridge avoids this, probably because it uses `sandbox: danger-full-access` (`scripts/codex-bridge.js:1459`). |
| Override with `default_tools_approval_mode: "approve"` | Conversation A invokes the tool and gets `echo[A-TAG\|pid=…]: pingA1`. The rollout records an `McpToolCall` item. |
| Conversation without an override (B) | B answers `NO_ECHO_TOOL`. Its rollout never mentions the server. |
| Two conversations with the same server name `discord` and different env (A vs C) | They don't collide. Each conversation gets its own MCP process with its own env. |
| Env in the rollout | The hidden marker, the server path and `BOT_TOKEN` appear 0 times in every rollout. |
| `config/mcpServer/reload` | The per-conversation server survives, still the same process. |
| Fresh app-server, `thread/resume` without the override | The tool is gone. **The override must be re-sent on every resume.** |
| Fresh app-server, `thread/resume` with the override | Works, using the new env. |
| Server-wide `-c ...enabled=false` combined with a per-conversation override | **The override drops server-wide `-c` overrides.** Overridden conversations saw the home's real `discord-*` servers and their tools. No Discord tool was called. |
| Disabling those servers inside the override (`enabled:false`) | Works: the servers expose no tools. |

## What option (a) would need

Changes to the bridge (`scripts/codex-bridge.js`):
- Create the scope file in project mode too. Today it is created only in root mode (`:257-262`).
- Turn the single active token (`:276-282`) into an atomic set.
- Make each clear site remove only its own turn's token: `:284-288`, called at `:885`, `:1069`, `:1664` and `:1680`.
- Add thread-scoped token minting (`:1306`, `:1369`).

A new project-thread mode in `scripts/discord-mcp-server.js`:
- Require `channel_id` and the scope token (`:204-217`).
- Check the token against the set instead of the single-file match (`:237-238`).
- Keep the signature check (`:241-250`).
- Drop the root-only `access.groups` check (`:256-258`).

Side effects:
- The reminder context file (`scripts/conversation-reminder-adapter.js:14,130-157`) must become per channel.
- The model must pass the channel and token on every call, which puts the tokens into rollouts.

## Secret exposure

These findings apply to today's bridge as well as to the design.

- **Today's bridge and option (a).** `registerDiscordMcp` writes `BOT_TOKEN`, the reply token and the scope-signing secret into the Codex Home's `config.toml` (`scripts/codex-bridge.js:1409-1432`). With `danger-full-access`, a model can read that file. With the signing secret it could forge scope tokens.
- **Option (b).** Secrets exist only in the per-conversation override and the MCP child's environment. They are not in `config.toml` or the rollout, and there is no signing secret to steal. A model could still find the bot token by listing process environments.
- **Both options.** Thread scoping only shapes model behaviour, because the bot token is per project bot. The hard boundary remains the bot's Discord permissions, which are limited to its project channel.

## Lifecycle comparison

| Situation | (a) | (b) |
|---|---|---|
| Host restart | Re-mint tokens and rebuild the active set. | Re-send the override with fresh secrets on resume. |
| Account or provider move to another app-server | Register the server in each home and share the token set. | The override travels with `thread/resume`. |
| `/clear` | Clear that conversation's token only. | Start the new conversation with the same override. |
| Reminder context | Needs per-channel files. | Each override gets its own context file path. |
| Cost | One MCP process per app-server. | One MCP process per loaded conversation. |

## Recommendation (researcher's opinion)

Use **option (b)**. It reuses today's project-mode Discord MCP unchanged, with `CHANNEL_ID` set to the thread id, and needs no signing secret, token set or schema change. Requirements:

1. Send the override on every `thread/start` and `thread/resume`.
2. Include `default_tools_approval_mode: "approve"` unless the sandbox remains `danger-full-access`.
3. Stop writing `discord-*` servers into the home's `config.toml`. In each override, set `enabled:false` for every other `discord-*` server found in the home, because server-wide `-c` overrides do not reach overridden conversations.
4. The Thread Supervisor or host checks the thread's `parent_id` once, when it binds the thread.
5. Pass a per-conversation reminder context file path.
