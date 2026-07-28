# Claude Bridge Control Surface

Research date: 2026-07-28

## Question

Which supported Claude Code interfaces can replace Anthropic's Discord plugin
while preserving the observable contract of CCDM's Codex bridge?

## Conclusion

The supported control surface is the **Claude Agent SDK backed by the installed
Claude Code executable**, not a hand-written wrapper around Claude's raw
`stream-json` protocol.

The TypeScript SDK exposes the controls CCDM needs: persistent streaming input,
structured output, interruption, session resume, MCP registration and status,
manual compaction, typed usage/error events, permissions, and explicit process
shutdown. It can be pointed at a separately installed `claude` executable with
`pathToClaudeCodeExecutable`, so CCDM can keep its existing Claude installation
and pass the existing account environment through `options.env`.
[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

The installed CLI also exposes `--input-format stream-json` and
`--output-format stream-json`, but Anthropic documents those flags rather than
the complete bidirectional control-frame protocol. In particular, the stable
public CLI reference does not specify the frames used for interruption,
dynamic MCP changes, or permission callbacks. Those operations are documented
as SDK methods. Building directly on the raw frames would therefore couple
CCDM to an internal protocol when the supported SDK already wraps it.
[CLI reference](https://code.claude.com/docs/en/cli-usage)
[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

One capability still needs the existing prototype ticket: Claude exposes
**interrupt then redirect**, not a documented equivalent of Codex
`turn/steer`. The SDK can interrupt active work and accept the next message
immediately. A local CLI probe confirmed this behavior: an ordinary second
message queued until the active turn finished, while an interrupt followed by
replacement input aborted the active turn and ran the replacement immediately.
The bridge prototype must still prove that the interrupted error result can be
suppressed and drained without duplication or cross-channel output.
[Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
[Python interrupt behavior](https://code.claude.com/docs/en/agent-sdk/python)

There is also a policy conflict outside the protocol itself: Anthropic permits
subscription OAuth for ordinary individual Claude Code use, but says
third-party developers must not route other users through Free, Pro, or Max
credentials. CCDM's owner-only local use fits the documented individual-use
path; project guest messages sent through the owner's subscription do not have
a supported policy basis. That conflict requires a destination decision before
architecture is final.
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

## Capability Matrix

| Required behavior | Supported interface | Finding |
| --- | --- | --- |
| Persistent multi-turn input | TypeScript `query()` with an `AsyncIterable<SDKUserMessage>` or `Query.streamInput()` | Supported. Streaming input is the recommended persistent mode and preserves context across turns. |
| Sequential queued messages | Streaming input iterable | Supported natively. CCDM should still own its Discord FIFO and reactions so queue state remains observable. |
| Active-turn steering | `Query.interrupt()` followed by new streaming input | Conditional. Immediate interrupt/redirection is supported; true in-place steer is not a documented SDK operation and must be prototyped. |
| Turn interruption | `Query.interrupt()` | Supported only in streaming input mode. |
| Partial output | `includePartialMessages: true` | Supported through raw API stream events plus complete assistant/result messages. |
| Session identity | `system/init.session_id` and every result message | Supported. |
| Resume after process restart | `options.resume`, with the same `cwd` and local transcript | Supported. |
| Clear/reset | `Query.close()` and start a new query/session; raw CLI `/clear` | Supported. SDK composition is the documented approach. A local CLI probe also verified that `/clear` resets the conversation in-process and emits a new session ID. |
| Manual compaction | Send `/compact` as SDK input | Supported. Completion is observable through `SDKCompactBoundaryMessage`; auto-compaction uses the same boundary event. |
| MCP at startup | `options.mcpServers` or CLI `--mcp-config` | Supported. |
| Dynamic MCP replacement | `Query.setMcpServers()` | Supported in the TypeScript SDK. |
| MCP health | `Query.mcpServerStatus()`, reconnect, and toggle methods | Supported. |
| Scoped top-level Discord replies | Existing CCDM MCP server plus bridge-issued arguments/capabilities | Supported. Claude needs no Discord plugin for this. |
| Permission-free execution | `permissionMode: "bypassPermissions"` plus `allowDangerouslySkipPermissions: true` | Supported. |
| User-input callbacks | `canUseTool` / permission and `AskUserQuestion` handling | Supported; CCDM can deny interactive terminal UI and ask through Discord. |
| Images | Image content blocks in streamed user messages | Supported directly as base64 image input. |
| Text, audio, and binary attachments | CCDM preprocessing to text or saved paths | Supported by the existing bridge pattern; no additional Claude transport is required. |
| Reactions | Convert reaction metadata to a normal user message | Supported by the normal streaming input path. |
| Token and context data | Assistant `message.usage`, result `usage`, and `modelUsage.contextWindow` | Supported. The prototype should confirm the exact context-percentage calculation used for nicknames. |
| Error classification | Assistant `error`, typed result subtypes, `terminal_reason`, and process rejection/exit | Supported. |
| Explicit shutdown | `Query.close()`, `AbortController`, and child-process lifecycle | Supported. |
| Existing installed CLI | `pathToClaudeCodeExecutable` | Supported; the SDK need not select its bundled binary. |
| Existing account environment | `options.env`, including `CLAUDE_CONFIG_DIR` | Supported. |

Sources for the matrix:
[Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
[streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output),
[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
[slash commands](https://code.claude.com/docs/en/agent-sdk/slash-commands),
[cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking), and
[permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

## Interface Details

### Persistent input and interruption

Anthropic calls streaming input the recommended mode for a long-lived,
interactive agent. It supports multiple messages, image uploads, queued
messages, hooks, real-time output, and context persistence. The TypeScript
`Query` object adds `interrupt()` and `streamInput()` on top of the async
message iterator.
[Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

The documented interrupt contract stops the current query. The Python
reference makes an important sequencing rule explicit: interruption does not
clear messages already buffered for the interrupted task, including its error
result, so the host must drain that result before consuming the next query's
response. The Claude bridge must use an equivalent state machine even if it is
implemented with the TypeScript SDK.
[Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python)

No public SDK method is named or described as "steer", "append to the active
turn", or "replace the current prompt without interruption." Therefore:

- A local CLI probe confirmed that a second ordinary user message waits for the
  active turn to finish.
- The bridge can call `interrupt()`, drain the interrupted result, then submit
  the replacement input in the same session.
- The live prototype must prove output suppression and source-channel routing
  across that boundary.

### Output and usage

With `includePartialMessages`, the SDK yields raw streaming events for text and
tool-input deltas, then complete assistant messages and a final result.
Assistant messages contain model, stop reason, content blocks, error
classification, and per-step token usage. Result messages contain session ID,
result subtype, cumulative query usage, per-model usage, context-window size,
cost estimate, and terminal reason.
[Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
[Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
[Cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

CCDM can keep normal model text private and detect Discord MCP tool calls from
assistant tool-use blocks. The optional text fallback can publish only the
final successful result when no Discord write tool was called.

The usage fields are sufficient to update the Discord nickname, but Anthropic
documents result usage as cumulative for one query rather than as an explicit
"current context fill percentage." The bridge should derive percentage from
the last model step and the reported context window, then lock that formula
with the prototype and local-fake E2E.

### Sessions, compact, clear, and resume

Claude sessions persist locally and can be resumed by ID. Resume lookup is
scoped to the original project directory, so the bridge must preserve both
`cwd` and the account/config environment. Sessions created in print/SDK mode do
not appear in the interactive picker but remain resumable by explicit ID.
[Claude Code sessions](https://code.claude.com/docs/en/sessions)
[Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

`/compact` is a supported SDK input. Manual and automatic compaction emit a
compact-boundary event containing the trigger and pre-compaction token count.
The bridge can wait for this event before reporting completion and injecting
its top-level Discord instruction again.
[Slash commands in the SDK](https://code.claude.com/docs/en/agent-sdk/slash-commands)
[Agent loop compaction](https://code.claude.com/docs/en/agent-sdk/agent-loop)

The interactive `/clear` command is not dispatchable in SDK mode. Anthropic's
documented equivalent is to end the current query and start a fresh
conversation; the old session remains on disk and can be resumed later.
[Slash commands in the SDK](https://code.claude.com/docs/en/agent-sdk/slash-commands)

The installed CLI additionally accepted `/clear` through its raw streaming
input, emitted `conversation_reset`, then emitted a new `system/init` with a
new session ID. An implementation using this behavior must replace its tracked
session ID. Because the SDK does not document `/clear` as dispatchable, the
SDK-based bridge should prefer the documented close-and-recreate composition.

### MCP and scoped Discord writes

Claude can load MCP servers from programmatic SDK options, JSON passed with
`--mcp-config`, or normal configuration sources. The TypeScript query can
dynamically replace its MCP set and inspect/reconnect/toggle server status.
Using a per-process SDK configuration avoids editing the user's persistent
Claude configuration.
[MCP documentation](https://code.claude.com/docs/en/mcp)
[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

The existing [Discord MCP server](../../scripts/discord-mcp-server.js) already
implements the required write token and root channel capability checks. The
Claude bridge can launch the same server with a fresh process token and, in
root mode, the active signed channel capability.

Anthropic documents that subagents start with a fresh conversation rather than
the parent's message history. It also documents that subagents inherit MCP tool
definitions. The bridge must therefore keep authorization in tool arguments,
not only in the tool's presence: the top-level bootstrap/user input receives
the capability, subagent prompts are told to return to the parent, and the MCP
server rejects missing or expired capabilities.
[Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
[Error reference](https://code.claude.com/docs/en/errors)

### Attachments and reactions

Streaming input supports image content blocks directly. CCDM can reuse its
current preprocessing for other Discord content:

- fetch text and wrap it with filename boundaries;
- transcribe audio locally and send the transcript as text;
- save other binary data under `.discord-attachments` and send the path;
- convert thumbs-up/down reactions to text input.

These operations happen before Claude input and do not depend on the official
Discord plugin.
[Streaming input image example](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

### Authentication and account isolation

The installed Claude CLI supports Claude subscription, Console, and supported
cloud-provider authentication. Credential precedence places subscription OAuth
after explicit environment credentials. `CLAUDE_CONFIG_DIR` relocates Claude
configuration, settings, session history, and plugins, and is the documented
mechanism for multiple account environments.
[Authentication](https://code.claude.com/docs/en/authentication)
[Environment variables](https://code.claude.com/docs/en/env-vars)

As of the research date, Anthropic's June 15 billing change is paused:
Agent SDK, `claude -p`, and third-party app use still draws from subscription
limits. That supports CCDM's existing owner-operated local account model, but
does not remove the separate restriction against routing other users through a
subscription.
[Current Agent SDK plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

The bridge must not use `--bare`: Anthropic documents that bare mode does not
read OAuth or Keychain credentials. It should pass the existing environment to
the installed CLI and avoid setting an API key.
[CLI reference](https://code.claude.com/docs/en/cli-usage)
[Authentication](https://code.claude.com/docs/en/authentication)

### Process lifecycle and remote hosts

The SDK's `Query.close()` terminates the underlying process and cleans up
resources; an `AbortController` can cancel operations. The SDK also accepts a
custom executable path and environment. This fits CCDM's existing tmux/process
ownership model and lets remote hosts use their locally installed Claude CLI
and authenticated `CLAUDE_CONFIG_DIR`.
[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)

Remote setup must install the SDK package alongside CCDM and keep the installed
Claude CLI available through `zsh -ic`. No remote orchestration is required.

## Installed CLI Probes

The local executable was Claude Code `2.1.220`. These probes used an isolated
temporary home, `--bare`, no credentials, no Discord connection, and no live
model request. Temporary files were removed afterward.

### Stream probe

The probe started:

```text
claude -p --bare \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --replay-user-messages \
  --no-session-persistence
```

It sent one documented user envelope on stdin. Before returning the expected
local authentication failure, the installed CLI emitted:

- `system/init` with a generated session ID, model, tools, MCP status, slash
  commands, permission mode, Claude version, and capability names;
- a requesting status event;
- the replayed user message with its UUID;
- a typed assistant authentication error;
- a final result with session ID, usage, model usage, terminal reason, and
  duration.

This verifies that the installed CLI's stream mode exposes the data needed by a
bridge. It does not make the undocumented raw control frames a stable API.

### MCP probe

A second isolated probe passed the repository's Discord MCP server as an inline
`--mcp-config` with `--strict-mcp-config`. After allowing startup time before
the first input, `system/init` reported the server as connected and listed all
six tools:

```text
reply
edit_message
react
fetch_messages
export_message_range
download_attachment
```

The probe then ended at the same local authentication check. It performed no
Discord tool call. This verifies that the installed CLI can load the existing
scoped MCP server per process without the Anthropic Discord plugin or a
persistent MCP config edit.

### Authenticated stream behavior

Controlled probes using the existing configured local account recorded no
credentials and made no Discord tool calls. One CLI process accepted two
sequential user messages and returned two results with the same session ID.
Partial events were followed by complete assistant and result messages. Result
messages included token usage, per-model usage, stop state, duration, and the
session ID.

Sending an ordinary second message during a long active turn queued it. Sending
an interrupt control request instead returned a success acknowledgement; the
active turn ended with `terminal_reason: "aborted_streaming"`, and the
replacement message ran immediately. This experimentally confirms
redirect-by-interrupt, not in-place steering. The control frame itself remains
an undocumented raw protocol detail, so production code should call the SDK's
documented `Query.interrupt()` method.

A separate resume probe started one process with an explicit session ID, then
started a second process with `--resume` in the same working directory. The
second process recalled the earlier context and reported the same session ID.
`/compact` was recognized but correctly reported that the short probe lacked
enough history to compact. `/clear` emitted `conversation_reset` and a new
session ID as described above.

## Required Follow-ups

1. The existing steering prototype must verify `interrupt()` plus immediate
   replacement input, interrupted-result draining, output suppression, and
   scoped MCP replies against the installed CLI.
2. Architecture must choose the TypeScript Agent SDK, pin a compatible version,
   and force `pathToClaudeCodeExecutable` to the installed CLI instead of
   relying on the SDK's bundled binary.
3. A new destination decision must resolve guest access because subscription
   credential routing for other users conflicts with Anthropic's published
   authentication rules.
