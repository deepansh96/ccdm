#!/bin/zsh
# CCDM — Claude Code Discord Manager
# Interactive first-run setup script

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  CCDM — Claude Code Discord Manager Setup   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Check prerequisites ──
echo "Checking prerequisites..."
missing=()

if ! command -v claude &>/dev/null; then
    missing+=("claude (Claude Code CLI — install from https://docs.anthropic.com/en/docs/claude-code)")
fi
if ! command -v tmux &>/dev/null; then
    missing+=("tmux (brew install tmux / apt install tmux)")
fi
if ! command -v zsh &>/dev/null; then
    missing+=("zsh (brew install zsh / apt install zsh)")
fi
if ! command -v python3 &>/dev/null; then
    missing+=("python3 (brew install python3 / apt install python3)")
fi

if [ ${#missing[@]} -gt 0 ]; then
    echo ""
    echo "Missing required tools:"
    for m in "${missing[@]}"; do
        echo "  - $m"
    done
    echo ""
    echo "Install them and re-run this script."
    exit 1
fi

echo "  All prerequisites found."
echo ""

# ── Optional: check for whisper ──
if ! command -v whisper &>/dev/null; then
    echo "Note: whisper not found. Voice message transcription won't work."
    echo "  Install with: pip install openai-whisper"
    echo ""
fi

# ── Get Discord user ID ──
echo "To find your Discord user ID:"
echo "  1. Open Discord Settings > Advanced > enable Developer Mode"
echo "  2. Right-click your name in any chat > Copy User ID"
echo ""
read "discord_id?Enter your Discord user ID: "

if [ -z "$discord_id" ]; then
    echo "Error: Discord user ID is required."
    exit 1
fi

# ── Get Discord server (guild) ID ──
echo "To find your Discord server ID:"
echo "  1. Make sure Developer Mode is enabled (Settings > Advanced)"
echo "  2. Right-click the server name > Copy Server ID"
echo ""
read "guild_id?Enter your Discord server ID: "

if [ -z "$guild_id" ]; then
    echo "Error: Discord server ID is required."
    exit 1
fi

# ── Create registry.json ──
REGISTRY_CONTENT="{
  \"discord_user_id\": \"$discord_id\",
  \"guild_id\": \"$guild_id\",
  \"max_pool_size\": 50,
  \"project_bot_role_id\": null,
  \"category_ids\": [],
  \"pool\": [],
  \"projects\": {}
}"

if [ -f "$SCRIPT_DIR/registry.json" ]; then
    echo ""
    echo "registry.json already exists. Overwrite? (y/N)"
    read "overwrite?"
    if [[ "$overwrite" != [yY] ]]; then
        echo "Keeping existing registry.json."
    else
        echo "$REGISTRY_CONTENT" > "$SCRIPT_DIR/registry.json"
        echo "Created registry.json."
    fi
else
    echo "$REGISTRY_CONTENT" > "$SCRIPT_DIR/registry.json"
    echo "Created registry.json."
fi

# ── Get bot token ──
echo ""
echo "You need a Discord bot token for the root agent."
echo "If you don't have one yet, create a bot at https://discord.com/developers/applications"
echo "(See README.md for detailed instructions)"
echo ""
read "bot_token?Enter the root agent's Discord bot token: "

if [ -z "$bot_token" ]; then
    echo "Error: Bot token is required."
    exit 1
fi

# ── Determine state directory ──
STATE_BASE="$HOME/.claude/channels"
STATE_DIR="$STATE_BASE/discord"

# Check if the default directory is already in use
if [ -f "$STATE_DIR/.env" ]; then
    echo ""
    echo "Warning: $STATE_DIR already has a .env file."
    echo "This may be used by another bot. Overwrite? (y/N)"
    read "overwrite_state?"
    if [[ "$overwrite_state" != [yY] ]]; then
        # Find next available number
        n=2
        while [ -d "$STATE_BASE/discord${n}" ]; do
            ((n++))
        done
        STATE_DIR="$STATE_BASE/discord${n}"
        echo "Using $STATE_DIR instead."
    fi
fi

# ── Create state directory ──
mkdir -p "$STATE_DIR"

# Write .env
echo "DISCORD_BOT_TOKEN=$bot_token" > "$STATE_DIR/.env"
echo "Created $STATE_DIR/.env"

# Write access.json
cat > "$STATE_DIR/access.json" << EOF
{
  "dmPolicy": "allowlist",
  "allowFrom": ["$discord_id"],
  "groups": {},
  "pending": {}
}
EOF
echo "Created $STATE_DIR/access.json (you are pre-approved)"

# ── Make scripts executable ──
chmod +x "$SCRIPT_DIR/restart-root-agent.sh"
chmod +x "$SCRIPT_DIR/scripts/claude-usage.sh"

echo ""
echo "════════════════════════════════════════════════"
echo "  Setup complete!"
echo "════════════════════════════════════════════════"
echo ""
echo "To start the root agent:"
echo ""
echo "  tmux new-session -d -s root_agent -- zsh -ic 'cd $SCRIPT_DIR && DISCORD_STATE_DIR=$STATE_DIR claude --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions'"
echo ""
echo "Then message your bot on Discord to manage project sessions."
echo ""
echo "Useful commands:"
echo "  tmux attach -t root_agent   # Attach to the session"
echo "  tmux list-sessions          # List active sessions"
echo "  Ctrl+B, D                   # Detach from a session"
echo ""
