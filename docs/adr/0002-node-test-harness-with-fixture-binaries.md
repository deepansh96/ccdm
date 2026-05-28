# Node Test Harness With Fixture Binaries

CCDM's default E2E harness will use Node's built-in `node:test` runner and fixture binaries placed earlier on `PATH` to simulate host tools such as `tmux`, `claude`, `codex`, `security`, and `curl`. This keeps the suite dependency-light while still executing the real CCDM scripts and avoids CI accidentally depending on installed local tools, credentials, or live processes.
