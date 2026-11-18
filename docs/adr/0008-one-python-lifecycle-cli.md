# One Python Lifecycle CLI for macOS and Windows

Every lifecycle command is a subcommand of one Python program, `scripts/ccdm`. The zsh launchers would otherwise need a second, PowerShell copy of every command, and the two would drift. Python already runs on both operating systems, and the session-host seam (`ccdmlib/platform/session_host.py`) gives it one API over tmux and `ccdm-host`.

## Three entry files

`scripts/ccdm` (sh) runs in Git Bash and on macOS, `scripts/ccdm.cmd` runs in PowerShell and cmd, and both start `scripts/ccdm.py`. A relative `scripts/ccdm` picks the right one by itself in each shell. From PowerShell, an absolute path must name `ccdm.cmd`: the extensionless file does nothing there and looks like success.

The sh entry exports `MSYS_NO_PATHCONV=1`, otherwise Git Bash rewrites `/compact` into a Windows path. Child processes inherit it, so Python code that starts a Git Bash program passes it Windows-form paths. The `.cmd` entry uses `setlocal` so that nothing leaks into the caller's cmd session. Free text must not go through `ccdm.cmd`, because cmd can run `&` and `|` in `%*` as commands. Both entries set `PYTHONUTF8=1` and look for Python in the order of `pythonCommand()`.

## Adding a subcommand

Add one module to `scripts/ccdmlib/cli/` that defines `register(subparsers)`. It adds its parser and calls `parser.set_defaults(func=handler)`; `handler(args)` returns the exit code. `__init__.py` is never edited. A package counts as a module. Names starting with `_` are helpers. A module that fails to import is reported on stderr and the others keep working, so one broken subcommand cannot take away a restart. Every module must import on Python 3.9 and on both operating systems.

## Launchers become shims

Each lifted `.sh` launcher keeps its name, because LaunchAgents, runbooks and people call it, and its body becomes:

```sh
exec "$(cd "$(dirname "$0")" && pwd)/ccdm" <subcommand> "$@"
```

Root-level shims (`restart-root*.sh`) use `.../scripts/ccdm`. Shims and `scripts/ccdm` are committed as mode `100755`, which `checkout-contract.test.js` checks; Windows does not track the bit, so set it with `git update-index --chmod=+x`. Shims work from any directory and under the bare environment of a LaunchAgent.

## The self-detach rule

A lifecycle command that stops its own session would die halfway. So each one calls `detach_if_self(target_session)` from `ccdmlib/cli/_detach.py` before its first change. Only when the target is the caller's own session (`CCDM_SESSION_NAME` equals the target's session name, or the caller's PID is in the target's `pids`) does the command start a copy of itself through the seam's `runDetached` and exit 0. On Windows that copy is a child of `ccdm-host`, outside the session's Job. Against any other session the command runs in the foreground with its usual output and exit code.

The copy runs with `CCDM_DETACHED=1` and without `CCDM_SESSION_NAME`, never re-dispatches, and logs to `<stateRoot>/logs/<subcommand>-<target>.log`. `ccdm-host` removes every `CCDM*` variable it is not given, so the caller's are passed explicitly. If the session host cannot be reached, a command in another session continues in the foreground and reports the host's error from its real work, while a command in its own session fails, since it has no safe way to continue.
