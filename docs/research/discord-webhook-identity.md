# Research: Discord Webhooks as Project Identity

Ticket: [Research Discord webhook limits for Project Identity](https://github.com/deepansh96/ccdm/issues/117), on the map [Wayfinder: Serve every project through one root bot](https://github.com/deepansh96/ccdm/issues/115). All findings come from the official docs (the discord-api-docs source). No Discord API calls were made.

Sources: [Webhook](https://discord.com/developers/docs/resources/webhook) (W), [Message](https://discord.com/developers/docs/resources/message) (M), [Uploading files](https://discord.com/developers/docs/reference#uploading-files), [Rate limits](https://discord.com/developers/docs/topics/rate-limits), [JSON error codes](https://discord.com/developers/docs/topics/opcodes-and-status-codes#json).

## Supported

- **Per-message name and avatar.** Execute Webhook accepts `username` and `avatar_url`. Stored webhook names must be 1–80 characters, must not contain `clyde` or `discord`, and follow the nickname rules (inferred to apply to overrides too). `myproj-codex · 42%` is valid.
- **Edit, delete and get.** These go through `/webhooks/{id}/{token}/messages/{id}`, with the webhook token only. The bot token can delete a webhook message (with MANAGE_MESSAGES) but **cannot edit its content**.
- **Files.** Up to 10 per message. The per-file size is 20 MiB by default, raised only by the server's boost tier.
- **Mentions.** `allowed_mentions` works on execute and on edit, and must be re-sent on every edit.
- **Threads and forums.** Supported through `thread_id`, or `thread_name` for forum posts.
- **Buttons.** Webhooks created by the root bot are application-owned, so they can send components, and interactions route to the root bot.
- **Caps.** 15 webhooks per channel and 1000 per guild. MANAGE_WEBHOOKS is needed to create them.

## Not supported, or needs care

1. **No native replies.** Execute Webhook has no `message_reference` (open requests: discussions [#3282](https://github.com/discord/discord-api-docs/discussions/3282) and [#8544](https://github.com/discord/discord-api-docs/discussions/8544)).
2. **No reactions or typing from a webhook.** Both always show as the root bot.
3. **Project provenance comes from `webhook_id`** (equal to `author.id`). `application_id` is the root app for every project webhook, and display names can be spoofed. Replacing a channel's webhook needs its old IDs kept for history.
4. **Rate limits for webhooks aren't documented.** There are community reports of shared per-guild buckets. Follow the `X-RateLimit-*` headers and `Retry-After`, and batch progress edits together.
5. **Error 30046** caps edits to messages older than one hour. Long-running progress should post a fresh message.
6. **The webhook token is a bearer credential.** Anyone who has it can post as the project, so it should be stored like other secrets and only the Router should hold it.

## Implications for the map

- Keep charting decision 3. Agent-initiated replies to a specific message need a fallback, either a jump link or quote in the webhook message, or a root-bot reply. The Project Identity ticket decides which.
- Reminder and agent-reply detection must key on the project webhook's `webhook_id` (Conversation Reminders ticket).
- The Router owns webhook creation and tokens, uses `?wait=true` to get message IDs back, and handles rate-limit headers (Router-to-session contract ticket).
