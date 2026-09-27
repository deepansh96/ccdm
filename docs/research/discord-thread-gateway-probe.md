# Discord gateway thread behaviour probe

Task evidence for wayfinder ticket #79 (map #77), run on 2026-09-27 between 17:19 and 18:51 UTC.

## Setup

- **Bot:** an assigned project bot, chosen by the owner. Its own project session was not running during the probe.
- **Test channel:** a throwaway text channel in a managed category.
  - The category's deny overwrites were copied onto it, so no other project bot could view it.
  - The test bot got a member overwrite of `274878008384 | CREATE_PUBLIC_THREADS` (`309237746752`).
- **Listeners:** two independent discord.js 14 processes (A and B) logged into the **same bot token** at the same time. Intents were Guilds, GuildMessages, MessageContent and GuildMessageReactions. Each logged raw gateway events for the test channel and its threads, with no tokens logged.
- **Other actions:** REST calls used the test bot and, where noted, root.
- **Cleanup:** the channel was deleted after the probe.

## Results

| Question | Observation |
|---|---|
| Two concurrent gateway sessions on one token | Both reached READY on shard `[0,1]` with distinct session ids. Over 90 minutes, **A and B received identical event sequences (31 events each)**, with no disconnect or invalidation. |
| Bot creates a standalone public thread (`type 11`, 1-week archive) | Allowed with Create Public Threads. Events: parent `MESSAGE_CREATE` type 18 (thread-created system message), `THREAD_CREATE` with `thread_metadata`, then `THREAD_MEMBER_UPDATE`, since the creator joins automatically. |
| Bot starts a thread from a message (1-hour archive) | Allowed. The thread id equals the starter message id. Events: `THREAD_CREATE`, then the thread's `MESSAGE_CREATE` type 21 (starter reference). |
| Owner creates a thread; the bot is not a member | `THREAD_CREATE` arrived with `member_count: 1`, the owner only. The owner's message inside it arrived as `MESSAGE_CREATE` with `channel_id` set to the thread id, so **no join is needed for public threads**. |
| Default archive for an owner-created thread | The client default was **4320 (3 days)**, not 1 week. |
| Owner archives (closes) a thread | `THREAD_UPDATE` with `archived: true` and a fresh `archive_timestamp`. The root guild audit log (action 111) recorded `user_id` = owner and `archived: false → true`. |
| Bot posts into an owner-archived thread | Posted with HTTP 200. The thread **unarchived**: `THREAD_UPDATE` with `archived: false`, then `THREAD_MEMBERS_UPDATE` adding the bot, then `THREAD_CREATE` again ("added to thread"), then the bot's `MESSAGE_CREATE`. A listener must not treat the re-sent `THREAD_CREATE` as a new thread. |
| Bot changes `auto_archive_duration` or archives an owner-created thread | Rejected with **403 Missing Access (50001)**. This needs Manage Threads. |
| Bot archives or unarchives **its own** thread | Allowed without Manage Threads. Each change emits `THREAD_UPDATE`. |
| Thread deleted (by root) | `THREAD_DELETE` with `id`, `parent_id` and `type`. The parent's system message received a `MESSAGE_UPDATE` carrying the thread reference just before. |
| Auto-archive after inactivity | **Not observed.** The 1-hour thread was still `archived: false` 91 minutes after its last message (checked via REST at 18:50 UTC). Discord archives lazily, so archive timing cannot be used to detect auto-archive. |
| Listing archived public threads (bot) | Allowed. It returned no threads because the only archived thread had just been reopened. |

## Implications

- A single watcher per bot sees every public thread and message under its visible channels without joining them. Concurrent gateway sessions on one bot token are reliable, which covers Claude thread sessions each holding their own connection.
- Telling an owner archive apart from an auto-archive needs the audit log, which root can read, or an actor-based rule. Timing heuristics are unreliable because auto-archive is lazy.
- A bot posting into an archived thread reopens it and re-sends `THREAD_CREATE`. Reminder posts would therefore reopen threads, and listeners must deduplicate by thread id.
- Setting a 1-week archive on owner-created threads, or archiving them on `/close`, needs Manage Threads on the project channel.
