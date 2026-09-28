#!/usr/bin/env python3
"""Shared Claude launch mapping for Channel and Thread Conversations.

`start-session.sh` and `start-thread-session.sh` both resolve a project's
Claude settings, write the conversation-scoped proxy configuration, and build
the tmux launch command here, so model, effort, and account flags map in one
place. Registry errors surface as the tracebacks the launchers always showed."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from uuid import uuid4


EFFORTS = ("low", "medium", "high", "xhigh", "max")
SCRIPTS = Path(os.path.abspath(__file__)).parent
ROOT_DIR = SCRIPTS.parent


def valid_thread_id(value: str) -> str:
    if not re.fullmatch(r"\d+", value or ""):
        raise argparse.ArgumentTypeError("a thread id is a Discord snowflake (digits only)")
    return value


def valid_session_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9-]+", value or ""):
        raise argparse.ArgumentTypeError("a Claude session id has only letters, digits, and hyphens")
    return value


def resolve(registry_path: str, project: str, thread_id: str | None = None) -> dict:
    registry = json.load(open(registry_path))
    entry = registry["projects"][project]
    effort = entry.get("claude_effort")
    if effort is None or effort == "":
        effort = None
    elif not isinstance(effort, str) or effort not in EFFORTS:
        sys.exit("Invalid claude_effort (expected low, medium, high, xhigh, or max)")
    bot = next(b for b in registry["pool"] if b["id"] == entry["bot_id"])
    bot_state_dir = os.path.expanduser(bot["state_dir"])
    resolved = {
        "path": os.path.expanduser(entry["path"]),
        "state_dir": bot_state_dir,
        "session_name": entry["screen_name"],
        "model": entry.get("model") or None,
        "effort": effort,
        "claude_home": os.path.expanduser(entry["claude_home"]) if entry.get("claude_home") else None,
        "channel_id": str(entry["channel_id"]),
    }
    if thread_id:
        # Each Thread Conversation gets its own state dir under the bot's, so
        # listener identity (exact normalized state-dir path) never matches
        # the Channel Conversation or a sibling thread.
        state_dir = os.path.join(bot_state_dir, "threads", thread_id)
        resolved.update({
            "thread_id": thread_id,
            "bot_state_dir": bot_state_dir,
            "state_dir": state_dir,
            "session_name": f"{entry['screen_name']}-t-{thread_id[-6:]}",
            "bootstrap_file": os.path.join(state_dir, "ccdm-thread-bootstrap.json"),
        })
    return resolved


def print_fields(resolved: dict) -> None:
    # Tab-delimited for zsh `read`; empty optional fields print as __NONE__
    # because adjacent tabs collapse under zsh IFS splitting.
    fields = ("path", "state_dir", "session_name", "model", "effort", "claude_home", "channel_id")
    print("\t".join(resolved[name] or "__NONE__" for name in fields))


def listener_pids(state_dir: str) -> list[int]:
    """Claude Discord listener processes whose DISCORD_STATE_DIR is exactly ``state_dir``."""
    target = os.path.normpath(os.path.expanduser(state_dir))
    try:
        ps = subprocess.check_output(["ps", "axeww", "-o", "pid=,command="], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return []
    env_re = re.compile(r"""DISCORD_STATE_DIR=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")
    root_re = re.compile(r"""CLAUDE_PLUGIN_ROOT=(?:"([^"]+)"|'([^']+)'|([^\s]+))""")

    def values(pattern, command):
        return [next(group for group in match.groups() if group is not None) for match in pattern.finditer(command)]

    def is_discord_plugin_path(value: str) -> bool:
        path = os.path.normpath(os.path.expanduser(value))
        roots = ("claude-plugins-official/discord", "claude-plugins-official/external_plugins/discord")
        return any(path.endswith(f"/{root}") or f"/{root}/" in path for root in roots)

    def is_listener(command: str) -> bool:
        try:
            argv = shlex.split(command)
        except ValueError:
            return False
        if not argv:
            return False
        exe = os.path.basename(argv[0])
        if exe in {"tmux", "zsh", "bash", "sh", "fish", "login"}:
            return False
        if exe == "claude" and (
            ("--channels" in argv and any(arg.startswith("plugin:discord") for arg in argv))
            or ("--dangerously-load-development-channels" in argv and "server:discord" in argv)
        ):
            return True
        if exe == "node" and any(os.path.basename(arg) == "claude-reminder-channel.js" for arg in argv[1:]):
            return True
        if exe == "claude-channel-discord":
            return True
        if exe == "bun" and "run" in argv and any(
            arg == "--cwd" and is_discord_plugin_path(argv[index + 1]) for index, arg in enumerate(argv[:-1])
        ):
            return True
        return exe == "bun" and any(
            os.path.basename(arg) == "server.ts" and
            (is_discord_plugin_path(arg) or any(is_discord_plugin_path(root) for root in values(root_re, command)))
            for arg in argv[1:]
        )

    pids = []
    for line in ps.splitlines():
        pid_text, _, command = line.strip().partition(" ")
        if not pid_text.isdigit() or "ps axeww" in command or "python3 -" in command or "claude-launch.py" in command:
            continue
        if any(os.path.normpath(os.path.expanduser(value)) == target for value in values(env_re, command)) \
                and is_listener(command):
            pids.append(int(pid_text))
    return pids


