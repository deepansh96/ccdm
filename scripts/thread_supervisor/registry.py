"""The registry, read fresh on every use: guests are never cached for authorization."""

from __future__ import annotations

import json
import os
from pathlib import Path


def registry_path(project_root: Path) -> Path:
    override = os.environ.get("CCDM_REGISTRY_PATH")
    return Path(override) if override else project_root / "registry.json"


def load(project_root: Path) -> dict:
    with registry_path(project_root).open(encoding="utf-8") as source:
        registry = json.load(source)
    if not isinstance(registry, dict):
        raise ValueError("registry is not an object")
    return registry


def owner_id(registry: dict) -> str | None:
    owner = registry.get("discord_user_id")
    return owner if isinstance(owner, str) and owner else None


def project(registry: dict, name: str) -> dict | None:
    projects = registry.get("projects")
    entry = projects.get(name) if isinstance(projects, dict) else None
    return entry if isinstance(entry, dict) else None


def guests(registry: dict, name: str) -> list[str]:
    entry = project(registry, name) or {}
    values = entry.get("guest_user_ids")
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


def accounts(registry: dict, provider: str) -> dict:
    """A provider's account aliases: `claude_accounts` or `codex_accounts`."""
    values = registry.get(f"{provider}_accounts")
    return values if isinstance(values, dict) else {}


def resolved_settings(entry: dict, overrides) -> dict:
    """What a thread's session runs with: each override, else the project's setting."""
    provider = overrides["provider"] or entry.get("type") or "claude"
    codex = provider == "codex"
    return {
        "provider": provider,
        "account": overrides["account"],
        "model": overrides["model"] or (entry.get("codex_model") if codex else None) or entry.get("model"),
        "effort": overrides["effort"] or (entry.get("codex_reasoning_effort") or entry.get("model_reasoning_effort")
                                          if codex else entry.get("claude_effort")),
    }
