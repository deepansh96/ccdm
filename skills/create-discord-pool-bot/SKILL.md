---
name: create-discord-pool-bot
description: Create a Discord bot application in the user's logged-in browser, configure and invite it, then register it as an available CCDM pool bot. Use for CCDM requests such as "create a new bot", "pool add", or replenishing the Discord bot pool.
---

# Create Discord Pool Bot

Treat this as a transaction: inspect, create, register, then verify. Stop only at a user-only challenge or when every completion check passes.

## 1. Inspect

1. Read `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, and `registry.json` from the repo root.
2. Confirm `pool.length < max_pool_size`.
3. Confirm the target guild has enough remaining bot-integration capacity for the requested batch. Stop before creating applications that cannot be invited.
4. Find the highest bot number in both `registry.json` and the Developer Portal application list. Use the next number unless the user specifies one. Never create a duplicate because the portal and registry can drift.
5. Find the next unused `~/.claude/channels/discordN` directory number independently of the bot number.

Complete this phase only when the application name and state directory are both unambiguous.

## 2. Create

Use the browser profile the user names because it contains the signed-in Discord session. Load the matching browser-control skill first. For Brave, use Computer Use; if Aerospace hides the window, focus it with `aerospace list-windows --all` and `aerospace focus --window-id <id>`.

1. Open `https://discord.com/developers/applications` in a new tab.
2. Click **New Application**, enter the chosen bot name, accept the terms, and click **Create**.
3. Click the hCaptcha checkbox. If an image challenge appears, ask the user to solve it; continue after the application opens.
4. Record the application ID from the resulting URL.
5. Open **Bot**, enable **Message Content Intent**, and click **Save Changes**.
6. Click **Reset Token** and confirm.
7. At MFA, let the user enter credentials. Use a saved-password dropdown only when the user explicitly tells you which entry to select. Never ask the user to send a password in chat.
8. Capture the one-time token and immediately proceed to registration. Never repeat the token in chat, screenshots, command output, or the final response.

Complete this phase only when the token is visible once, Message Content Intent is saved, and the application ID is known.

## 3. Invite

Open this URL in a new tab, substituting the application ID:

```text
https://discord.com/oauth2/authorize?client_id=<app_id>&permissions=274878008384&integration_type=0&scope=bot
```

Select the server whose ID matches `registry.json.guild_id`, continue, verify these permissions, then authorize:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

Complete this phase only when Discord reports that the bot was added to the intended server.

## 4. Register

1. Add one object to `registry.json.pool`:

```json
{
  "id": "bot<bot_number>",
  "app_id": "<app_id>",
  "token": "<token>",
  "state_dir": "~/.claude/channels/discord<state_number>",
  "assigned_to": null
}
```

2. Create the state directory with `mkdir -p`.
3. Keep `assigned_to` null. Pool creation does not assign a project.
4. Preserve unrelated dirty-worktree changes and the existing JSON style.

Complete this phase only when the registry parses and contains exactly one matching available entry.

## 5. Verify

Use the stored token without printing it:

1. Call `GET https://discord.com/api/v10/users/@me` with `Authorization: Bot <token>` and require a successful response whose ID equals `app_id`.
2. Call `GET https://discord.com/api/v10/users/@me/guilds` and require `registry.json.guild_id` to be present.
3. Confirm the state directory exists, `assigned_to` is null, the pool remains within `max_pool_size`, and `git diff --check -- registry.json` passes.

Report only the bot ID, application ID, state directory, server membership, and availability. Never report the token.
