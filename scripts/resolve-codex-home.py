#!/usr/bin/env python3
"""Resolve and validate a legacy Codex Home for a project or root launch."""

import json
import os
import stat
import sys
from typing import Any


class ResolverError(Exception):
    """An actionable configuration or Codex Home validation failure."""


def selector_value(container: Any, key: str, label: str) -> str | None:
    if not isinstance(container, dict) or key not in container or container[key] is None:
        return None

    value = container[key]
    if not isinstance(value, str):
        raise ResolverError(f"{label} must be a non-empty string; got {type(value).__name__}")
    if not value.strip():
        raise ResolverError(f"{label} must not be empty or whitespace-only")
    return value


def environment_selector(key: str, label: str) -> str | None:
    value = os.environ.get(key)
    if value is None or value == "":
        return None
    if not value.strip():
        raise ResolverError(f"{label} must not be empty or whitespace-only")
    return value


def expand_path(raw_path: str, label: str) -> str:
    if raw_path == "~" or raw_path.startswith("~/"):
        home = os.environ.get("HOME")
        if not home or not os.path.isabs(home):
            raise ResolverError(f"{label} path '{raw_path}' cannot resolve '~' without an absolute HOME")
        raw_path = home + raw_path[1:]

    if not os.path.isabs(raw_path):
        raise ResolverError(f"{label} path '{raw_path}' must be absolute or use '~'")

    return os.path.normpath(raw_path)


def validate_home(raw_path: str, label: str) -> str:
    resolved_path = expand_path(raw_path, label)

    try:
        home_stat = os.stat(resolved_path)
    except FileNotFoundError:
        if os.path.lexists(resolved_path):
            reason = "is a broken symlink"
        else:
            reason = "does not exist"
        raise ResolverError(f"{label} path '{raw_path}' resolves to '{resolved_path}' but {reason}")
    except OSError as error:
        raise ResolverError(
            f"{label} path '{raw_path}' resolves to '{resolved_path}' but cannot be inspected: {error.strerror}"
        )

    if not stat.S_ISDIR(home_stat.st_mode):
        raise ResolverError(f"{label} path '{raw_path}' resolves to '{resolved_path}' but is not a directory")

    for mode, description in (
        (os.R_OK, "readable"),
        (os.W_OK, "writable"),
        (os.X_OK, "traversable"),
    ):
        if not os.access(resolved_path, mode):
            raise ResolverError(f"{label} path '{raw_path}' resolves to '{resolved_path}' but is not {description}")

    config_path = os.path.join(resolved_path, "config.toml")
    if os.path.lexists(config_path):
        try:
            config_stat = os.stat(config_path)
        except OSError as error:
            raise ResolverError(
                f"{label} path '{raw_path}' has an unusable config.toml: {error.strerror}"
            )
        if not stat.S_ISREG(config_stat.st_mode):
            raise ResolverError(f"{label} path '{raw_path}' has a config.toml that is not a regular file")
        for mode, description in ((os.R_OK, "readable"), (os.W_OK, "writable")):
            if not os.access(config_path, mode):
                raise ResolverError(f"{label} path '{raw_path}' has a config.toml that is not {description}")

    return resolved_path


def resolve_codex_home(registry: dict[str, Any], project: str) -> str:
    projects = registry.get("projects")
    if not isinstance(projects, dict) or project not in projects:
        raise ResolverError(f"project '{project}' is not present in registry.json")
    project_config = projects[project]

    global_home = selector_value(registry, "codex_home", "top-level codex_home")
    project_home = selector_value(project_config, "codex_home", f"project '{project}' codex_home")

    if project_home is not None:
        selected_home = project_home
        selected_label = f"project '{project}' codex_home"
    elif global_home is not None:
        selected_home = global_home
        selected_label = "top-level codex_home"
    else:
        selected_home = "~/.codex"
        selected_label = "default codex_home"

    return validate_home(selected_home, selected_label)


def resolve_root_codex_home(registry: dict[str, Any]) -> str:
    root_override = environment_selector("ROOT_CODEX_HOME", "ROOT_CODEX_HOME")
    if root_override is not None:
        return validate_home(root_override, "ROOT_CODEX_HOME")

    global_home = selector_value(registry, "codex_home", "top-level codex_home")
    if global_home is not None:
        return validate_home(global_home, "top-level codex_home")

    ambient_home = environment_selector("CODEX_HOME", "ambient CODEX_HOME")
    if ambient_home is not None:
        return validate_home(ambient_home, "ambient CODEX_HOME")

    return validate_home("~/.codex", "default codex_home")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"Usage: {argv[0]} <registry.json> <project>|--root", file=sys.stderr)
        return 2

    try:
        with open(argv[1], encoding="utf-8") as registry_file:
            registry = json.load(registry_file)
        if not isinstance(registry, dict):
            raise ResolverError("registry.json must contain a JSON object")
        if argv[2] == "--root":
            resolved_home = resolve_root_codex_home(registry)
        else:
            resolved_home = resolve_codex_home(registry, argv[2])
    except ResolverError as error:
        print(f"Codex Home validation failed: {error}", file=sys.stderr)
        return 1

    print(resolved_home)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
