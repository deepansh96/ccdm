# Thread Supervisor

The Thread Supervisor is the root-level service that binds Discord threads in registered project channels to their projects. See the [README section](../README.md#thread-supervisor) for what it binds. This guide covers running it: as an opt-in macOS LaunchAgent, or in the foreground for debugging. Both run the same `scripts/thread-supervisor.py run` worker and share one worker lock.

## Requirements

- `registry.json` must name the CCDM owner (`discord_user_id`) and hold valid project assignments.
- The root Discord bot token must be in `ROOT_DISCORD_STATE_DIR/.env` as `DISCORD_BOT_TOKEN`; the default root state directory is `~/.claude/channels/discord`.
- Python 3 and Node 22 or newer. The supervised worker uses the interpreters the installer resolved, not the login shell's `PATH`.

## Install

From the repository root:

```sh
scripts/install-thread-supervisor.sh
scripts/thread-supervisor.py status
```

The installer validates everything before it touches launchd. It checks for `python3` and Node 22 or newer (`CCDM_THREAD_NODE` or `node` on `PATH`), the plist template, and the supervisor script. It then runs the read-only `scripts/thread-supervisor.py preflight`, which checks the registry owner and project assignments, root Discord credentials, a private state directory, a usable thread store, and that the root bot can read the guild audit log (View Audit Log), which archive handling needs. If any check fails, the installer exits nonzero and lists the blockers. It does not create or change the plist, launchd, the state directory, or file permissions, and a working installation stays loaded.

On success it renders `~/Library/LaunchAgents/com.discord.thread-supervisor.plist` from `scripts/com.discord.thread-supervisor.plist.in` and loads it. The plist holds only absolute paths: the Python interpreter, the supervisor script, the repository, the state directory, Node (`CCDM_THREAD_NODE`), and the root state directory. It holds no tokens, registry values, or channel IDs; the worker reads credentials from their existing private files. `RunAtLoad` starts the worker at login. `KeepAlive` relaunches it only after an unsuccessful exit, with a 30-second throttle, so a crash or a lost lock race is retried and a `disable` stays stopped. The worker's umask is `077`.

State lives in `~/.local/state/ccdm/thread-supervisor/`, or `CCDM_THREAD_STATE_DIR` when it is set at install time. The directory is `0700`. The thread store, worker lock, `disabled` marker, and the `service.log` and `service.err` logs are `0600`. The running worker also listens on `requests.sock` (`0600`), the private request socket through which `scripts/threads.sh create` and the channel agents' `create_thread` tool submit creation requests; it removes the socket when it stops.

Running the installer again renders the same plist and reloads it. If launchd rejects a replacement, the installer restores the previous plist and reloads the previous service.

## Restart

Root restarts the supervisor with three commands:

```sh
scripts/thread-supervisor.py disable
scripts/thread-supervisor.py enable
scripts/install-thread-supervisor.sh
```

- `disable` writes the `disabled` marker and waits until the worker has released its lock. The worker stops its Gateway observer and exits successfully, so launchd does not relaunch it. While disabled, a launch at login exits at once without logging in. Bound threads are kept.
- `enable` clears the marker and runs the same checks as `preflight`. It exits with status 2 and lists the blockers if any check fails. It does not start a worker.
- The installer reloads the LaunchAgent, which starts the worker again.

To remove the LaunchAgent, run `disable`, then `launchctl unload ~/Library/LaunchAgents/com.discord.thread-supervisor.plist` and delete that file. Keep the state directory.

## Foreground debug mode

```sh
scripts/thread-supervisor.py disable     # stop the supervised worker first
scripts/thread-supervisor.py enable
scripts/thread-supervisor.py run         # foreground worker; Ctrl-C stops it
```

Only one worker runs at a time. A foreground `run` started while the supervised worker holds the lock exits with status 2 and reports that the thread supervisor is already running. A supervised launch that finds a foreground worker holding the lock exits the same way, and launchd retries it every 30 seconds. After debugging, rerun `scripts/install-thread-supervisor.sh` to hand the worker back to launchd.
