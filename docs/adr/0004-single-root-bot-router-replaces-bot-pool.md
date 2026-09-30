# Single Root Bot Router Replaces the Bot Pool

CCDM will serve every project channel through the root bot: a separate local Router daemon holds the only bot token, routes each channel's messages to its session, and performs Discord actions only within that session's channel, with per-project webhooks giving each project a distinct visible identity. This trades Discord-enforced per-bot channel permissions for software-enforced scoping (no weaker in practice, since every local session could already read all pool tokens from disk) and makes the Router a single point of failure, in exchange for removing bot creation, pool management, and one token per project. Claude sessions keep the interactive CLI and use a custom development channel server instead of Anthropic's Discord plugin; the heavier Agent SDK bridge (the abandoned plugin-replacement effort) was rejected as too much rewrite.

## Considered Options

- Keep the Bot Pool and add the Router only as an option — rejected: two transports to maintain indefinitely.
- Make the root agent process the Router — rejected: a root crash or restart would take every project offline.
- Post every reply as the root bot — rejected: projects become indistinguishable and per-project context usage loses its display.
