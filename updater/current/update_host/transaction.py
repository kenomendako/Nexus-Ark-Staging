"""Windows原子更新の世代準備・切替・rollback。

OS固有launcherから独立して合成テストできるよう、filesystem操作とfault注入点を明示する。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, MutableMapping

from .contracts import (
    classify_release_path,
    is_generated_release_state,
    validate_release_tree,
)
from .runtime import validate_bound_runtime


JOURNAL_SCHEMA_VERSION = 1
DEFAULT_RESERVE_BYTES = 256 * 1024 * 1024
_SAFE_IDENTIFIER = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$")


class UpdatePhase(StrEnum):
    PREPARING = "preparing"
    PREPARED = "prepared"
    SWITCHING = "switching"
    TRIAL_STARTING = "trial_starting"
    COMMITTED = "committed"
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"
    MANUAL_RECOVERY_REQUIRED = "manual_recovery_required"


@dataclass(frozen=True)
class ComponentSlot:
    name: str
    current: Path
    next: Path
    previous: Path
    required: bool = True


@dataclass(frozen=True)
class GenerationLayout:
    root: Path

    @property
    def recovery_dir(self) -> Path:
        return self.root / "update_recovery"

    @property
    def journal_path(self) -> Path:
        return self.recovery_dir / "transaction.json"

    @property
    def lock_path(self) -> Path:
        return self.recovery_dir / "transaction.lock"

    @property
    def failed_dir(self) -> Path:
        return self.recovery_dir / "failed"

    def components(
        self,
        *,
        runtime_present: bool,
        initial_presence: Mapping[str, bool] | None = None,
    ) -> tuple[ComponentSlot, ...]:
        """Return the generation slots participating in this transaction.

        ``runtime_present`` describes the *target* release.  A runtime may be
        absent on an existing installation during its first introduction, so
        that slot is optional only when the journal's initial presence says it
        was absent.  The default remains ``required=True`` for callers that do
        not provide a baseline, preserving the Package 0 contract.
        """

        components = [
            ComponentSlot("app", self.root / "app", self.root / "app.next", self.root / "app.previous"),
            ComponentSlot(
                "python_env",
                self.root / ".venv",
                self.root / ".venv.next",
                self.root / ".venv.previous",
            ),
        ]
        if runtime_present:
            runtime_required = True
            if initial_presence is not None and "runtime" in initial_presence:
                runtime_required = initial_presence["runtime"] is True
            components.append(
                ComponentSlot(
                    "runtime",
                    self.root / "runtime",
                    self.root / "runtime.next",
                    self.root / "runtime.previous",
                    required=runtime_required,
                )
            )
        components.extend(
            [
                ComponentSlot(
                    "root_pyproject",
                    self.root / "pyproject.toml",
                    self.root / "pyproject.toml.next",
                    self.root / "pyproject.toml.previous",
                ),
                ComponentSlot(
                    "root_uv_lock",
                    self.root / "uv.lock",
                    self.root / "uv.lock.next",
                    self.root / "uv.lock.previous",
                ),
            ]
        )
        return tuple(components)


def _validate_identifier(value: str, label: str) -> str:
    normalized = str(value).strip()
    if not _SAFE_IDENTIFIER.fullmatch(normalized):
        raise ValueError(f"invalid {label}")
    return normalized


def _contains_forbidden_journal_value(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            str(key).lower() in {"secret", "token", "api_key", "password", "content", "body"}
            or _contains_forbidden_journal_value(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_forbidden_journal_value(item) for item in value)
    if isinstance(value, str):
        return Path(value).is_absolute() or bool(re.match(r"^[A-Za-z]:[\\/]", value))
    return False


_JOURNAL_COMPONENTS = (
    "app",
    "python_env",
    "runtime",
    "root_pyproject",
    "root_uv_lock",
)


def _validate_presence_baseline(data: Mapping[str, Any]) -> None:
    """Validate optional initial-generation metadata in a journal.

    The metadata deliberately contains only booleans and short state labels;
    no filesystem path, user data, or runtime contents are persisted.
    Older Package 0 journals do not have these fields, so omission remains
    valid for backwards-compatible recovery.
    """

    initial = data.get("initial_presence")
    if initial is not None:
        if not isinstance(initial, Mapping):
            raise ValueError("journal initial_presence must be an object")
        for component, present in initial.items():
            if str(component) not in _JOURNAL_COMPONENTS:
                raise ValueError("journal initial_presence contains an unknown component")
            if not isinstance(present, bool):
                raise ValueError("journal initial_presence values must be booleans")

    baseline = data.get("baseline")
    if baseline is not None:
        if not isinstance(baseline, Mapping):
            raise ValueError("journal baseline must be an object")
        for component, state in baseline.items():
            if str(component) not in _JOURNAL_COMPONENTS:
                raise ValueError("journal baseline contains an unknown component")
            if not isinstance(state, Mapping) or not isinstance(state.get("present"), bool):
                raise ValueError("journal baseline entries must contain a boolean present value")
            generation = state.get("generation")
            if generation is not None:
                if not isinstance(generation, str) or generation not in {"current", "absent"}:
                    raise ValueError("journal baseline generation is invalid")

    if isinstance(initial, Mapping) and isinstance(baseline, Mapping):
        for component in set(initial) & set(baseline):
            if initial[component] != baseline[component].get("present"):
                raise ValueError("journal initial presence and baseline disagree")


def _journal_initial_presence(journal: Mapping[str, Any], component: str) -> bool:
    """Read the recorded initial presence with an old-journal fallback."""

    initial = journal.get("initial_presence")
    if isinstance(initial, Mapping) and component in initial:
        return initial[component] is True
    baseline = journal.get("baseline")
    if isinstance(baseline, Mapping):
        state = baseline.get(component)
        if isinstance(state, Mapping) and "present" in state:
            return state["present"] is True
    # Package 0 had no runtime slot.  For a legacy target that does have one,
    # the old implementation required an existing runtime/current directory.
    return True


def _capture_initial_presence(layout: GenerationLayout) -> dict[str, bool]:
    """Capture only fixed component existence, never contents or paths."""

    paths = {
        "app": layout.root / "app",
        "python_env": layout.root / ".venv",
        "runtime": layout.root / "runtime",
        "root_pyproject": layout.root / "pyproject.toml",
        "root_uv_lock": layout.root / "uv.lock",
    }
    return {component: path.exists() for component, path in paths.items()}


def _capture_baseline(presence: Mapping[str, bool]) -> dict[str, dict[str, Any]]:
    """Create a serializable, secret-free initial generation baseline."""

    return {
        component: {
            "present": present is True,
            "generation": "current" if present is True else "absent",
        }
        for component, present in presence.items()
    }


def _ensure_initial_baseline(layout: GenerationLayout, journal: MutableMapping[str, Any]) -> None:
    """Populate or verify the initial component presence for a transaction."""

    actual = _capture_initial_presence(layout)
    recorded = journal.get("initial_presence")
    if recorded in (None, {}):
        journal["initial_presence"] = actual
    elif not isinstance(recorded, Mapping):
        raise ValueError("journal initial_presence must be an object")
    else:
        for component, present in actual.items():
            if component in recorded and recorded[component] is not present:
                raise RuntimeError(f"initial component presence changed: {component}")
        # A partial baseline from a caller is completed without overwriting
        # the already recorded values.
        journal["initial_presence"] = {
            component: recorded.get(component, present)
            for component, present in actual.items()
        }

    recorded_baseline = journal.get("baseline")
    if recorded_baseline in (None, {}):
        journal["baseline"] = _capture_baseline(journal["initial_presence"])
    elif not isinstance(recorded_baseline, Mapping):
        raise ValueError("journal baseline must be an object")
    else:
        for component, state in recorded_baseline.items():
            if component in journal["initial_presence"] and isinstance(state, Mapping):
                if state.get("present") is not journal["initial_presence"][component]:
                    raise RuntimeError(f"journal baseline changed: {component}")
        journal["baseline"] = {
            component: dict(recorded_baseline.get(component, state))
            for component, state in _capture_baseline(journal["initial_presence"]).items()
        }


class JournalStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.validate(data)
        return data

    def validate(self, data: Mapping[str, Any]) -> None:
        if data.get("schema_version") != JOURNAL_SCHEMA_VERSION:
            raise ValueError("unsupported update journal schema")
        UpdatePhase(str(data.get("phase")))
        _validate_identifier(str(data.get("operation_id") or ""), "operation_id")
        _validate_identifier(str(data.get("target_version") or ""), "target_version")
        digest = str(data.get("manifest_digest") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("invalid manifest digest")
        _validate_presence_baseline(data)
        if _contains_forbidden_journal_value(data):
            raise ValueError("journal contains a forbidden key or absolute path")

    def write(self, data: Mapping[str, Any]) -> None:
        self.validate(data)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_name(self.path.name + ".tmp")
        with temp.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, self.path)


class UpdateLock:
    def __init__(self, path: Path, operation_id: str):
        self.path = path
        self.operation_id = operation_id
        self._fd: int | None = None

    def __enter__(self) -> "UpdateLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"operation_id": self.operation_id, "pid": os.getpid()},
            ensure_ascii=True,
            sort_keys=True,
        ).encode("ascii")
        for attempt in range(2):
            try:
                self._fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except FileExistsError as exc:
                if attempt or not self._remove_stale_lock():
                    raise RuntimeError("another update transaction is active") from exc
        if self._fd is None:
            raise RuntimeError("failed to acquire update transaction lock")
        os.write(self._fd, payload)
        os.fsync(self._fd)
        return self

    def _remove_stale_lock(self) -> bool:
        """所有processが消えたlockだけを回収する。壊れたlockは手動確認へ残す。"""
        try:
            data = json.loads(self.path.read_text(encoding="ascii"))
            owner_pid = int(data["pid"])
            _validate_identifier(str(data["operation_id"]), "lock operation_id")
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return False
        if owner_pid <= 0 or _pid_is_alive(owner_pid):
            return False
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        return True

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def _pid_is_alive(pid: int) -> bool:
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        # Windowsでは存在確認が未対応のruntimeもあるため、安全側へ倒す。
        return True
    return True


def new_journal(*, target_version: str, manifest_digest: str) -> dict[str, Any]:
    return {
        "schema_version": JOURNAL_SCHEMA_VERSION,
        "operation_id": uuid.uuid4().hex,
        "target_version": _validate_identifier(target_version, "target_version"),
        "manifest_digest": manifest_digest,
        "phase": UpdatePhase.PREPARING.value,
        "runtime_present": False,
        # Populated by prepare_transaction once the installation root is
        # known.  Empty values keep direct callers/backwards-compatible
        # journal construction valid while making the contract explicit.
        "initial_presence": {},
        "baseline": {},
        "steps": [],
        "persistent_copy": {"files": 0, "bytes": 0},
        "failed_components": {},
        "failure": None,
        "updated_at": int(time.time()),
    }


def _tree_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        for dirname in list(dirs):
            candidate = root_path / dirname
            if candidate.is_symlink():
                raise ValueError(f"update tree must not contain symlink directories: {candidate}")
        for filename in files:
            candidate = root_path / filename
            if candidate.is_symlink():
                raise ValueError(f"update tree must not contain symlink files: {candidate}")
            total += candidate.stat().st_size
    return total


def _copy_persistent_state(current_app: Path, next_app: Path) -> dict[str, int]:
    copied_files = 0
    copied_bytes = 0
    if not current_app.is_dir():
        return {"files": 0, "bytes": 0}
    for root, dirs, files in os.walk(current_app, followlinks=False):
        root_path = Path(root)
        relative_root = root_path.relative_to(current_app)
        for dirname in list(dirs):
            candidate = root_path / dirname
            if candidate.is_symlink():
                raise ValueError(f"persistent state contains a symlink directory: {candidate}")
        for filename in files:
            source = root_path / filename
            if source.is_symlink():
                raise ValueError(f"persistent state contains a symlink file: {source}")
            relative = (relative_root / filename).as_posix()
            if is_generated_release_state(relative):
                continue
            if classify_release_path(relative) == "owned":
                continue
            destination = next_app / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            copied_files += 1
            copied_bytes += source.stat().st_size
    return {"files": copied_files, "bytes": copied_bytes}


def _default_python_env_builder(layout: GenerationLayout, manifest: Mapping[str, Any]) -> None:
    environment = os.environ.copy()
    environment["UV_PROJECT_ENVIRONMENT"] = str(layout.root / ".venv.next")
    subprocess.run(
        [
            "uv",
            "sync",
            "--project",
            str(layout.root / "app.next"),
            "--frozen",
            "--no-install-project",
        ],
        check=True,
        env=environment,
    )


def prepare_transaction(
    layout: GenerationLayout,
    staging_app: Path,
    *,
    staging_runtime: Path | None = None,
    python_env_builder: Callable[[GenerationLayout, Mapping[str, Any]], None] = _default_python_env_builder,
    available_bytes: int | None = None,
    reserve_bytes: int = DEFAULT_RESERVE_BYTES,
    journal: dict[str, Any] | None = None,
) -> dict[str, Any]:
    exact = validate_release_tree(
        staging_app,
        expected_platform="windows",
        expected_cpu="x86_64",
    )
    manifest = exact["manifest"]
    runtime_present = bool(manifest.get("components", {}).get("runtime", {}).get("present"))
    if runtime_present and staging_runtime is not None:
        validate_bound_runtime(manifest, staging_runtime)
    elif not runtime_present and staging_runtime is not None:
        raise RuntimeError("runtime staging is forbidden when the release manifest has no runtime")
    if journal is None:
        journal = new_journal(
            target_version=str(manifest["release_version"]),
            manifest_digest=exact["manifest_digest"],
        )
    journal["runtime_present"] = runtime_present
    _ensure_initial_baseline(layout, journal)
    store = JournalStore(layout.journal_path)
    store.write(journal)

    required_bytes = (
        _tree_size(staging_app)
        + (_tree_size(staging_runtime) if staging_runtime is not None else 0)
        + _tree_size(layout.root / "app")
        + _tree_size(layout.root / ".venv")
        + (_tree_size(layout.root / "runtime") if runtime_present else 0)
        + reserve_bytes
    )
    free_bytes = available_bytes
    if free_bytes is None:
        free_bytes = shutil.disk_usage(layout.root).free
    if free_bytes < required_bytes:
        journal["failure"] = "insufficient_disk_space"
        journal["updated_at"] = int(time.time())
        store.write(journal)
        raise RuntimeError("insufficient disk space for atomic update")

    app_next = layout.root / "app.next"
    if app_next.exists():
        raise RuntimeError("app.next already exists; recovery is required")
    shutil.copytree(staging_app, app_next, symlinks=False)
    journal["persistent_copy"] = _copy_persistent_state(layout.root / "app", app_next)
    validate_release_tree(
        app_next,
        expected_platform="windows",
        expected_cpu="x86_64",
        allow_persistent_state=True,
    )
    shutil.copy2(app_next / "pyproject.toml", layout.root / "pyproject.toml.next")
    shutil.copy2(app_next / "uv.lock", layout.root / "uv.lock.next")
    python_env_builder(layout, manifest)
    if not (layout.root / ".venv.next").is_dir():
        raise RuntimeError("python_env builder did not create .venv.next")
    runtime_next = layout.root / "runtime.next"
    if runtime_present:
        if staging_runtime is not None:
            if runtime_next.exists():
                raise RuntimeError("runtime.next already exists; recovery is required")
            shutil.copytree(staging_runtime, runtime_next, symlinks=False)
        if not runtime_next.is_dir():
            raise RuntimeError("runtime.next is required by the release manifest")
        validate_bound_runtime(manifest, runtime_next)
    elif runtime_next.exists():
        raise RuntimeError("runtime staging is forbidden when the release manifest has no runtime")
    journal["phase"] = UpdatePhase.PREPARED.value
    journal["failure"] = None
    journal["updated_at"] = int(time.time())
    store.write(journal)
    return journal


def _quarantine_existing_previous(
    layout: GenerationLayout,
    component: ComponentSlot,
    operation_id: str,
    rename: Callable[[Path, Path], None],
) -> str | None:
    if not component.previous.exists():
        return None
    layout.failed_dir.mkdir(parents=True, exist_ok=True)
    destination = layout.failed_dir / f"{component.name}.previous.{operation_id}"
    if destination.exists():
        raise RuntimeError(f"quarantine destination already exists: {component.name}")
    rename(component.previous, destination)
    return destination.relative_to(layout.root).as_posix()


def _quarantine_trial_current(
    layout: GenerationLayout,
    component: ComponentSlot,
    operation_id: str,
    rename: Callable[[Path, Path], None],
) -> str:
    """Move a promoted trial generation to a relative failed-artifact path."""

    layout.failed_dir.mkdir(parents=True, exist_ok=True)
    destination = layout.failed_dir / f"{component.name}.trial.{operation_id}"
    if destination.exists():
        raise RuntimeError(f"failed generation already exists: {component.name}")
    rename(component.current, destination)
    return destination.relative_to(layout.root).as_posix()


def rollback_transaction(
    layout: GenerationLayout,
    journal: dict[str, Any],
    *,
    rename: Callable[[Path, Path], None] = os.replace,
) -> dict[str, Any]:
    store = JournalStore(layout.journal_path)
    journal["phase"] = UpdatePhase.ROLLING_BACK.value
    journal["updated_at"] = int(time.time())
    store.write(journal)
    components = {
        item.name: item
        for item in layout.components(
            runtime_present=bool(journal.get("runtime_present")),
            initial_presence=journal.get("initial_presence"),
        )
    }
    try:
        active_step = journal.get("active_step")
        if isinstance(active_step, Mapping):
            component_name = str(active_step.get("component") or "")
            action = str(active_step.get("action") or "")
            component = components.get(component_name)
            if component is None:
                raise RuntimeError("journal active step references an unknown component")
            parked = journal.setdefault("parked_components", [])
            promoted = journal.setdefault("promoted_components", [])
            if action == "park":
                initially_absent = component_name == "runtime" and not _journal_initial_presence(
                    journal, component_name
                )
                if initially_absent and not component.current.exists() and not component.previous.exists():
                    # First runtime introduction has no old generation to
                    # park. This is an expected no-op during recovery.
                    pass
                elif not component.current.exists() and component.previous.exists():
                    if component_name not in parked:
                        parked.append(component_name)
                elif not component.current.exists() or component.previous.exists():
                    raise RuntimeError(f"ambiguous parked component state: {component_name}")
            elif action == "promote":
                initially_absent = component_name == "runtime" and not _journal_initial_presence(
                    journal, component_name
                )
                if (
                    initially_absent
                    and component.current.exists()
                    and not component.next.exists()
                    and not component.previous.exists()
                ):
                    # next -> current completed before its promoted append
                    # was flushed; quarantine it below during rollback.
                    if component_name not in promoted:
                        promoted.append(component_name)
                elif (
                    initially_absent
                    and not component.current.exists()
                    and component.next.exists()
                    and not component.previous.exists()
                ):
                    # The rename had not happened yet; leave next intact.
                    pass
                elif component.current.exists() and not component.next.exists() and component.previous.exists():
                    if component_name not in parked:
                        parked.append(component_name)
                    if component_name not in promoted:
                        promoted.append(component_name)
                elif not component.next.exists() or component.current.exists():
                    raise RuntimeError(f"ambiguous promoted component state: {component_name}")
            else:
                raise RuntimeError("journal active step action is invalid")
            journal["active_step"] = None
            store.write(journal)
        for component_name in reversed(journal.get("promoted_components", [])):
            component = components[component_name]
            if component.current.exists():
                failed_path = _quarantine_trial_current(
                    layout,
                    component,
                    journal["operation_id"],
                    rename,
                )
                journal.setdefault("failed_components", {})[component.name] = failed_path
                store.write(journal)
        for component_name in reversed(journal.get("parked_components", [])):
            component = components[component_name]
            if component_name == "runtime" and not _journal_initial_presence(journal, component_name):
                # Never resurrect a runtime that was absent at transaction
                # start. Preserve an unexpected previous artifact as failed
                # evidence rather than restoring it.
                if component.previous.exists():
                    failed_path = _quarantine_existing_previous(
                        layout,
                        component,
                        journal["operation_id"],
                        rename,
                    )
                    journal.setdefault("failed_components", {})[component.name] = failed_path
                    store.write(journal)
                continue
            if component.previous.exists():
                if component.current.exists():
                    raise RuntimeError(f"cannot restore over current component: {component.name}")
                rename(component.previous, component.current)
        runtime_component = components.get("runtime")
        if (
            runtime_component is not None
            and not _journal_initial_presence(journal, "runtime")
            and runtime_component.current.exists()
        ):
            # Covers a runtime appearing between prepare and switch (or an
            # otherwise incomplete journal). Keep the artifact for diagnosis,
            # but restore the transaction's original absent baseline.
            failed_path = _quarantine_trial_current(
                layout,
                runtime_component,
                journal["operation_id"],
                rename,
            )
            journal.setdefault("failed_components", {})["runtime"] = failed_path
            store.write(journal)
        if (
            runtime_component is not None
            and not _journal_initial_presence(journal, "runtime")
            and runtime_component.previous.exists()
        ):
            failed_path = _quarantine_existing_previous(
                layout,
                runtime_component,
                journal["operation_id"],
                rename,
            )
            journal.setdefault("failed_components", {})["runtime"] = failed_path
            store.write(journal)
        journal["phase"] = UpdatePhase.ROLLED_BACK.value
        journal["updated_at"] = int(time.time())
        store.write(journal)
        return journal
    except Exception as exc:
        journal["phase"] = UpdatePhase.MANUAL_RECOVERY_REQUIRED.value
        journal["failure"] = type(exc).__name__
        journal["updated_at"] = int(time.time())
        store.write(journal)
        raise


def switch_generations(
    layout: GenerationLayout,
    journal: dict[str, Any],
    *,
    rename: Callable[[Path, Path], None] = os.replace,
    fault: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if journal.get("phase") != UpdatePhase.PREPARED.value:
        raise ValueError("transaction must be prepared before switching")
    store = JournalStore(layout.journal_path)
    fault = fault or (lambda event: None)
    journal["phase"] = UpdatePhase.SWITCHING.value
    journal["parked_components"] = []
    journal["promoted_components"] = []
    journal["quarantined_previous"] = {}
    journal["active_step"] = None
    store.write(journal)
    components = layout.components(
        runtime_present=bool(journal.get("runtime_present")),
        initial_presence=journal.get("initial_presence"),
    )
    try:
        with UpdateLock(layout.lock_path, journal["operation_id"]):
            for component in components:
                if component.required and not component.current.exists():
                    raise RuntimeError(f"missing current component: {component.name}")
                if (
                    component.name == "runtime"
                    and not component.required
                    and component.current.exists()
                ):
                    # The journal says this is a first runtime introduction;
                    # an unexpected current generation is unsafe to replace.
                    raise RuntimeError("unexpected current component: runtime")
                if not component.next.exists():
                    raise RuntimeError(f"missing next component: {component.name}")
                fault(f"before:{component.name}:quarantine")
                quarantine = _quarantine_existing_previous(
                    layout,
                    component,
                    journal["operation_id"],
                    rename,
                )
                if quarantine:
                    journal["quarantined_previous"][component.name] = quarantine
                    store.write(journal)
                fault(f"before:{component.name}:park")
                journal["active_step"] = {"component": component.name, "action": "park"}
                store.write(journal)
                if component.current.exists():
                    rename(component.current, component.previous)
                    journal["parked_components"].append(component.name)
                elif component.name != "runtime" or component.required:
                    raise RuntimeError(f"missing current component: {component.name}")
                # An absent initial runtime has no park rename. Clearing the
                # active step is still journaled for power-loss recovery.
                journal["active_step"] = None
                store.write(journal)
                fault(f"after:{component.name}:park")
                journal["active_step"] = {"component": component.name, "action": "promote"}
                store.write(journal)
                rename(component.next, component.current)
                journal["promoted_components"].append(component.name)
                journal["active_step"] = None
                store.write(journal)
                fault(f"after:{component.name}:promote")
        journal["phase"] = UpdatePhase.TRIAL_STARTING.value
        journal["updated_at"] = int(time.time())
        store.write(journal)
        return journal
    except Exception as exc:
        journal["failure"] = type(exc).__name__
        store.write(journal)
        rollback_transaction(layout, journal, rename=rename)
        raise


def commit_transaction(layout: GenerationLayout, journal: dict[str, Any]) -> dict[str, Any]:
    if journal.get("phase") != UpdatePhase.TRIAL_STARTING.value:
        raise ValueError("trial must be active before commit")
    journal["phase"] = UpdatePhase.COMMITTED.value
    journal["failure"] = None
    journal["updated_at"] = int(time.time())
    JournalStore(layout.journal_path).write(journal)
    return journal


def recover_incomplete_transaction(
    layout: GenerationLayout,
    *,
    rename: Callable[[Path, Path], None] = os.replace,
) -> dict[str, Any] | None:
    journal = JournalStore(layout.journal_path).load()
    if journal is None:
        return None
    phase = UpdatePhase(journal["phase"])
    if phase in {UpdatePhase.SWITCHING, UpdatePhase.TRIAL_STARTING, UpdatePhase.ROLLING_BACK}:
        return rollback_transaction(layout, journal, rename=rename)
    return journal
