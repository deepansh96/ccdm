"""`ccdm transcribe <audio path>`: print the transcript whisper makes of one audio file."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Optional

from ..platform import exe
from ..platform.paths import state_root
from ..platform.private_fs import WIN32, ensure_private_dir

_MODEL = "turbo"
_LANGUAGE = "en"
_TMP_PREFIX = "whisper-"
_TMP_RETENTION_S = 7 * 24 * 60 * 60
_USAGE_ERROR = 2
_WHISPER_NOT_FOUND = 3
_NOT_FOUND_TEXT = (
    "ccdm: whisper not found. Install openai-whisper, "
    "or set CODEX_BRIDGE_AUDIO_TRANSCRIPTION_COMMAND to the whisper program."
)


def _sweep_old_tmp_dirs(root: Path) -> None:
    """Remove what a killed run left behind; nothing else cleans <stateRoot>/tmp."""
    cutoff = time.time() - _TMP_RETENTION_S
    with os.scandir(root) as entries:
        for entry in entries:
            try:
                old = (entry.name.startswith(_TMP_PREFIX) and entry.is_dir(follow_symlinks=False)
                       and entry.stat(follow_symlinks=False).st_mtime < cutoff)
            except OSError:
                continue
            if old:
                shutil.rmtree(entry.path, ignore_errors=True)


def _private_tmp_dir() -> str:
    """A fresh private directory; the twin of privateTmpDir in scripts/platform/privacy.js.

    Windows' temp directory is shared with what the user runs, so there it lives
    under <stateRoot>/tmp.
    """
    if not WIN32:
        return tempfile.mkdtemp(prefix=_TMP_PREFIX)
    root = state_root() / "tmp"
    ensure_private_dir(root)
    _sweep_old_tmp_dirs(root)
    directory = tempfile.mkdtemp(prefix=_TMP_PREFIX, dir=str(root))
    ensure_private_dir(directory)
    return directory


def _whisper_command() -> Optional[List[str]]:
    try:
        whisper = exe.whisper()
    except exe.ToolNotFound:
        return None
    return [whisper["command"], *whisper["args"]]


def _read_transcript(output_dir: str, audio: str) -> Optional[str]:
    # whisper names the file after the audio file, without its last extension.
    expected = Path(output_dir) / f"{Path(audio).stem}.txt"
    written = [expected] if expected.is_file() else sorted(Path(output_dir).glob("*.txt"))
    if len(written) != 1:
        return None
    return written[0].read_text(encoding="utf-8").strip()


def _transcribe(args: argparse.Namespace) -> int:
    audio = os.path.abspath(args.audio)
    if not os.path.isfile(audio):
        print(f"ccdm: no audio file at {audio}", file=sys.stderr)
        return _USAGE_ERROR
    whisper = _whisper_command()
    if whisper is None:
        print(_NOT_FOUND_TEXT, file=sys.stderr)
        return _WHISPER_NOT_FOUND
    output_dir = _private_tmp_dir()
    try:
        command = [
            *whisper, audio,
            "--model", _MODEL,
            "--language", _LANGUAGE,
            "--output_format", "txt",
            "--output_dir", output_dir,
        ]
        try:
            # whisper prints its own progress; only the transcript goes to our stdout.
            completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, check=False)
        except FileNotFoundError:
            print(_NOT_FOUND_TEXT, file=sys.stderr)
            return _WHISPER_NOT_FOUND
        except OSError as error:
            print(f"ccdm: whisper could not be started: {error}", file=sys.stderr)
            return 1
        if completed.returncode != 0:
            print(f"ccdm: whisper exited with code {completed.returncode}", file=sys.stderr)
            return 1
        transcript = _read_transcript(output_dir, audio)
        if transcript is None:
            print("ccdm: whisper wrote no transcript", file=sys.stderr)
            return 1
        print(transcript)
        return 0
    finally:
        shutil.rmtree(output_dir, ignore_errors=True)


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "transcribe",
        help="Print the transcript of an audio file, made with whisper.",
        description="Print the transcript of an audio file, made with whisper. "
        f"Exits {_WHISPER_NOT_FOUND} when whisper is not installed.",
    )
    parser.add_argument("audio", metavar="<audio path>", help="The audio file, for example a downloaded voice message.")
    parser.set_defaults(func=_transcribe)