def private_json(path: Path, value: dict) -> None:
    with open(path, "w") as f:
        json.dump(value, f, indent=2)
        f.write("\n")
    os.chmod(path, 0o600)


def prepare_thread_state(registry: dict, project: str, resolved: dict) -> None:
    """A private thread state dir: the bot credential by symlink, never copied,
    and a static access.json holding only the parent group."""
    state_dir = Path(resolved["state_dir"])
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    credential = state_dir / ".env"
    if credential.is_symlink() or credential.exists():
        credential.unlink()
    credential.symlink_to(Path(resolved["bot_state_dir"]) / ".env")
    entry = registry["projects"][project]
    users = []
    for user in [registry.get("discord_user_id"), *(entry.get("guest_user_ids") or [])]:
        if user and str(user) not in users:
            users.append(str(user))
    private_json(state_dir / "access.json", {
        "dmPolicy": "allowlist", "allowFrom": [],
        "groups": {resolved["channel_id"]: {"requireMention": False, "allowFrom": users}}, "pending": {},
    })
    # A bootstrap left by an earlier, failed boot must never reach this launch.
    Path(resolved["bootstrap_file"]).unlink(missing_ok=True)


def launch_command(registry_path: str, project: str, thread_id: str | None, resume: str | None = None) -> str:
    """Write the launch's proxy MCP config and settings; return its tmux shell command.
    ``resume`` continues that Claude session under the same home and cwd."""
    resolved = resolve(registry_path, project, thread_id)
    registry = json.loads(Path(registry_path).read_text())
    state_dir = resolved["state_dir"]
    channel_id = resolved["channel_id"]
    claude_home = resolved["claude_home"] or ""
    # Reminder hooks and markers are for Channel Conversations only.
    adapter_enabled = os.environ.get("CCDM_CLAUDE_REMINDER_ADAPTER", "0") == "1" and not thread_id
    version = subprocess.run(["claude", "--version"], capture_output=True, text=True)
    # Claude Code auto-updates, so accept any 2.x release from the first tested one;
    # the MCP proxy still rejects a changed plugin tool contract.
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:\s|$)", version.stdout.strip())
    parsed = tuple(int(part) for part in match.groups()) if match else None
    if version.returncode != 0 or not parsed or parsed[0] != 2 or parsed < (2, 1, 281):
        sys.exit("Claude Discord proxy: unsupported Claude Code version (requires 2.x from 2.1.281)")
    bot_id = registry["projects"][project]["bot_id"]
    bots = [bot for bot in registry["pool"] if bot.get("id") == bot_id]
    bot_app_id = str(bots[0].get("app_id") or "") if len(bots) == 1 else ""
    if adapter_enabled and not bot_app_id:
        sys.exit("Claude reminder adapter requires an unambiguous assigned bot app ID")
    root_app_id = registry.get("root_bot_app_id") or ""
    root_env = Path(os.environ.get("ROOT_DISCORD_STATE_DIR") or Path.home() / ".claude" / "channels" / "discord") / ".env"
    if root_env.is_file():
        token = re.search(r"^DISCORD_BOT_TOKEN=(\S+)", root_env.read_text(), re.MULTILINE)
        if token:
            encoded_id = token.group(1).split(".")[0]
            try:
                root_app_id = base64.urlsafe_b64decode(encoded_id + "=" * (-len(encoded_id) % 4)).decode("ascii")
            except (ValueError, UnicodeDecodeError):
                pass
    if adapter_enabled and not root_app_id:
        sys.exit("Claude reminder adapter requires root bot identity")
    selected_home = Path(claude_home) if claude_home else Path.home() / ".claude"
    plugin_cache = selected_home / "plugins" / "cache" / "claude-plugins-official" / "discord"
    if adapter_enabled:
        # The reminder capability is pinned to the tested plugin release.
        plugin_dir = plugin_cache / "0.0.4"
        if not (plugin_dir / "server.ts").is_file():
            sys.exit("Claude reminder adapter requires installed official Discord plugin 0.0.4")
    else:
        installed = []
        for candidate in plugin_cache.glob("*/server.ts"):
            release = candidate.parent.name
            if re.fullmatch(r"\d+(?:\.\d+)*", release):
                installed.append((tuple(int(part) for part in release.split(".")), candidate.parent))
        if not installed:
            sys.exit("Claude Discord proxy requires the installed official Discord plugin")
        plugin_dir = max(installed)[1]

    if thread_id:
        prepare_thread_state(registry, project, resolved)
    os.makedirs(state_dir, exist_ok=True)
    config_path = Path(state_dir) / "ccdm-message-export-mcp.json"
    settings_file = str(Path(state_dir) / ("ccdm-conversation-reminder-hooks.json" if adapter_enabled
                                           else "ccdm-claude-channel-settings.json"))
    config = {"mcpServers": {"discord-message-export": {
        "command": "node", "args": [str(SCRIPTS / "discord-mcp-server.js")],
        # A thread's read-only exporter is scoped to the thread itself.
        "env": {"CHANNEL_ID": thread_id or channel_id, "DISCORD_STATE_DIR": state_dir, "DISCORD_MCP_EXPORT_ONLY": "1"},
    }}}
    env = {
        "CCDM_REMINDER_PROJECT_ROOT": str(ROOT_DIR),
        "CCDM_CLAUDE_REMINDER_ADAPTER": "1" if adapter_enabled else "0",
        "CCDM_CLAUDE_PROJECT": project,
        "CCDM_CLAUDE_CHANNEL_ID": channel_id,
        "CCDM_CLAUDE_BOT_APP_ID": bot_app_id,
        "CCDM_CLAUDE_ROOT_APP_ID": str(root_app_id),
        "CCDM_CLAUDE_PLUGIN_ROOT": str(plugin_dir),
    }
    if thread_id:
        # The proxy pins the thread and hands over the supervisor's bootstrap.
        env.update({"CCDM_CLAUDE_THREAD_ID": thread_id, "CCDM_CLAUDE_BOOTSTRAP_FILE": resolved["bootstrap_file"],
                    "DISCORD_STATE_DIR": state_dir, "DISCORD_ACCESS_MODE": "static"})
    settings: dict = {"enabledPlugins": {"discord@claude-plugins-official": False}}
    if adapter_enabled:
        reminder_dir = Path(os.environ.get("CCDM_REMINDER_STATE_DIR") or Path.home() / ".local" / "state" / "ccdm" / "conversation-reminders")
        env.update({
            "CCDM_REMINDER_STATE_DIR": str(reminder_dir),
            "CCDM_REMINDER_RECEIPTS_DIR": str(reminder_dir / "claude-receipts"),
            "CCDM_CLAUDE_LAUNCH_ID": str(uuid4()),
            "CCDM_CLAUDE_HOOK_SETTINGS": settings_file,
        })
        # Hook commands are command hooks: no prompt/agent hook can invoke a model.
        hook = str(SCRIPTS / "claude-reminder-hook.js")
        settings["hooks"] = {event: [{"hooks": [{"type": "command", "command": f"node '{hook}'"}]}]
                             for event in ("SessionStart", "Stop", "StopFailure", "SessionEnd")}
        # The Claude process inherits launch-scoped context, including the same ID
        # as its channel server and its command hooks.
        private_json(Path(state_dir) / "ccdm-conversation-reminder-env.json", env)
    else:
        # A plain launch leaves no reminder hooks or context behind from an earlier one.
        for stale in ("ccdm-conversation-reminder-hooks.json", "ccdm-conversation-reminder-env.json"):
            (Path(state_dir) / stale).unlink(missing_ok=True)
    config["mcpServers"]["discord"] = {"command": "node", "args": [str(SCRIPTS / "claude-reminder-channel.js")], "env": env}
    private_json(Path(settings_file), settings)
    private_json(config_path, config)

    launch_env = f"DISCORD_STATE_DIR='{state_dir}'"
    if thread_id:
        # Access is snapshotted at boot and never written by the plugin.
        launch_env += " DISCORD_ACCESS_MODE='static'"
    if claude_home:
        launch_env += f" CLAUDE_CONFIG_DIR='{claude_home}'"
    if adapter_enabled:
        launch_env += "".join(f" {key}='{value}'" for key, value in env.items())
    flags = "--dangerously-load-development-channels server:discord --dangerously-skip-permissions"
    flags += f" --mcp-config '{config_path}' --settings '{settings_file}'"
    if resolved["model"]:
        flags += f" --model '{resolved['model']}'"
    if resolved["effort"]:
        flags += f" --effort '{resolved['effort']}'"
    if resume:
        flags += f" --resume '{resume}'"
    return f"cd '{resolved['path']}' && {launch_env} claude {flags}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("resolve", "launch-command"):
        command = commands.add_parser(name)
        command.add_argument("registry")
        command.add_argument("project")
        command.add_argument("--thread-id", type=valid_thread_id)
        if name == "resolve":
            command.add_argument("--json", action="store_true")
        else:
            command.add_argument("--resume", type=valid_session_id)
    commands.add_parser("listener-pids").add_argument("state_dir")
    args = parser.parse_args()
    if args.command == "resolve":
        resolved = resolve(args.registry, args.project, args.thread_id)
        if args.json:
            print(json.dumps(resolved, sort_keys=True))
        else:
            print_fields(resolved)
    elif args.command == "launch-command":
        print(launch_command(args.registry, args.project, args.thread_id, args.resume))
    else:
        for pid in listener_pids(args.state_dir):
            print(pid)


if __name__ == "__main__":
    main()
