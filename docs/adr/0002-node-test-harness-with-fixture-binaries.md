# Node Test Harness With Fixture Binaries

CCDM's default E2E harness will use Node's built-in `node:test` runner and fixture binaries placed earlier on `PATH` to simulate host tools such as `tmux`, `claude`, `codex`, `security`, and `curl`. This keeps the suite dependency-light while still executing the real CCDM scripts and avoids CI accidentally depending on installed local tools, credentials, or live processes.

## Amendment: fixture binaries on Windows

Windows cannot run a shebang script found through `PATH`, so on Windows each fixture tool is a pair: `<tool>.exe`, a small launcher compiled from `tests/e2e/support/fixture-shim.cs`, and `<tool>.shim`, which names the program and leading arguments to start. No binary is committed. The harness compiles the launcher with the .NET Framework `csc.exe` that ships with Windows, once per content hash, and hard-links both files into each workspace, which needs no developer rights. The launcher copies the caller's arguments from the raw command line and returns the child's exit code. `npm test` stops before starting any file when `csc.exe`, Git Bash or Python is missing.

Fixture hooks run through Git Bash `sh`, the shell Claude Code uses on Windows, taken from Git's `usr\bin` so that Git's own `curl` and similar tools do not get ahead of the fixtures on `PATH`. Linux and macOS keep shell-script fixtures and `/bin/sh`, built the same way as before.
