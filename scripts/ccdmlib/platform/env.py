"""The environment a CCDM session may inherit; the twin of scripts/platform/env.js."""

from __future__ import annotations

import os
import sys
from typing import Dict, Mapping, Optional

WIN32 = sys.platform == "win32"
_STRIPPED_PREFIXES = ("CLAUDE", "ANTHROPIC", "MCP_", "CCDM")


def _stripped(name: str) -> bool:
    return name.upper().startswith(_STRIPPED_PREFIXES)


def clean_env(
    extra: Optional[Mapping[str, str]] = None,
    base: Optional[Mapping[str, str]] = None,
) -> Dict[str, str]:
    """``base`` (default ``os.environ``) without the stripped names, with ``extra`` on top."""
    source = os.environ if base is None else base
    env = {name: value for name, value in source.items() if not _stripped(name)}
    for name, value in (extra or {}).items():
        if WIN32:
            for existing in [key for key in env if key.upper() == name.upper()]:
                del env[existing]
        env[name] = value
    return env
