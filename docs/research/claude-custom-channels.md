# Research: Stability of Custom Claude Code Channels

Ticket: [Research the stability of custom Claude Code channels](https://github.com/deepansh96/ccdm/issues/118), on the map [Wayfinder: Serve every project through one root bot](https://github.com/deepansh96/ccdm/issues/115).

## Findings

1. **Status.** Channels are a *research preview*. A channel server declares `capabilities.experimental['claude/channel']`, emits `notifications/claude/channel` with `{content, meta}`, and may declare `claude/channel/permission` for permission relay. Meta keys must be identifiers; hyphenated keys are dropped. Sources: [Channels](https://code.claude.com/docs/en/channels.md), [Channels reference](https://code.claude.com/docs/en/channels-reference.md).
2. **Allowlist.** `--channels` loads only allowlisted plugins. The default list is `discord`, `telegram`, `imessage` and `fakechat` from `claude-plugins-official`. Team/Enterprise managed settings can replace that list with `allowedChannelPlugins`. Custom servers or plugins need `--dangerously-load-development-channels server:<name>` or `plugin:<name>@<marketplace>`. Packaging as a local plugin (with a `channels` array in `plugin.json`) does **not** avoid the flag unless an org admin allowlists it. Sources: [Channels reference, "Test during the research preview" and "Package as a plugin"](https://code.claude.com/docs/en/channels-reference.md), [Plugin manifest, Channels](https://code.claude.com/docs/en/plugins/manifest-reference.md).
3. **Confirmation prompt.** The development-channels warning appears at every interactive startup, after workspace trust, and no documented setting pre-accepts it. The live prototype on 2.1.284 confirmed the prompt and accepted it by sending Enter to the tmux pane. Source: Channels reference.
4. **Org policy.** `channelsEnabled` is the master switch and the development flag does not bypass it. It is off by default for claude.ai Team/Enterprise, and on for Console and for Pro/Max without an org. CCDM already runs Claude Discord channels on its Team accounts, so it is enabled there today. Source: [Channels, Enterprise controls](https://code.claude.com/docs/en/channels.md).
5. **Delivery semantics.** Notifications queue and arrive together at the next turn boundary. There is no delivery acknowledgment, and events are dropped silently if the session didn't load the server as a channel. This matches how the official Discord plugin behaves today. Source: Channels reference, "Notification format".
6. **Change history.** The permission relay changed in 2.1.211 (sanitization) and 2.1.234 (credential masking). No date for general availability has been published.

## Implications for the map

- The development flag is currently the only path for a custom channel on the owner's accounts. Launch automation must accept the per-launch confirmation, as it already does for the workspace trust prompt.
- A Claude Code update could change the flag or the protocol, so the destination needs a live smoke check for Claude channel delivery, and launches should fail visibly (not silently) when delivery breaks.
- An exit path, if preview breakage becomes costly: ask for an org `allowedChannelPlugins` entry, or fall back to the heavier Agent SDK bridge researched in the abandoned plugin-replacement map.
