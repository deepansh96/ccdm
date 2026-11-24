# Agent Messages Live in the Router, with a Durable Ledger

Agent Messages (#387) are carried by the Router itself: one module that checks the Agent Message Grant, passes the Agent Request and Agent Reply between the two sessions' connections, posts the visible record in both conversations, and keeps an append-only ledger file in the Router's private state directory. The ledger holds open requests, expiry, limits and the audit record, so an Agent Reply sent after a Router restart still matches its Agent Request and a retried send never creates a second one. This is a deliberate exception to ADR 0005, which kept the Router a small transport with no store of its own: passing a message between two connections is the Router's core job, and the ledger is the smallest state that makes delivery deterministic across restarts.

## Considered Options

- **A separate service that connects to the Router as a client, like the Thread Supervisor:** rejected. Every message would hop Router → service → Router, "service not running" would become a new failure for every send, and there would be one more daemon to install and supervise.
- **Inside the Thread Supervisor, reusing its SQLite store:** rejected. The supervisor is opt-in and thread-only, so channel-to-channel messaging would depend on a service that exists for threads.
- **In the Router with in-memory state only, like `create_thread`'s pending requests:** rejected. A Router restart would forget every open Agent Request, so replies, expiry notices and duplicate checks would stop being deterministic.

## Consequences

- The Router gains its first durable state. The ledger must stay small and append-only, and a missing or unreadable ledger must not stop the Router from routing ordinary messages.
- The Router delivers an Agent Message through its own event, never by reading the Discord post back: bot and webhook messages still never reach a session.
- Nothing is queued for a session that is not live. The ledger remembers exchanges; it is not a store-and-forward queue.
