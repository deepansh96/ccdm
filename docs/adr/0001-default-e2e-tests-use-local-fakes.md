# Default E2E Tests Use Local Fakes

CCDM's default end-to-end test suite will execute the real CCDM scripts and bridge code while replacing external services such as Discord, Claude, Codex, tmux, and Anthropic OAuth APIs with local fakes. A separate live smoke suite may exercise real external services, but it must be opt-in because it requires credentials, can mutate a Discord server, and may consume Claude or Codex quota.
