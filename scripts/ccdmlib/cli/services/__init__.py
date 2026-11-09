"""`ccdm install-service`, `uninstall-service` and `service-status`.

Windows runs each CCDM daemon as a per-user scheduled task under ``\\CCDM\\``,
through ``scripts/win/service-host.js``. This module is the flow every service
shares; a service adds one module here named after it (``router.py``,
``thread_supervisor.py``), one task template and one test file, and nothing in
this file changes. A service module defines:

    TEMPLATE = "router.task.xml.in"        # in scripts/win/
    def plan(context) -> Plan              # may raise ServiceError
    def before_uninstall(context) -> None  # optional, runs before the stop file

macOS and Linux keep their ``.sh`` installers, which ``install-service`` runs.

Task Scheduler's own answers are not used for what the daemon did: ``schtasks
/end`` kills only the root ``conhost`` and leaves the host running, and Last Run
Result is ``conhost``'s. A stop goes through the stop file, and what the host
wrote in ``state.json`` is the record of the daemon.
"""

from __future__ import annotations

import argparse
import csv
import importlib
import io
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Dict, FrozenSet, List, NamedTuple, Optional, Sequence
from xml.etree import ElementTree
from xml.sax.saxutils import escape

from ...platform import exe, private_fs, proc
from ...platform.atomic import replace_with_retry
from ...platform.paths import is_abs, state_root

WIN32 = sys.platform == "win32"
ROOT_DIR = Path(__file__).resolve().parents[4]
SCRIPTS_DIR = ROOT_DIR / "scripts"
WIN_DIR = SCRIPTS_DIR / "win"

# scripts/platform/services.js holds the same table; a test compares them.
SERVICE_TASKS: Dict[str, str] = {
    "router": "Router",
    "host": "Host",
    "thread-supervisor": "ThreadSupervisor",
    "reminders": "Reminders",
    "usage-poster": "UsagePoster",
    "root-at-logon": "RootAtLogon",
}
_POSIX_INSTALLERS = {
    "router": "install-router-service.sh",
    "thread-supervisor": "install-thread-supervisor.sh",
    "reminders": "install-conversation-reminder-service.sh",
    "usage-poster": "install-usage-stats-poster.sh",
}

_TASK_NS = "http://schemas.microsoft.com/windows/2004/02/mit/task"
_MINIMUM_NODE_MAJOR = 22
_DEFAULT_WAIT_SECONDS = 30.0
_POLL_SECONDS = 0.25
_SCHTASKS_TIMEOUT_SECONDS = 60
_RUNNING_STATUS = "running"
_LIVE_STATES = ("running", "backoff", "crashloop")
_PLACEHOLDER = re.compile(r"__[A-Z_]+__")


class ServiceError(Exception):
    """Stops the flow with this exit code; each line is printed to stderr."""

    def __init__(self, code: int, *lines: str) -> None:
        super().__init__(lines[0] if lines else "")
        self.code = code
        self.lines = lines


class Plan(NamedTuple):
    """What one service runs. The host's env is exactly ``env``, checked against ``allowed_env``."""

    node: str
    command: List[str]
    cwd: str
    env: Dict[str, str]
    allowed_env: FrozenSet[str]
    private_dirs: List[str]


