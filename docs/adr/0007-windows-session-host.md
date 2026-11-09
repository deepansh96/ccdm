# One Session Host Daemon per User on Windows

Windows has no tmux, so `scripts/ccdm-host.js serve` takes its place: one Node daemon per user that owns every CCDM session on the machine. Launchers talk to it through a tmux-shaped command line or its client library, and no client ever starts it: with no host running every client command fails at once with "ccdm-host is not running; start it with `node scripts/ccdm-host.js serve`".

The daemon holds each session in one Windows Job object with kill-on-close. Job members cannot leave a Job, so a detached grandchild dies with its session; a session that ends takes the rest of its Job with it. The cost is accepted plainly: **a host crash kills every session**, because the host holds every Job handle. The design leaves room for per-session pane processes later, if isolation between sessions is ever worth another process each.

## Protocol v1

State lives in `<stateRoot>/host/`, a private directory holding `host.pipe`, `host.secret`, `host.token`, `host.lock`, `sessions.json` and `logs/`. Each `serve` publishes a fresh random pipe name and secret, and rotates the token. Clients re-read all three on every connect, including when `CCDM_HOST_SOCKET` overrides the endpoint.

Single instance comes from `host.lock` (`"<pid> <startedAt>"`, the `router.lock` rule), not from the pipe name. `serve` refuses to run inside a Job object unless `--allow-in-job` is passed, since a daemon inside someone else's Job dies with that Job; the check lives in one function so the host task can adjust it.

Frames are NDJSON. The client first asks for the server proof (`{"type":"server_proof","nonce":...}` answered by `{"type":"server_proof_ok","proof":...}`, see `scripts/platform/ipc.js`) and sends nothing else until it verifies. Then the first frame must be `{"op":"hello","protocol_version":1,"token":"<host.token>"}`, answered by `{"ok":true,"type":"hello_ok","protocol_version":1}`. Any other frame before that, or a bad token, gets `not_authenticated` and the connection closes. A wrong version with a valid token gets `protocol_mismatch` ("restart ccdm-host to finish the upgrade").

Each request gets one response echoing its `id`: `{id, ok:true, …result}` or `{id, ok:false, error, message}`. Errors: `protocol_mismatch`, `not_authenticated`, `unknown_session`, `duplicate_session`, `unsupported_op`, `spawn_failed`.

| Op | Request | Result |
|---|---|---|
| `new` | `{name, argv[], cwd, env{}, pty, kind, log?}`; `kind` is `project`, `thread`, `root` or `adhoc` | `{pid}`; a live duplicate name gets `duplicate_session` |
| `has` | `{name}`, exact match only | `{live}` |
| `list` | `{}` | `{sessions:[{name, kind, pid, created, exit, pty}]}`; `created` is Unix seconds, `exit` is `null` while live |
| `send` | `{name, keys[], literal}` | `{}`; no-PTY writes to stdin |
| `capture` | `{name, history:false\|true\|N, join:false}` | `{text}`; no-PTY returns the in-memory tail of the log (false: one screen) |
| `pids` | `{name}` | `{pids}` from the session's Job |
| `kill` | `{name, graceMs=3000}` | `{killed:[pid]}`; grace phase (no-PTY: close stdin), then `TerminateJobObject` |
| `wait` | `{name, regex, timeoutMs, thenSend?[]}` | `{matched, ms, screen}`; answers `unsupported_op` until the ConPTY slice |
| `attach` | `{name, readOnly}`, then stream frames | `unsupported_op` until the attach slice |
| `run-detached` | `{argv[], cwd, env{}, log}` | `{pid}`; `unsupported_op` until the attach slice |
| `subscribe` | `{}`, then `{event:"exit", name, code}` pushes | `unsupported_op` until the attach slice |
| `ping` | `{}` | `{}` |
| `shutdown` | `{}` | `{}`; kills every session (grace, then Job), clears the journal, exits |

After a session's program exits, `has` is false and its output stays readable through `capture` until `kill-session` or a new `new` with that name. `kill` releases the name, and `pids` then answers an empty list.

## Session environment

A session's environment is rebuilt for every launch. The base is `CreateEnvironmentBlock(<user token>, FALSE)`, which gives what a fresh Explorer process gets. Nothing is inherited from the host, which may have been started from a shell full of agent settings. Next, a test seam (`CCDM_HOST_ENV_KEYS`, unset in production) merges named registry keys, then `cleanEnv` removes `CLAUDE*`, `ANTHROPIC*`, `MCP_*` and `CCDM*`, and finally the launch's explicit variables and `CCDM_SESSION_NAME=<name>` are added.

## Native packages

All are exact-version `optionalDependencies`, loaded lazily on win32 only and absent from Linux and macOS installs.

| Package | Version | Install script | Used by |
|---|---|---|---|
| `koffi` | 3.3.4 | Yes (`cnoke --prebuild`); loads from the prebuilt `@koromix/koffi-win32-x64` even when npm does not run it | Jobs, `CreateEnvironmentBlock`, process start times |
| `node-pty` | 1.1.0 | Yes (`install`: `node scripts/prebuild.js \|\| node-gyp rebuild`; `postinstall`: `node scripts/post-install.js`); ships prebuilt binaries | ConPTY sessions |
| `@xterm/headless` | 6.0.0 | No | The ConPTY session's screen |

## Considered Options

- **psmux instead of a new daemon:** kept as the fallback. A session host we own can answer terminal queries, read the rendered screen and confirm dialogs atomically.
- **One process per session pane:** deferred. It isolates a crash to one session, at the cost of another process and more protocol for every session.

## Consequences

- A crash, or anything else that stops the host, takes every session with it. The journal `sessions.json` is rewritten at each start, so it never names a session from before a crash.
- A helper a session starts cannot outlive that session; surviving a restart needs `run-detached`, which runs outside every Job.
- Clients need `koffi` only indirectly: the daemon is the one process that loads it, and every subcommand except `serve` runs without it.
