"""The command string for a Claude Code command hook.

Claude Code runs hook commands through Git Bash, or PowerShell when Git is
absent, and a backslash path does not survive those, so Windows gets forward
slashes. POSIX gets the launchers' long-standing string. ``scripts/platform/hooks.js``
builds the same one.
"""

from __future__ import annotations

import os
import sys
from typing import Union

_WIN32 = sys.platform == "win32"


def _quoted(part: Union[str, "os.PathLike[str]"]) -> str:
    text = os.fspath(part)
    if _WIN32:
        text = text.replace("\\", "/")
    # POSIX-shell quoting, so only Git Bash runs a Windows path holding a quote.
    return "'" + text.replace("'", "'\\''") + "'"


def hook_command(script: Union[str, "os.PathLike[str]"], *args: Union[str, "os.PathLike[str]"]) -> str:
    return " ".join(["node", _quoted(script), *(_quoted(arg) for arg in args)])
