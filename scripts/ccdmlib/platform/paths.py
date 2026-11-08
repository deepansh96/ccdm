"""Home and state-root paths; the same answers as scripts/platform/paths.js."""

from __future__ import annotations

import os
import re
import string
import sys
from pathlib import Path
from typing import Any, Callable

WIN32 = sys.platform == "win32"
# Characters NTFS refuses in a name. A ":" would write an alternate data stream.
_WIN32_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
# re.ASCII keeps the folding to ASCII letters: a dotless i is no "I".
_WIN32_DEVICE = re.compile(
    r"(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])",
    re.IGNORECASE | re.ASCII,
)
_POSIX_NAME_MAX_BYTES = 255


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


def _cut_keeping_extension(name: str, limit: int, size: Callable[[str], int]) -> str:
    """Cut ``name`` to ``limit``, as measured by ``size``, between code points."""
    if size(name) <= limit:
        return name
    dot = name.rfind(".")
    extension = name[dot:] if dot > 0 and size(name[dot:]) < limit else ""
    stem = name[:dot] if extension else name
    room = limit - size(extension)
    kept = []
    for char in stem:
        room -= size(char)
        if room < 0:
            break
        kept.append(char)
    return "".join(kept) + extension


def _utf8_bytes(value: str) -> int:
    # surrogatepass counts a lone surrogate as 3 bytes, as Node does.
    return len(value.encode("utf-8", "surrogatepass"))


def _safe_win32_name(name: str, max_chars: int) -> str:
    safe = _WIN32_FORBIDDEN.sub("", name).rstrip(". ")
    safe = _cut_keeping_extension(safe, max_chars, len).rstrip(". ")
    # Windows reads a device name up to the first dot, ignoring spaces before it.
    # This runs after the cut, which can leave a device name as the stem.
    stem, dot, rest = safe.partition(".")
    if _WIN32_DEVICE.fullmatch(stem.rstrip(" ")):
        safe = _cut_keeping_extension(f"file{dot}{rest}", max_chars, len)
    return safe or "file"


def _safe_posix_name(name: str) -> str:
    base = name.rstrip("/").rsplit("/", 1)[-1].replace("\0", "")
    if base in ("", ".", ".."):
        return "file"
    return _cut_keeping_extension(base, _POSIX_NAME_MAX_BYTES, _utf8_bytes)


def safe_name(name: Any, max_chars: int = 120) -> str:
    """One path component that can be written as a regular file; twin of ``safeFileName``.

    Windows removes what NTFS refuses or reads as something else and caps the
    name at ``max_chars`` code points. POSIX changes only a name that could not
    be written; ``max_chars`` does not apply there, the limit is 255 UTF-8 bytes.
    """
    value = name if isinstance(name, str) else ""
    return _safe_win32_name(value, max_chars) if WIN32 else _safe_posix_name(value)
