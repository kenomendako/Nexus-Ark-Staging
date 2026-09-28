"""Nexus Ark Windows update host.

`Start.bat` is deliberately kept as a small shim.  This module is copied to
``updater/current`` in a release and is executed with a Python interpreter
outside of the application ``.venv``.  Consequently it only imports the
Python standard library and the small ``update_host`` contract modules.

The host performs one lifecycle per invocation:

1. recover an interrupted journal;
2. create the current virtual environment on a fresh installation;
3. validate and prepare a staged release, then atomically switch generations;
4. run a localhost-only trial and commit only after its success marker; and
5. start the current application and return its exit code.

Command and process factories are injectable so that the state machine can be
tested on Linux without pretending to be Windows.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, MutableMapping, Sequence

from .contracts import validate_release_tree
from .runtime import validate_bound_runtime
from .transaction import (
    GenerationLayout,
    JournalStore,
    UpdatePhase,
    commit_transaction,
    prepare_transaction,
    recover_incomplete_transaction,
    rollback_transaction,
    switch_generations,
)
from .trial import validate_trial_marker


DEFAULT_TRIAL_PORT = 7860
DEFAULT_TRIAL_TIMEOUT_SECONDS = 300.0
DEFAULT_ROLLBACK_TIMEOUT_SECONDS = 15.0


class SupervisorError(RuntimeError):
    """更新hostが安全に処理を継続できない場合の例外。"""


class UnsafeGenerationError(SupervisorError):
    """current一式の整合性を確認できず、自動起動してはいけない状態。"""


CommandRunner = Callable[..., Any]
ProcessFactory = Callable[..., Any]


@dataclass(frozen=True)
class SupervisorPaths:
    """インストールroot以下のhostが扱う固定配置。"""

    root: Path

    @property
    def app(self) -> Path:
        return self.root / "app"

    @property
    def staging(self) -> Path:
        return self.root / "update_staging"

    @property
    def recovery(self) -> Path:
        return self.root / "update_recovery"

    @property
    def trial_marker(self) -> Path:
        return self.recovery / "trial-success.json"

    @property
    def python_env(self) -> Path:
        return self.root / ".venv"

    @property
    def pyproject(self) -> Path:
        return self.root / "pyproject.toml"

    @property
    def uv_lock(self) -> Path:
        return self.root / "uv.lock"


def _returncode(result: Any) -> int:
    """subprocess.CompletedProcess、整数、Noneの注入結果を統一する。"""

    if result is None:
        return 0
    if isinstance(result, int):
        return int(result)
    value = getattr(result, "returncode", None)
    if value is None:
        return 0
    return int(value)


def _call_with_optional_keywords(function: Callable[..., Any], args: Sequence[Any], **kwargs: Any) -> Any:
    """テスト用の簡素なfactory（位置引数だけ）も受け入れる。"""

    try:
        return function(*args, **kwargs)
    except TypeError as keyword_error:
        # A TypeError raised *inside* a real factory should not silently be
        # retried with a different signature.  Only retry when the message
        # clearly points at unexpected keyword arguments.
        message = str(keyword_error)
        if (
            "unexpected keyword" not in message
            and "positional argument" not in message
            and "required positional" not in message
        ):
            raise
        reduced = dict(kwargs)
        reduced.pop("check", None)
        if reduced != kwargs:
            try:
                return function(*args, **reduced)
            except TypeError as reduced_error:
                reduced_message = str(reduced_error)
                if (
                    "unexpected keyword" not in reduced_message
                    and "positional argument" not in reduced_message
                    and "required positional" not in reduced_message
                ):
                    raise
        if "cwd" in kwargs and "env" in kwargs:
            return function(*args, kwargs["cwd"], kwargs["env"])
        return function(*args)


class UpdateSupervisor:
    """更新準備・試験起動・通常起動を一つのhost lifecycleとして扱う。"""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        command_runner: CommandRunner | None = None,
        process_factory: ProcessFactory | None = None,
        environ: Mapping[str, str] | None = None,
        trial_timeout_seconds: float = DEFAULT_TRIAL_TIMEOUT_SECONDS,
        rollback_timeout_seconds: float = DEFAULT_ROLLBACK_TIMEOUT_SECONDS,
        poll_interval_seconds: float = 0.25,
        trial_port: int | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.paths = SupervisorPaths(Path(root).absolute())
        self.layout = GenerationLayout(self.paths.root)
        self.command_runner = command_runner or subprocess.run
        self.process_factory = process_factory or subprocess.Popen
        self.environ = dict(environ or os.environ)
        self.trial_timeout_seconds = float(trial_timeout_seconds)
        self.rollback_timeout_seconds = float(rollback_timeout_seconds)
        self.poll_interval_seconds = float(poll_interval_seconds)
        self.trial_port = trial_port
        self._sleep = sleeper
        self._monotonic = monotonic

    # ------------------------------------------------------------------
    # External process boundary
    # ------------------------------------------------------------------
    def _run_command(
        self,
        command: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
    ) -> int:
        try:
            result = _call_with_optional_keywords(
                self.command_runner,
                [list(map(str, command))],
                cwd=str(cwd),
                env=dict(env),
                check=False,
            )
        except OSError as exc:
            raise SupervisorError(f"外部コマンドを実行できません: {command[0]}") from exc
        return _returncode(result)

    def _spawn(
        self,
        command: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
    ) -> Any:
        try:
            return _call_with_optional_keywords(
                self.process_factory,
                [list(map(str, command))],
                cwd=str(cwd),
                env=dict(env),
            )
        except OSError as exc:
            raise SupervisorError(f"アプリケーションprocessを起動できません: {command[0]}") from exc

    # ------------------------------------------------------------------
    # Recovery and dependency preparation
    # ------------------------------------------------------------------
    def recover(self) -> dict[str, Any] | None:
        """通常起動・依存同期より先に中断transactionを解決する。"""

        try:
            journal = recover_incomplete_transaction(self.layout)
        except Exception as exc:
            raise UnsafeGenerationError(
                f"更新journalの復旧に失敗しました: {type(exc).__name__}"
            ) from exc
        if journal and journal.get("phase") == UpdatePhase.MANUAL_RECOVERY_REQUIRED.value:
            raise UnsafeGenerationError("更新journalが手動復旧を要求しています")
        return journal

    def _python_env_exists(self) -> bool:
        if not self.paths.python_env.is_dir():
            return False
        return any(
            candidate.exists()
            for candidate in (
                self.paths.python_env / "Scripts" / "python.exe",
                self.paths.python_env / "bin" / "python",
            )
        )

    def _sync_python_env(self, destination: Path) -> None:
        """uvをhost側から呼び、指定generationへ依存環境を作る。"""

        project = self.paths.app
        if not (project / "pyproject.toml").is_file() or not (project / "uv.lock").is_file():
            raise SupervisorError("依存同期に必要なapp/pyproject.tomlまたはapp/uv.lockがありません")
        env = dict(self.environ)
        env["UV_PROJECT_ENVIRONMENT"] = str(destination)
        code = self._run_command(
            ["uv", "sync", "--project", str(project), "--frozen", "--no-install-project"],
            cwd=self.paths.root,
            env=env,
        )
        if code != 0 or not destination.is_dir():
            raise SupervisorError(f"Python依存環境の同期に失敗しました (exit={code})")

    def _build_next_python_env(self, _layout: GenerationLayout, _manifest: Mapping[str, Any]) -> None:
        destination = self.paths.root / ".venv.next"
        self._sync_python_env_from_project(self.paths.root / "app.next", destination)

    def _sync_python_env_from_project(self, project: Path, destination: Path) -> None:
        if not (project / "pyproject.toml").is_file() or not (project / "uv.lock").is_file():
            raise SupervisorError("新版Python依存同期の入力が不足しています")
        env = dict(self.environ)
        env["UV_PROJECT_ENVIRONMENT"] = str(destination)
        code = self._run_command(
            ["uv", "sync", "--project", str(project), "--frozen", "--no-install-project"],
            cwd=self.paths.root,
            env=env,
        )
        if code != 0 or not destination.is_dir():
            raise SupervisorError(f"新版Python依存環境の同期に失敗しました (exit={code})")

    def ensure_current_python_env(self) -> None:
        """fresh installでだけcurrent .venvをhostから作る。"""

        if self._python_env_exists():
            return
        self._sync_python_env(self.paths.python_env)

    # ------------------------------------------------------------------
    # Staging and transaction lifecycle
    # ------------------------------------------------------------------
    def discover_staging_app(self) -> Path | None:
        staging = self.paths.staging
        if staging.is_symlink():
            raise SupervisorError("更新staging rootがsymlinkです")
        if not staging.is_dir():
            return None
        nested = staging / "app"
        if nested.is_symlink():
            raise SupervisorError("更新app stagingがsymlinkです")
        if nested.is_dir() and (nested / "release_manifest.json").is_file():
            return nested
        if (staging / "release_manifest.json").is_file():
            return staging
        # A directory with no manifest is intentionally ignored.  It may be
        # an incomplete download; never treat it as an atomic update.
        return None

    def discover_staging_runtime(self, staging_app: Path, manifest: Mapping[str, Any]) -> Path | None:
        """runtimeを含むbundleではappの署名済み兄弟directoryだけを返す。"""

        runtime_binding = manifest.get("components", {}).get("runtime", {})
        runtime_present = isinstance(runtime_binding, Mapping) and runtime_binding.get("present") is True
        candidate = self.paths.staging / "runtime"
        if not runtime_present:
            if candidate.exists() or candidate.is_symlink():
                raise SupervisorError("runtimeなしの更新bundleにruntime stagingがあります")
            return None
        if staging_app.parent != self.paths.staging or not candidate.is_dir():
            raise SupervisorError("更新bundleに署名対象のruntime stagingがありません")
        if candidate.is_symlink():
            raise SupervisorError("更新runtime stagingがsymlinkです")
        try:
            validate_bound_runtime(manifest, candidate)
        except Exception as exc:
            raise SupervisorError(f"runtime staging検証に失敗しました: {type(exc).__name__}") from exc
        return candidate

    def _cleanup_committed_staging(self) -> None:
        """commit済み兄弟stagingだけをbest-effortで除去する。"""

        for candidate in (
            self.paths.staging / "runtime",
            self.paths.staging / "app.download",
            self.paths.staging / "app",
        ):
            try:
                if candidate.is_symlink():
                    candidate.unlink()
                elif candidate.is_dir():
                    shutil.rmtree(candidate)
                elif candidate.exists():
                    candidate.unlink()
            except OSError as exc:
                print(
                    f"[Nexus Ark] commit済みstagingを削除できませんでした: {candidate.name} ({type(exc).__name__})",
                    file=sys.stderr,
                )
                # app manifestを最後まで残し、次回のCOMMITTED分岐から
                # 兄弟staging cleanupを安全に再試行できるようにする。
                return
        try:
            self.paths.staging.rmdir()
        except (FileNotFoundError, OSError):
            pass

    @staticmethod
    def _manifest_info(app_dir: Path) -> tuple[dict[str, Any], str]:
        try:
            exact = validate_release_tree(
                app_dir,
                expected_platform="windows",
                expected_cpu="x86_64",
            )
        except Exception as exc:
            raise SupervisorError(f"更新manifest検証に失敗しました: {type(exc).__name__}") from exc
        return exact["manifest"], str(exact["manifest_digest"])

    def _load_journal(self) -> dict[str, Any] | None:
        try:
            return JournalStore(self.layout.journal_path).load()
        except Exception as exc:
            raise SupervisorError(f"更新journalを読み込めません: {type(exc).__name__}") from exc

    def _mark_manual_recovery(self, journal: Mapping[str, Any], reason: str) -> None:
        data = dict(journal)
        data["phase"] = UpdatePhase.MANUAL_RECOVERY_REQUIRED.value
        # JournalStore blocks arbitrary paths/secrets.  Keep diagnostics to a
        # stable exception class rather than persisting user data or messages.
        data["failure"] = reason[:80]
        data["updated_at"] = int(time.time())
        JournalStore(self.layout.journal_path).write(data)

    def _resume_prepared(self, journal: dict[str, Any], app_dir: Path) -> Any:
        """電源断がpreparedで止まった場合はswitchから安全に再開する。"""

        if journal.get("phase") != UpdatePhase.PREPARED.value:
            raise SupervisorError("prepared transactionではありません")
        if not (self.paths.root / "app.next").is_dir():
            raise SupervisorError("prepared journalに対応するapp.nextがありません")
        try:
            exact = validate_release_tree(
                self.paths.root / "app.next",
                expected_platform="windows",
                expected_cpu="x86_64",
                allow_persistent_state=True,
            )
            if bool(journal.get("runtime_present")):
                validate_bound_runtime(exact["manifest"], self.paths.root / "runtime.next")
        except Exception as exc:
            raise SupervisorError(f"prepared世代の再検証に失敗しました: {type(exc).__name__}") from exc
        switched = switch_generations(self.layout, journal)
        return self._trial_and_commit(switched, app_dir=self.paths.app)

    def apply_staged_update(self) -> Any | None:
        """stagingが完全なmanifestを持つ場合だけ更新し、trial processを返す。"""

        staging_app = self.discover_staging_app()
        if staging_app is None:
            return None
        manifest, digest = self._manifest_info(staging_app)
        staging_runtime = self.discover_staging_runtime(staging_app, manifest)
        journal = self._load_journal()

        if journal:
            phase = UpdatePhase(str(journal["phase"]))
            old_digest = str(journal.get("manifest_digest") or "")
            if phase == UpdatePhase.COMMITTED and old_digest == digest:
                self._cleanup_committed_staging()
                return None
            if phase == UpdatePhase.ROLLED_BACK and old_digest == digest:
                # A failed package remains for diagnosis and must not be
                # retried on every ordinary launch.
                return None
            if phase == UpdatePhase.MANUAL_RECOVERY_REQUIRED:
                raise SupervisorError("更新journalが手動復旧を要求しています")
            if phase == UpdatePhase.PREPARED and old_digest == digest:
                return self._resume_prepared(journal, app_dir=self.paths.app)
            if phase in {UpdatePhase.PREPARING, UpdatePhase.SWITCHING, UpdatePhase.TRIAL_STARTING, UpdatePhase.ROLLING_BACK}:
                raise SupervisorError("前回の更新transactionが未解決です")

        try:
            prepared = prepare_transaction(
                self.layout,
                staging_app,
                staging_runtime=staging_runtime,
                python_env_builder=self._build_next_python_env,
            )
            switched = switch_generations(self.layout, prepared)
        except SupervisorError:
            raise
        except Exception as exc:
            # prepare/switch writes its own journal and switch rolls back on
            # rename faults.  Do not delete staging or next generations here.
            raise SupervisorError(f"更新世代の準備・切替に失敗しました: {type(exc).__name__}") from exc
        return self._trial_and_commit(switched, app_dir=self.paths.app)

    # ------------------------------------------------------------------
    # Trial process and ordinary launch
    # ------------------------------------------------------------------
    def _read_trial_port(self, app_dir: Path) -> int:
        if self.trial_port is not None:
            return int(self.trial_port)
        for key in ("NEXUS_ARK_PORT", "GRADIO_SERVER_PORT"):
            raw = self.environ.get(key)
            if raw:
                try:
                    port = int(raw)
                except ValueError:
                    continue
                if 1 <= port <= 65535:
                    return port
        config = app_dir / "config.json"
        try:
            payload = json.loads(config.read_text(encoding="utf-8"))
            port = int(payload.get("gradio_port", DEFAULT_TRIAL_PORT))
            if 1 <= port <= 65535:
                return port
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
        return DEFAULT_TRIAL_PORT

    def _python_executable(self) -> Path:
        candidates = (
            self.paths.python_env / "Scripts" / "python.exe",
            self.paths.python_env / "bin" / "python",
        )
        for candidate in candidates:
            if candidate.exists():
                return candidate
        raise SupervisorError("current Python環境の実行ファイルが見つかりません")

    def _remove_trial_marker(self) -> None:
        try:
            self.paths.trial_marker.unlink()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise SupervisorError("古いtrial markerを安全に交換できません") from exc

    def _terminate(self, process: Any) -> None:
        try:
            running = process.poll() is None
        except AttributeError:
            running = True
        if not running:
            return
        try:
            process.terminate()
        except (AttributeError, OSError):
            return
        try:
            process.wait(timeout=self.rollback_timeout_seconds)
            return
        except (AttributeError, OSError, subprocess.TimeoutExpired):
            pass
        try:
            process.kill()
        except (AttributeError, OSError):
            pass
        try:
            process.wait(timeout=self.rollback_timeout_seconds)
        except (AttributeError, OSError, subprocess.TimeoutExpired):
            pass

    def _trial_and_commit(self, journal: dict[str, Any], *, app_dir: Path) -> Any:
        marker = self.paths.trial_marker
        self._remove_trial_marker()
        operation_id = str(journal["operation_id"])
        digest = str(journal["manifest_digest"])
        target_version = str(journal["target_version"])
        # This token is intentionally process-local.  It is exchanged through
        # the trial environment and marker, but never persisted in the update
        # journal (which is designed to contain no process secrets).
        process_token = secrets.token_hex(32)
        port = self._read_trial_port(app_dir)
        environment: MutableMapping[str, str] = dict(self.environ)
        environment.update(
            {
                "NEXUS_ARK_UPDATE_TRIAL": "1",
                "NEXUS_ARK_UPDATE_OPERATION_ID": operation_id,
                "NEXUS_ARK_UPDATE_TARGET_VERSION": target_version,
                "NEXUS_ARK_UPDATE_MANIFEST_DIGEST": digest,
                "NEXUS_ARK_UPDATE_PROCESS_TOKEN": process_token,
                "NEXUS_ARK_UPDATE_TRIAL_MARKER": str(marker),
                "NEXUS_ARK_NO_BROWSER": "1",
                "NEXUS_ARK_ALLOW_PORT_FALLBACK": "0",
                # Trial must bind exactly one localhost port; this also
                # prevents a config-only custom port from making health checks
                # ambiguous.
                "NEXUS_ARK_PORT": str(port),
                "GRADIO_SERVER_PORT": str(port),
            }
        )
        executable = self._python_executable()
        process = self._spawn(
            [executable, app_dir / "nexus_ark.py"],
            cwd=app_dir,
            env=environment,
        )
        deadline = self._monotonic() + self.trial_timeout_seconds
        marker_error: Exception | None = None
        while self._monotonic() < deadline:
            try:
                returncode = process.poll()
            except AttributeError:
                returncode = None
            except OSError as exc:
                marker_error = SupervisorError("新版trialのprocess状態を確認できません")
                break
            if returncode is not None:
                marker_error = SupervisorError(f"新版trialがmarker前に終了しました (exit={returncode})")
                break
            # The process must still be alive at the instant a marker is
            # accepted.  We intentionally do not compare Popen.pid with the
            # marker PID: Windows venv launchers may be a shim process while
            # Python writes the marker from its own process.
            if marker.exists():
                try:
                    marker_returncode = process.poll()
                except AttributeError:
                    marker_returncode = None
                except OSError as exc:
                    marker_error = SupervisorError("新版trialのprocess状態を確認できません")
                    break
                if marker_returncode is not None:
                    marker_error = SupervisorError(
                        f"新版trialがmarker確認時に終了しました (exit={marker_returncode})"
                    )
                    break
                try:
                    validate_trial_marker(
                        marker,
                        operation_id=operation_id,
                        release_version=target_version,
                        manifest_digest=digest,
                        process_token=process_token,
                        port=port,
                    )
                except Exception as exc:
                    marker_error = exc
                    break
                commit_transaction(self.layout, journal)
                self._cleanup_committed_staging()
                return process
            self._sleep(self.poll_interval_seconds)

        if marker_error is None:
            marker_error = SupervisorError("新版trialのhealth markerがtimeoutしました")
        self._terminate(process)
        try:
            rollback_transaction(self.layout, journal)
        except Exception as rollback_error:
            raise UnsafeGenerationError(
                "新版trial失敗後のrollbackにも失敗しました"
            ) from rollback_error
        raise SupervisorError(f"新版trialを確定できませんでした: {type(marker_error).__name__}") from marker_error

    def launch_current(self) -> Any:
        executable = self._python_executable()
        environment = dict(self.environ)
        for key in (
            "NEXUS_ARK_UPDATE_TRIAL",
            "NEXUS_ARK_UPDATE_OPERATION_ID",
            "NEXUS_ARK_UPDATE_TARGET_VERSION",
            "NEXUS_ARK_UPDATE_MANIFEST_DIGEST",
            "NEXUS_ARK_UPDATE_PROCESS_TOKEN",
            "NEXUS_ARK_UPDATE_TRIAL_MARKER",
        ):
            environment.pop(key, None)
        return self._spawn(
            [executable, self.paths.app / "nexus_ark.py"],
            cwd=self.paths.app,
            env=environment,
        )

    def run(self) -> int:
        """host lifecycleを実行し、最終app processのexit codeを返す。"""

        try:
            self.recover()
            self.ensure_current_python_env()
            trial_process = self.apply_staged_update()
            process = trial_process or self.launch_current()
        except UnsafeGenerationError as exc:
            print(f"[Nexus Ark] 安全のため自動起動を停止しました: {exc}", file=sys.stderr)
            return 1
        except SupervisorError as exc:
            # Stagingやtrialに失敗しても、現在世代が存在するならそれを
            # 起動する。現行世代まで特定できない場合だけhostを停止する。
            print(f"[Nexus Ark] {exc}", file=sys.stderr)
            try:
                failed_journal = self._load_journal()
            except SupervisorError as journal_error:
                print(f"[Nexus Ark] 更新状態の再確認にも失敗しました: {journal_error}", file=sys.stderr)
                return 1
            if failed_journal and failed_journal.get("phase") == UpdatePhase.MANUAL_RECOVERY_REQUIRED.value:
                print("[Nexus Ark] 自動復旧を停止しました。最新完全ZIPからの再導入を案内してください。", file=sys.stderr)
                return 1
            if not self.paths.app.is_dir() or not self._python_env_exists():
                return 1
            try:
                process = self.launch_current()
            except SupervisorError as launch_error:
                print(f"[Nexus Ark] 現行版の起動準備にも失敗しました: {launch_error}", file=sys.stderr)
                return 1
        try:
            result = process.wait()
        except AttributeError:
            result = getattr(process, "returncode", 0)
        return _returncode(result)


def run_supervisor(root: str | os.PathLike[str], **kwargs: Any) -> int:
    """テストとStart.bat双方から使える薄い関数API。"""

    return UpdateSupervisor(root, **kwargs).run()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Nexus Ark Windows update host")
    parser.add_argument("--root", default=".", help="Nexus Ark installation root")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    return run_supervisor(args.root)


if __name__ == "__main__":  # pragma: no cover - exercised by launcher
    raise SystemExit(main())
