# Concurrent turns in one Codex app-server

Task evidence for wayfinder ticket #85 (map #77), 2026-09-27.

## Setup

- **Build and account:** codex-cli 0.155.1 against the local DeepSeek Codex Home (`deepseek-flash`, the only model in that catalog).
- **Server and working directory:** one fresh `codex app-server` on a private loopback port, run in a throwaway working directory. No Discord MCP was configured, and no live CCDM app-server or project conversation was touched.
- **Conversations:** a single client started two conversations. A was started with a `thread/start` `config.mcp_servers.echo_a` override that points at a local stdio echo MCP server, whose env holds a unique marker string. B had no override.
- **Turns:** the client sent both turns at once, A at `effort: low` and B at `effort: high`. Each turn told the model to call `echo_probe` if the tool was available, otherwise to reply `NO_ECHO_TOOL`, then count to 15.
- **Cleanup:** both conversations were archived afterwards.

## Results

| Check | Result |
|---|---|
| Both conversations loaded at once | Yes. `thread/loaded/list` returned both ids. |
| Turns overlap | Yes. Both `turn/started` arrived within 1 ms of each other, before either `turn/completed`. |
| Independent progress | Yes. B completed after about 3 s while A kept running for about 62 s, and nothing interleaved or cross-delivered. Every notification carried its own `threadId`. |
| Per-conversation MCP visibility | Yes. A's `tool_search` returned the `mcp__echo_a` namespace containing `echo_probe` (rollout line 14). B answered `NO_ECHO_TOOL`, and its rollout never mentions `echo_a`. |
| Per-conversation MCP env persisted in rollout | No. The marker first appears in A's rollout only after the model itself ran `cat` on the probe script (line 41). The `thread/start` config itself did not write the env into the rollout. |
| Per-turn effort accepted | Yes. `turn/start` accepted `effort` per conversation without error. |
| MCP tool invocation through the override | Not verified. DeepSeek Flash discovered the tool but never invoked it through MCP; it tried shell workarounds instead. An earlier local check (2026-09-22) showed Flash invoking an MCP echo tool configured in `config.toml`, so this may be model behaviour rather than a scoping limit. Re-test with a GPT model before relying on it. |

## Incidental observation

With a read-only sandbox, the model tried to reach the app-server's own loopback port with `curl` and a Node WebSocket client, and inspected process and environment listings while looking for the tool. This supports the bridge's existing instruction that the model must never reconstruct the Discord transport or read its credentials or scope files. Per-thread scoping must not rely on the model staying out of reach of local ports and files.

## Conclusion

A single app-server per Codex Home can safely host concurrent turns across several conversations, with events cleanly separated. Scoping MCP per conversation through `thread/start` `config` works for tool visibility and does not persist its env into the rollout. This removes the main blocker to the "one bridge per project, multiplexing conversations" topology. The remaining open item is MCP invocation through a per-conversation override, which needs a GPT-model re-test.
