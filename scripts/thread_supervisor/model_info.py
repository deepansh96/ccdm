"""`/model`: which model, thinking level and account a conversation runs with.

Anyone the Router lets reach a project channel or its threads may ask, owner
or guest, and the answer is read-only. Each value comes from the first of:
the thread's override, the project's registry entry, then the provider
home's own defaults (Codex `config.toml`, Claude `settings.json`). Each line
says which, so `default` only appears when nothing names a value at all.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

from . import registry
from .link import LinkError


RESOLVER = Path(__file__).resolve().parents[1] / "resolve-codex-home.py"
DEFAULT_CLAUDE_HOME = "~/.claude"
# A top-level `key = "value"` in config.toml, before its first [table].
TOML_STRING = re.compile(r'^\s*([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$')
TOML_TABLE = re.compile(r"^\s*\[")


def _log(message: str) -> None:
    print(f"thread-supervisor: {message}", file=sys.stderr, flush=True)


def _expand(path: str) -> str:
    return os.path.normpath(os.path.expanduser(path))


def display_path(path: str) -> str:
    """``path`` with the user's home written as ``~``."""
    home = os.path.expanduser("~")
    full = _expand(path)
    return "~" + full[len(home):] if full == home or full.startswith(home + os.sep) else full


def codex_home_defaults(home: str) -> dict:
    """`model` and `model_reasoning_effort` at the top level of the home's config.toml."""
    values = {}
    try:
        lines = Path(_expand(home), "config.toml").read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        if TOML_TABLE.match(line):
            break
        match = TOML_STRING.match(line)
        if match and match.group(1) in ("model", "model_reasoning_effort"):
            values[match.group(1)] = match.group(2)
    return {"model": values.get("model"), "effort": values.get("model_reasoning_effort")}


def claude_home_defaults(home: str) -> dict:
    """`model` and `effortLevel` from the home's settings.json."""
    try:
        settings = json.loads(Path(_expand(home), "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        settings = {}
    if not isinstance(settings, dict):
        settings = {}
    pick = lambda key: settings.get(key) if isinstance(settings.get(key), str) and settings.get(key) else None
    return {"model": pick("model"), "effort": pick("effortLevel")}


def _resolver():
    spec = importlib.util.spec_from_file_location("ccdm_resolve_codex_home", RESOLVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def codex_home(current: dict, project: str, account: str | None) -> str | None:
    """The Codex home a session of ``project`` starts in, as its launcher resolves it."""
    try:
        return _resolver().resolve_codex_home(current, project, account)
    except Exception as error:  # A broken home is reported as unknown, not raised.
        _log(f"{project}: resolving the Codex home failed: {error}")
        return None


def codex_alias(current: dict, entry: dict, account: str | None) -> str | None:
    if account:
        return account
    alias = entry.get("codex_account") or (None if entry.get("codex_home") else current.get("default_codex_account"))
    return alias if isinstance(alias, str) and alias else None


def claude_alias(current: dict, home: str) -> str | None:
    """The `claude_accounts` alias naming ``home``, if any."""
    for alias, path in registry.accounts(current, "claude").items():
        if isinstance(path, str) and path and _expand(path) == _expand(home):
            return alias
    return None


def describe(current: dict, project: str, entry: dict, overrides: dict | None = None,
             provider_home: str | None = None) -> dict:
    """Provider, model, effort and account of a conversation of ``project``,
    each with its source; ``overrides`` are a thread's, ``provider_home`` the
    home a resumed thread conversation stays in."""
    overrides = overrides or {}
    resolved = registry.resolved_settings(entry, {field: overrides.get(field) for field in
                                                  ("provider", "account", "model", "effort")})
    provider = resolved["provider"]
    codex = provider == "codex"
    # The project's own values for the provider in use, as the launcher reads them.
    project_settings = registry.resolved_settings(entry, {"provider": provider, "account": None, "model": None,
                                                          "effort": None})
    if provider_home:
        home = provider_home
    elif codex:
        home = codex_home(current, project, resolved["account"])
    else:
        named = registry.accounts(current, "claude").get(resolved["account"]) if resolved["account"] else None
        home = named or entry.get("claude_home") or DEFAULT_CLAUDE_HOME
    defaults = (codex_home_defaults(home) if codex else claude_home_defaults(home)) if home else {}

    def pick(field: str) -> tuple[str | None, str | None]:
        if overrides.get(field):
            return overrides[field], "thread"
        if project_settings[field]:
            return project_settings[field], "project"
        if defaults.get(field):
            return defaults[field], "home config"
        return None, None

    model, model_source = pick("model")
    effort, effort_source = pick("effort")
    alias = codex_alias(current, entry, resolved["account"]) if codex else (
        resolved["account"] or (claude_alias(current, home) if home else None))
    return {
        "provider": provider,
        "provider_override": bool(overrides.get("provider")),
        "model": model, "model_source": model_source,
        "effort": effort, "effort_source": effort_source,
        "account": alias, "home": display_path(home) if home else None,
        "account_override": bool(overrides.get("account")),
    }


def lines(info: dict) -> list[str]:
    """The `/model` answer, one setting per line."""
    account = " · ".join(value for value in (info["account"], info["home"]) if value) or "unknown"
    shown = lambda field: (f"{info[field]} ({info[field + '_source']})" if info[field]
                           else "default" if info["provider"] == "codex" else "account default")
    return [
        f"Provider: {info['provider']}" + (" (thread)" if info["provider_override"] else ""),
        f"Model: {shown('model')}",
        f"Thinking: {shown('effort')}",
        f"Account: {account}" + (" (thread)" if info["account_override"] else ""),
    ]


def _notice(context, channel_id: str, text: str) -> None:
    try:
        context.link.call("thread_notice", {"channel_id": channel_id, "text": text})
    except LinkError as error:
        _log(f"{channel_id}: the /model notice failed: {error.code}")


def on_channel_model(context, event: dict) -> None:
    current = registry.load(context.project_root)
    project = str(event.get("project"))
    entry = registry.project(current, project)
    channel_id = event.get("channel_id")
    if not entry or not isinstance(channel_id, str):
        return
    _notice(context, channel_id, "\n".join(["This channel's session:", *lines(describe(current, project, entry))]))


def on_thread_model(context, row) -> None:
    current = registry.load(context.project_root)
    entry = registry.project(current, row["project"])
    if not entry:
        return
    # A resumed conversation stays in the home it started in.
    home = row["provider_home"] if row["provider_conversation_id"] else None
    info = describe(current, row["project"], entry, {field: row[field] for field in
                                                     ("provider", "account", "model", "effort")}, home)
    _notice(context, row["thread_id"], "\n".join([f"This thread's session ({row['state']}):", *lines(info)]))
