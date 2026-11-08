"""Home and state-root paths; the same answers as scripts/platform/paths.js."""

from __future__ import annotations

import os
import string
import sys
from pathlib import Path
from typing import Any

WIN32 = sys.platform == "win32"


def _resolved(path: str) -> str:
    """Resolve like Node's ``path.resolve``, which has no two-slash POSIX root."""
    absolute = os.path.abspath(path)
    if not WIN32 and absolute.startswith("//"):
        return absolute[1:]
    return absolute


def state_root() -> Path:
    """``CCDM_STATE_ROOT``, or ``~/.local/state/ccdm`` on every OS."""
    override = os.environ.get("CCDM_STATE_ROOT")
    if override:
        return Path(_resolved(override))
    return Path.home() / ".local" / "state" / "ccdm"


def expand_home(value: Any) -> Any:
    """Expand a leading ``~`` or ``~/``, and ``~\\`` on Windows; ``~user`` stays."""
    if not isinstance(value, str):
        return value
    if value == "~":
        return str(Path.home())
    if not (value.startswith("~/") or (WIN32 and value.startswith("~\\"))):
        return value
    rest = value[2:]
    expanded = os.path.normpath(f"{Path.home()}{os.sep}{rest}")
    # Node's path.join keeps one trailing separator; normpath drops it.
    if rest.endswith(("/", "\\") if WIN32 else "/") and not expanded.endswith(os.sep):
        expanded += os.sep
    return expanded


def same_path(a: str, b: str) -> bool:
    """Compare resolved paths, ignoring case on Windows; symlinks are not followed."""
    left, right = _resolved(a), _resolved(b)
    return left.lower() == right.lower() if WIN32 else left == right


def is_abs(path: str) -> bool:
    """On Windows an absolute path needs a drive or UNC prefix; ``\\x`` and ``C:x`` have neither."""
    if not WIN32:
        return os.path.isabs(path)
    # Spelled out because ntpath.splitdrive reads a bare \\host differently across versions.
    normalized = path.replace("/", "\\")
    if normalized.startswith("\\\\"):
        host, _, share = normalized[2:].partition("\\")
        return bool(host) and bool(share.split("\\")[0])
    return normalized[:1] in string.ascii_letters and normalized[1:3] == ":\\"
