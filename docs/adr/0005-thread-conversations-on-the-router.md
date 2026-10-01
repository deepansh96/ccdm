# Thread Conversations Run on the Router as One Session per Thread

Each public thread in a registered project channel becomes its own Thread Conversation, served through the Router like a channel session. It has its own per-launch key, and its Session Scope is that thread alone. A separate Thread Supervisor process connects to the Router as a client and owns the thread lifecycle: binding, start, stop, resume, close and the live-session cap. It holds no Discord credential and calls Discord only through Router operations.

Every live thread runs its own provider process: a Claude CLI, or a Codex bridge with its own app-server. This reverses #82, which had one Codex thread host per project serving many conversations. The per-thread bridge reuses the Router-mode bridge unchanged: steering, voice, attachments, reactions and context percentage. It removes the host and the per-conversation MCP overrides. The cost is one app-server per live Codex thread, which is why the Codex cap defaults to 8.

## Considered Options

- **Build the thread lifecycle into the Router daemon:** rejected. The Router holds the only bot token and is a single point of failure, so it stays a small transport. Process launching, the thread store and capacity logic live outside it.
- **Give the supervisor its own gateway login, or direct REST access with the root token (#114):** rejected. The Router stays the only gateway and the only token holder, with one shared rate-limit budget.
- **Keep one Codex thread host per project (#82/#114):** rejected. It needed its own Discord transport and a refactor of the bridge into several conversations per process, roughly doubling the work for a memory saving that the cap already bounds.

## Consequences

- Thread sessions identify themselves with `.thread-<thread_id>` keys, so rotating a project's key or restarting the channel never touches its threads.
- Thread replies use the parent project's webhook, with the thread's own provider in the username.
- Supervisor notices post as the root bot, so reminder agent-reply detection never counts them.
- Moving a project's channel closes its threads, because the moved webhook cannot post into the old channel's threads.