class Context:
    """One service's names and paths."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.task = f"\\CCDM\\{SERVICE_TASKS[name]}"
        self.state_root = state_root()
        self.service_dir = self.state_root / "services"
        base = self.service_dir / name
        self.config = base.with_name(f"{name}.json")
        self.state_file = base.with_name(f"{name}.state.json")
        self.disabled = base.with_name(f"{name}.disabled")
        self.stop_file = base.with_name(f"{name}.stop")
        self.lock = base.with_name(f"{name}.lock")
        self.log = base.with_name(f"{name}.log")
        self.err = base.with_name(f"{name}.err")
        self.candidate = base.with_name(f"{name}.task.xml")


def _module_for(name: str) -> Optional[ModuleType]:
    try:
        return importlib.import_module(f"{__name__}.{name.replace('-', '_')}")
    except ModuleNotFoundError as error:
        if error.name != f"{__name__}.{name.replace('-', '_')}":
            raise
        return None


def _not_available(name: str) -> int:
    print(f'ccdm: service "{name}" is not available yet', file=sys.stderr)
    return 2


def _fail(*lines: str) -> None:
    for line in lines:
        print(line, file=sys.stderr)


def _flags() -> int:
    return subprocess.CREATE_NO_WINDOW if WIN32 else 0  # type: ignore[attr-defined]


# Installer checks a service's plan() calls.


def require_node() -> str:
    """An absolute node of at least the supported version; exit 1 otherwise."""
    wanted = f"node {_MINIMUM_NODE_MAJOR} or newer is required"
    configured = os.environ.get("CCDM_ROUTER_NODE")
    if configured:
        if not is_abs(configured):
            raise ServiceError(1, f"Error: {wanted}; set CCDM_ROUTER_NODE to its absolute path")
        node = configured
    else:
        try:
            node = exe.node()["command"]
        except exe.ToolNotFound as error:
            raise ServiceError(1, f"Error: {wanted}: {error}") from None
    try:
        probe = subprocess.run(
            [node, "-p", "process.versions.node"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=30, creationflags=_flags(), check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise ServiceError(1, f"Error: {wanted} at {node}; set CCDM_ROUTER_NODE to its absolute path") from None
    version = probe.stdout.decode("utf-8", "replace").strip()
    major = version.split(".")[0]
    if probe.returncode != 0 or not major.isdigit() or int(major) < _MINIMUM_NODE_MAJOR:
        raise ServiceError(1, f"Error: {wanted} at {node}; set CCDM_ROUTER_NODE to its absolute path")
    return node


def require_absolute(values: Dict[str, str]) -> None:
    """Exit 2 unless every named directory is an absolute path."""
    for variable, value in values.items():
        if not is_abs(value):
            raise ServiceError(2, f"Error: {variable} must be an absolute path")


def run_preflight(node: str, script: Path, env: Dict[str, str]) -> None:
    """Run ``<script> preflight`` read-only; exit 2 and print each blocker when it is not ready."""
    completed = subprocess.run(
        [node, str(script), "preflight"], env={**os.environ, **env}, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=_flags(), check=False,
    )
    if completed.returncode == 0:
        return
    text = completed.stdout.decode("utf-8", "replace")
    try:
        blockers = json.loads(text).get("blockers") or ["unknown failure"]
    except (ValueError, AttributeError):
        output = (text + completed.stderr.decode("utf-8", "replace")).strip()
        blockers = [f"the service could not run its preflight: {output}"]
    raise ServiceError(2, "Error: preflight failed; the existing task was left unchanged",
                       *(f"  - {blocker}" for blocker in blockers))


# Talking to Task Scheduler. Only ever the schtasks.exe on PATH: a test workspace's
# PATH holds its fixture and nothing else.


def _schtasks_exe() -> str:
    found = exe._on_path("schtasks")  # pylint: disable=protected-access
    if not found:
        raise ServiceError(1, "Error: schtasks.exe was not found on PATH")
    return found[0]


def _schtasks(*args: str, timeout: float = _SCHTASKS_TIMEOUT_SECONDS) -> "subprocess.CompletedProcess[bytes]":
    try:
        return subprocess.run(
            [_schtasks_exe(), *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout, creationflags=_flags(), check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceError(1, f"Error: schtasks {args[0]} failed: {error}") from None


def _decode(raw: bytes) -> str:
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("oem" if WIN32 else "latin-1", "replace")


def _task_exists(context: Context) -> bool:
    return _schtasks("/query", "/tn", context.task).returncode == 0


def _task_status(context: Context) -> Optional[str]:
    """The status column of the task, or None when it cannot be read."""
    result = _schtasks("/query", "/tn", context.task, "/fo", "csv", "/nh")
    if result.returncode != 0:
        return None
    rows = list(csv.reader(io.StringIO(_decode(result.stdout))))
    row = next((row for row in rows if row), None)
    return row[-1].strip() if row else None


# The host's own record: its lock while it runs, its state file for the daemon.


def _read_lock(context: Context) -> Optional[Sequence[str]]:
    try:
        return context.lock.read_text(encoding="utf-8").split()
    except OSError:
        return None


def _host_alive(context: Context) -> bool:
    holder = _read_lock(context)
    if not holder or not holder[0].isdigit():
        return False
    return proc.alive(int(holder[0]), holder[1] if len(holder) > 1 else None)


def _read_state(context: Context) -> Optional[Dict[str, object]]:
    try:
        return json.loads(context.state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _wait_seconds() -> float:
    try:
        return float(os.environ.get("CCDM_SERVICE_WAIT_SECONDS") or _DEFAULT_WAIT_SECONDS)
    except ValueError:
        return _DEFAULT_WAIT_SECONDS


def _stop_host(context: Context) -> bool:
    """Ask a running host to stop through its stop file and wait for it."""
    if not _host_alive(context):
        context.stop_file.unlink(missing_ok=True)
        return True
    context.stop_file.write_text(f"{datetime.now(timezone.utc).isoformat()}\n", encoding="utf-8")
    deadline = time.monotonic() + _wait_seconds()
    while time.monotonic() < deadline:
        if not _host_alive(context):
            context.stop_file.unlink(missing_ok=True)
            return True
        time.sleep(_POLL_SECONDS)
    return False


def _started_since(context: Context, since: float) -> bool:
    """A host started for this install wrote its state; the status column is localized."""
    state = _read_state(context)
    if not state or state.get("state") not in _LIVE_STATES or not _host_alive(context):
        return False
    try:
        return context.state_file.stat().st_mtime >= since
    except OSError:
        return False


def _wait_running(context: Context, since: float) -> bool:
    deadline = time.monotonic() + _wait_seconds()
    while time.monotonic() < deadline:
        status = _task_status(context)
        if status and status.lower() == _RUNNING_STATUS:
            return True
        if _started_since(context, since):
            return True
        time.sleep(_POLL_SECONDS)
    return False


# Rendering.


def _current_user() -> str:
    """``DOMAIN\\name`` of this process, as Task Scheduler names it."""
    import ctypes  # pylint: disable=import-outside-toplevel
    from ctypes import wintypes  # pylint: disable=import-outside-toplevel

    sid = ctypes.c_void_p()
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.ConvertStringSidToSidW.argtypes = (wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p))
    advapi32.LookupAccountSidW.argtypes = (
        wintypes.LPCWSTR, ctypes.c_void_p, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
        wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
    )
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not advapi32.ConvertStringSidToSidW(private_fs.current_user_sid(), ctypes.byref(sid)):
        raise ServiceError(1, "Error: cannot read the current user's account")
    try:
        name = ctypes.create_unicode_buffer(256)
        domain = ctypes.create_unicode_buffer(256)
        name_size, domain_size, kind = wintypes.DWORD(256), wintypes.DWORD(256), wintypes.DWORD()
        if not advapi32.LookupAccountSidW(None, sid, name, ctypes.byref(name_size),
                                          domain, ctypes.byref(domain_size), ctypes.byref(kind)):
            raise ServiceError(1, "Error: cannot read the current user's account")
    finally:
        kernel32.LocalFree(sid)
    return f"{domain.value}\\{name.value}"


def _render(context: Context, plan: Plan, template: str) -> str:
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or "C:\\Windows"
    values = {
        "__TASK_NAME__": context.task,
        "__USER_ID__": _current_user(),
        "__CONHOST__": os.path.join(root, "System32", "conhost.exe"),
        "__NODE__": plan.node,
        "__SERVICE_HOST__": str(WIN_DIR / "service-host.js"),
        "__CONFIG__": str(context.config),
        "__WORKING_DIR__": plan.cwd,
    }
    rendered = (WIN_DIR / template).read_text(encoding="utf-8")
    if set(_PLACEHOLDER.findall(rendered)) - set(values):
        raise ServiceError(1, "Error: rendered task is invalid: the template contains an unresolved placeholder")
    for marker, value in values.items():
        rendered = rendered.replace(marker, escape(value, {'"': "&quot;"}))
    return rendered


def _validate(context: Context, plan: Plan, rendered: str) -> None:
    def invalid(message: str) -> ServiceError:
        return ServiceError(1, f"Error: rendered task is invalid: {message}")

    if set(plan.env) != set(plan.allowed_env):
        raise invalid(f"env must contain exactly {', '.join(sorted(plan.allowed_env))}")
    if not all(is_abs(path) for path in (plan.node, plan.cwd, *plan.private_dirs, str(context.config))):
        raise invalid("every executable, state and log path must be absolute")
    try:
        document = ElementTree.fromstring(rendered)
    except ElementTree.ParseError as error:
        raise invalid(str(error)) from None
    ns = {"t": _TASK_NS}

    def text(path: str) -> Optional[str]:
        found = document.find(path, ns)
        return found.text if found is not None else None

    checks = {
        "the task name": text("t:RegistrationInfo/t:URI") == context.task,
        "a logon trigger naming the current user":
            bool(text("t:Triggers/t:LogonTrigger/t:UserId"))
            and text("t:Triggers/t:LogonTrigger/t:UserId") == text("t:Principals/t:Principal/t:UserId"),
        "a 5-minute watchdog trigger": text("t:Triggers/t:TimeTrigger/t:Repetition/t:Interval") == "PT5M",
        "an interactive token": text("t:Principals/t:Principal/t:LogonType") == "InteractiveToken",
        "no time limit": text("t:Settings/t:ExecutionTimeLimit") == "PT0S",
        "no stop on battery": text("t:Settings/t:StopIfGoingOnBatteries") == "false"
        and text("t:Settings/t:DisallowStartIfOnBatteries") == "false",
        "no second instance": text("t:Settings/t:MultipleInstancesPolicy") == "IgnoreNew",
        "a headless conhost": (text("t:Actions/t:Exec/t:Command") or "").lower().endswith("conhost.exe"),
    }
    arguments = text("t:Actions/t:Exec/t:Arguments") or ""
    checks["the service host"] = arguments.startswith(f'--headless "{plan.node}" ') and str(context.config) in arguments
    missing = [what for what, ok in checks.items() if not ok]
    if missing:
        raise invalid(f"it must have {', '.join(missing)}")


def _write_config(context: Context, plan: Plan) -> None:
    private_fs.write_private(context.config, json.dumps({
        "name": context.name,
        "command": plan.command,
        "cwd": plan.cwd,
        "env": plan.env,
        "service_dir": str(context.service_dir),
    }, indent=2) + "\n")


def _prepare_private(context: Context, plan: Plan) -> None:
    for directory in (*plan.private_dirs, str(context.service_dir)):
        private_fs.ensure_private_dir(directory)
    for log in (context.log, context.err):
        os.close(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))


def _write_candidate(context: Context, rendered: str) -> None:
    candidate = context.candidate.with_name(f".{context.candidate.name}.{os.getpid()}.tmp")
    candidate.write_text(rendered, encoding="utf-16", newline="\r\n")
    replace_with_retry(candidate, context.candidate)


def _restore(context: Context, prior_xml: Optional[str], prior_config: Optional[str], disabled_before: bool) -> bool:
    """Back to what was installed before: its config, task definition and running host."""
    restored = _stop_host(context)
    if prior_config is None:
        context.config.unlink(missing_ok=True)
    else:
        private_fs.write_private(context.config, prior_config)
    if prior_xml is None:
        restored = _schtasks("/delete", "/tn", context.task, "/f").returncode == 0 and restored
    else:
        _write_candidate(context, prior_xml)
        created = _schtasks("/create", "/tn", context.task, "/xml", str(context.candidate), "/f")
        restored = created.returncode == 0 and restored
        if restored and not disabled_before:
            context.disabled.unlink(missing_ok=True)
            restored = _schtasks("/run", "/tn", context.task).returncode == 0
    context.candidate.unlink(missing_ok=True)
    return restored


def _install_windows(name: str) -> int:
    module = _module_for(name)
    if module is None:
        return _not_available(name)
    context = Context(name)
    plan: Plan = module.plan(context)
    rendered = _render(context, plan, module.TEMPLATE)
    _validate(context, plan, rendered)

    _prepare_private(context, plan)
    prior = _schtasks("/query", "/tn", context.task, "/xml")
    prior_xml = _decode(prior.stdout) if prior.returncode == 0 else None
    prior_config = context.config.read_text(encoding="utf-8") if context.config.exists() else None
    disabled_before = context.disabled.exists()
    _write_config(context, plan)
    _write_candidate(context, rendered)

    def roll_back(reason: str) -> int:
        restored = _restore(context, prior_xml, prior_config, disabled_before)
        outcome = "restored the previous task" if restored else "failed to restore the previous task"
        _fail(f"Error: {reason}; {outcome}")
        return 1

    if not _stop_host(context):
        return roll_back(f"the running {name} host did not stop")
    created = _schtasks("/create", "/tn", context.task, "/xml", str(context.candidate), "/f")
    if created.returncode != 0:
        return roll_back(f"schtasks could not create the task: {_decode(created.stderr).strip()}")
    context.candidate.unlink(missing_ok=True)
    context.disabled.unlink(missing_ok=True)
    context.stop_file.unlink(missing_ok=True)
    started_at = time.time()
    started = _schtasks("/run", "/tn", context.task)
    if started.returncode != 0:
        return roll_back(f"schtasks could not start the task: {_decode(started.stderr).strip()}")
    if not _wait_running(context, started_at):
        return roll_back(f"task {context.task} did not reach running")
    print(f"Task {context.task} installed and running")
    print(f"State directory: {context.service_dir}")
    print(f"Standard output log: {context.log}")
    print(f"Standard error log: {context.err}")
    return 0


def _uninstall_windows(name: str) -> int:
    module = _module_for(name)
    if module is None:
        return _not_available(name)
    context = Context(name)
    before_uninstall = getattr(module, "before_uninstall", None)
    if callable(before_uninstall):
        before_uninstall(context)
    private_fs.ensure_private_dir(context.service_dir)
    context.stop_file.write_text(f"{datetime.now(timezone.utc).isoformat()}\n", encoding="utf-8")
    deadline = time.monotonic() + _wait_seconds()
    while _host_alive(context):
        if time.monotonic() >= deadline:
            _fail(f"Error: the {name} service host did not stop; task {context.task} was left in place")
            return 1
        time.sleep(_POLL_SECONDS)
    if _task_exists(context):
        deleted = _schtasks("/delete", "/tn", context.task, "/f")
        if deleted.returncode != 0:
            _fail(f"Error: schtasks could not delete {context.task}: {_decode(deleted.stderr).strip()}")
            return 1
    context.stop_file.unlink(missing_ok=True)
    context.config.unlink(missing_ok=True)
    print(f"Task {context.task} removed")
    return 0


def _describe(context: Context) -> str:
    if not _task_exists(context):
        return "not installed"
    state = _read_state(context)
    if state is None:
        return f"installed, not started (task {context.task})"
    recorded = state.get("state")
    if recorded != "disabled" and not _host_alive(context):
        return f"stopped (last state {recorded}, task {context.task})"
    details = [f"task {context.task}"]
    if state.get("last_exit_code") is not None:
        details.append(f"last exit {state['last_exit_code']}")
    next_start = state.get("next_start_at")
    if isinstance(next_start, str):
        try:
            when = datetime.fromisoformat(next_start.replace("Z", "+00:00"))
            details.insert(0, f"next start in {max(0, int((when - datetime.now(timezone.utc)).total_seconds()))}s")
        except ValueError:
            pass
    return f"{recorded} ({', '.join(details)})"


def _status_windows(name: Optional[str]) -> int:
    if name is not None and _module_for(name) is None:
        return _not_available(name)
    names = [name] if name is not None else [known for known in SERVICE_TASKS if _module_for(known) is not None]
    for known in names:
        print(f"{known}: {_describe(Context(known))}")
    return 0


def _posix_elsewhere(verb: str) -> int:
    print(f"ccdm: {verb} is Windows only; on macOS use launchctl with ~/Library/LaunchAgents/com.ccdm.<name>.plist",
          file=sys.stderr)
    return 2


def _known(name: str) -> bool:
    if name in SERVICE_TASKS:
        return True
    print(f'ccdm: unknown service "{name}"; known: {", ".join(sorted(SERVICE_TASKS))}', file=sys.stderr)
    return False


def _handle(run):
    """Run one subcommand, turning ServiceError into its exit code."""
    try:
        return run()
    except ServiceError as error:
        _fail(*error.lines)
        return error.code
    except OSError as error:
        _fail(f"Error: {error}")
        return 1


def install_service(args: argparse.Namespace) -> int:
    if not _known(args.name):
        return 2
    if WIN32:
        return _handle(lambda: _install_windows(args.name))
    installer = _POSIX_INSTALLERS.get(args.name)
    if installer is None:
        return _not_available(args.name)
    return subprocess.call([str(SCRIPTS_DIR / installer)])


def uninstall_service(args: argparse.Namespace) -> int:
    if not _known(args.name):
        return 2
    if not WIN32:
        return _posix_elsewhere("uninstall-service")
    return _handle(lambda: _uninstall_windows(args.name))


def service_status(args: argparse.Namespace) -> int:
    if args.name is not None and not _known(args.name):
        return 2
    if not WIN32:
        return _posix_elsewhere("service-status")
    return _handle(lambda: _status_windows(args.name))


def register(subparsers: "argparse._SubParsersAction[argparse.ArgumentParser]") -> None:
    install = subparsers.add_parser("install-service", help="install a CCDM background service and start it")
    install.add_argument("name", metavar="<name>")
    install.set_defaults(func=install_service)
    uninstall = subparsers.add_parser("uninstall-service", help="stop and remove a CCDM background service (Windows)")
    uninstall.add_argument("name", metavar="<name>")
    uninstall.set_defaults(func=uninstall_service)
    status = subparsers.add_parser("service-status", help="show the installed CCDM background services (Windows)")
    status.add_argument("name", metavar="<name>", nargs="?", default=None)
    status.set_defaults(func=service_status)
