# agy runs under its Gemini account's home (HOME=<account home>, see
# scripts/resolve-gemini-home.py), but the shell commands its agent runs
# should see the user's real home: their git, gh, ssh and tool settings.
# gemini-bridge.js points ZDOTDIR here and passes the real home and ZDOTDIR
# as CCDM_SHELL_HOME and CCDM_SHELL_ZDOTDIR; this restores both, then reads
# the user's own .zshenv as zsh would have.
export HOME="${CCDM_SHELL_HOME:-$HOME}"
if [[ -n "${CCDM_SHELL_ZDOTDIR:-}" ]]; then export ZDOTDIR="$CCDM_SHELL_ZDOTDIR"; else unset ZDOTDIR; fi
[[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]] && source "${ZDOTDIR:-$HOME}/.zshenv"
