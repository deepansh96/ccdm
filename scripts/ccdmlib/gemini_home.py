"""The home a Gemini (agy) session runs under, for the Python launchers.

``scripts/resolve-gemini-home.py`` decides it: a thread's ``--account``, then
the project's ``gemini_account``, each an alias in ``gemini_accounts``; with
neither, the user's own home. agy runs with that home as ``HOME`` (the bridge's
``CCDM_AGY_HOME``) and keeps its conversations in ``<home>/.gemini/antigravity-cli``.
On Windows the resolver allows only the user's own home.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, Optional

_RESOLVER = Path(__file__).resolve().parents[1] / "resolve-gemini-home.py"
DATA_DIR = os.path.join(".gemini", "antigravity-cli")


class GeminiHomeError(Exception):
    """The home did not resolve; the message is the reason to show."""


def _resolver() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ccdm_resolve_gemini_home", _RESOLVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def user_home() -> str:
    return _resolver().user_home()


def resolve(registry: Dict[str, Any], project: str, account: Optional[str] = None) -> str:
    """The absolute home agy runs under for a session of ``project``."""
    module = _resolver()
    try:
        return module.resolve_gemini_home(registry, project, account)
    except module.ResolverError as error:
        raise GeminiHomeError(str(error)) from None


def data_dir(home: str) -> str:
    """agy's data directory under ``home``."""
    return os.path.join(home, DATA_DIR)
