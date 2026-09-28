"""Lite relayの配布前提診断と再開可能な安全更新トランザクション。"""

from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import constants
import file_lock_utils
import lite_cloud_setup
import lite_travel


EXPECTED_API_SCHEMA = 10
EXPECTED_D1_SCHEMA = 10
REQUEST_EXPIRY_CRON = "*/5 * * * *"
UPDATE_POSTFLIGHT_SUCCESS_STATES = frozenset({"ready", "maintenance_overdue"})
UPDATE_POSTFLIGHT_RETRYABLE_STATES = frozenset(
    {"worker_update_required", "unreachable", "unknown_schema"}
)
UPDATE_POSTFLIGHT_RETRY_DELAYS = (2.0, 3.0, 5.0, 8.0)
SENSITIVE_KEY = re.compile(
    r"(authorization|token|secret|password|api.?key|ciphertext|nonce|snapshot|payload|body|content|messages?|events?)",
    re.I,
)
ABSOLUTE_PATH = re.compile(r"(?:[A-Za-z]:[\\/]|/(?:home|Users|mnt|root)/)")


class LiteTravelOperationError(RuntimeError):
    pass


def relay_root() -> Path:
    return Path(__file__).resolve().parent / "cloud" / "lite-relay"


def runtime_diagnostics(*, run: Callable[..., Any] = subprocess.run) -> dict[str, Any]:
    return lite_cloud_setup.distribution_preflight(
        root=relay_root(),
        runner=run,
        check_network=False,
        require_wrangler=True,
    )


def _database_name_from_config(config_path: Path) -> str:
    """実運用設定から、単一の安全なD1名だけを返す。"""
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        bindings = config.get("d1_databases") if isinstance(config, dict) else None
        if not isinstance(bindings, list) or len(bindings) != 1:
            return ""
        name = str((bindings[0] or {}).get("database_name") or "").strip()
        return name if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{2,99}", name) else ""
    except (OSError, ValueError, TypeError, lite_travel.LiteTravelError):
        return ""


def _project_relative_config_path(config_path: Path) -> str:
    project_root = Path(lite_travel.__file__).resolve().parent
    try:
        return config_path.resolve().relative_to(project_root).as_posix()
    except ValueError:
        return config_path.as_posix()


def _config_matches_current_worker(config_path: Path, worker_url: str) -> bool:
    """生成済み設定が、現在保存されているworkers.dev接続先と一致するか確認する。"""
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        worker_name = str(config.get("name") or "").strip().lower()
        from urllib.parse import urlsplit

        hostname = str(urlsplit(str(worker_url or "")).hostname or "").lower()
    except (OSError, ValueError, TypeError, AttributeError):
        return False
    return bool(
        worker_name
        and _database_name_from_config(config_path)
        and hostname.startswith(f"{worker_name}.")
        and hostname.endswith(".workers.dev")
    )


def configured_wrangler_config_path() -> str:
    """保存先が旧既定名でも、残っている生成済み実運用設定を安全に見つけ直す。"""
    settings = lite_travel.get_settings() or {}
    configured = str(settings.get("wrangler_config_path") or "").strip()
    try:
        return _project_relative_config_path(
            lite_travel._resolve_wrangler_config(configured)[1]
        )
    except lite_travel.LiteTravelError:
        pass

    worker_url = str(settings.get("worker_url") or "").strip().rstrip("/")
    candidates: list[Path] = []
    try:
        operation = lite_cloud_setup.resume_latest_setup_operation() or {}
        operation_path = str(operation.get("config_path") or "").strip()
        if operation_path:
            candidates.append(Path(lite_travel._resolve_wrangler_config(operation_path)[1]))
    except (
        OSError,
        ValueError,
        TypeError,
        lite_cloud_setup.LiteCloudSetupError,
        lite_travel.LiteTravelError,
    ):
        pass
    candidates.extend(sorted(relay_root().glob("wrangler.setup.*.jsonc")))

    matches: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = candidate.resolve().as_posix().lower()
        if key in seen:
            continue
        seen.add(key)
        if _config_matches_current_worker(candidate, worker_url):
            matches.append(candidate)
    if len(matches) != 1:
        return ""
    return _project_relative_config_path(matches[0])


def configured_database_name() -> str:
    """保存済み、または安全に復元したWrangler設定から更新対象D1名を返す。"""
    try:
        config_path = configured_wrangler_config_path()
        if not config_path:
            return ""
        resolved = lite_travel._resolve_wrangler_config(config_path)[1]
        return _database_name_from_config(resolved)
    except lite_travel.LiteTravelError:
        return ""


def prerequisite_message(diagnostic: dict[str, Any]) -> str:
    """更新前提の不足を、同梱runtimeの利用者向け表現へ変換する。"""
    failures = set(diagnostic.get("failure_codes") or [])
    reasons: list[str] = []
    if "node_22_required" in failures:
        reasons.append("同梱されたLiteの準備ツールの版を確認できません")
    if "npm_missing" in failures:
        reasons.append("同梱されたLiteの準備ツールが不足しています")
    if "relay_resources_missing" in failures:
        reasons.append("配布relay資源が不足しています")
    if "wrangler_missing" in failures:
        reasons.append("同梱されたLiteの準備ツールが不足しています")
    if "wrangler_version_mismatch" in failures:
        reasons.append("同梱されたLiteの準備ツールの版が一致しません")
    return "、".join(reasons) or "更新前の準備状態を確認できません"


def compatibility_state(health: dict[str, Any], diagnostics: Optional[dict[str, Any]] = None) -> str:
    api_schema = health.get("api_schema_version")
    d1_schema = health.get("d1_schema_version")
    if not isinstance(api_schema, int) or not isinstance(d1_schema, int):
        return "unknown_schema"
    if api_schema > EXPECTED_API_SCHEMA or d1_schema > EXPECTED_D1_SCHEMA:
        return "client_update_required"
    if d1_schema < EXPECTED_D1_SCHEMA:
        return "migration_required"
    if api_schema < EXPECTED_API_SCHEMA:
        return "worker_update_required"
    if diagnostics:
        active = int((diagnostics.get("resources") or {}).get("active_sessions") or 0)
        returning = int((diagnostics.get("resources") or {}).get("returning_sessions") or 0)
        if active or returning:
            return "active_session_blocked"
        return str(diagnostics.get("state") or "unknown_schema")
    return "ready"


def diagnostic_export() -> dict[str, str]:
    payload = _redact({
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "local": runtime_diagnostics(),
        "remote": lite_travel.diagnose_worker(),
    })
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    remote_state = str((payload.get("remote") or {}).get("state") or "unknown")
    local_state = str((payload.get("local") or {}).get("state") or "unknown")
    markdown = (
        "# Lite Travel Phase 5 診断\n\n"
        f"- Local: `{local_state}`\n"
        f"- Remote: `{remote_state}`\n\n"
        "本文、snapshot、Token、Secret、Authorization、絶対パスは含めていません。\n"
    )
    return {"json": serialized, "markdown": markdown}


def _operation_dir() -> Path:
    return Path(constants.METADATA_DIR) / "lite_travel" / "operations"


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _redact(item) for key, item in value.items() if not SENSITIVE_KEY.search(str(key))}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return "[REDACTED]" if ABSOLUTE_PATH.search(value) else value[:1000]
    return value


def _save_operation(operation: dict[str, Any]) -> None:
    operation_id = str(operation["operation_id"])
    path = _operation_dir() / f"{operation_id}.json"
    if not file_lock_utils.safe_json_write(path.as_posix(), _redact(operation)):
        raise LiteTravelOperationError("更新操作状態を保存できませんでした。")


def plan_update(database_name: str) -> dict[str, Any]:
    name = str(database_name or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{2,99}", name):
        raise LiteTravelOperationError("D1 database名が不正です。")
    local = runtime_diagnostics()
    remote = lite_travel.diagnose_worker()
    if local["state"] != "ready":
        raise LiteTravelOperationError(prerequisite_message(local))
    if remote.get("state") in {"unreachable", "unauthorized", "unknown_schema", "client_update_required", "active_session_blocked"}:
        raise LiteTravelOperationError(f"更新を開始できない診断状態です: {remote.get('state')}")
    operation = {
        "operation_id": str(uuid.uuid4()),
        "status": "planned",
        "database_name": name,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "steps": ["preflight", "bookmark", "migration", "deploy", "postflight"],
        "completed_steps": [],
        "bookmark": None,
        "recovery": "失敗時は自動restoreせず、記録したTime Travel bookmarkから手動復旧する。",
    }
    _save_operation(operation)
    return operation


def _ensure_request_expiry_cron(config_path: Path) -> bool:
    """生成済みJSON設定の他項目を保持し、回収Cronだけを原子的に追加する。"""
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate_config_key")
            result[key] = value
        return result

    try:
        with file_lock_utils.get_file_lock(config_path.as_posix()):
            config = json.loads(
                config_path.read_text(encoding="utf-8"), object_pairs_hook=unique_object
            )
            if not isinstance(config, dict):
                raise ValueError("invalid_config")
            triggers = config.get("triggers", {})
            if not isinstance(triggers, dict):
                raise ValueError("invalid_triggers")
            crons = triggers.get("crons", [])
            if not isinstance(crons, list) or any(
                not isinstance(cron, str) or not cron.strip() for cron in crons
            ):
                raise ValueError("invalid_crons")
            if REQUEST_EXPIRY_CRON in crons:
                return False
            config["triggers"] = {**triggers, "crons": [*crons, REQUEST_EXPIRY_CRON]}
            file_lock_utils.safe_text_write(
                config_path.as_posix(), json.dumps(config, ensure_ascii=False, indent=2) + "\n"
            )
            return True
    except (OSError, ValueError, TypeError, file_lock_utils.Timeout):
        raise LiteTravelOperationError(
            "定期回収の設定を安全に更新できませんでした。"
            "生成済み設定のJSON形式と書き込み権限を確認してください。クラウド更新は開始していません。"
        ) from None


def _build_update_assets(
    config_path: Path, *, node: str | Path, runner: Callable[..., Any], root: Path
) -> None:
    """生成済み設定の配信先へ新版PWAを再生成し、deploy前に失敗を確定する。"""
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        relative = config["assets"]["directory"]
        if not isinstance(relative, str):
            raise ValueError("invalid_assets_directory")
        match = re.fullmatch(
            r"\.\./\.\./cache/lite_cloud_setup/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/public",
            relative,
        )
        if match is None:
            raise ValueError("unexpected_assets_directory")
        destination = lite_cloud_setup._operation_assets_root(root, match.group(1))
        if (config_path.parent / relative).resolve() != destination:
            raise ValueError("assets_directory_mismatch")
        script = root / "scripts" / "build-unified-lite.mjs"
        if not script.is_file():
            raise OSError("assets_builder_missing")
        result = runner(
            [str(node), str(script), "--output-root", str(destination)],
            cwd=root.as_posix(), capture_output=True, text=True, timeout=300, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("assets_build_failed")
    except (
        OSError, ValueError, KeyError, TypeError, RuntimeError,
        subprocess.SubprocessError, lite_cloud_setup.LiteCloudSetupError,
    ):
        raise LiteTravelOperationError(
            "新版PWAの配信資産を安全に準備できませんでした。クラウド更新は開始していません。"
        ) from None


def run_update(
    operation: dict[str, Any],
    *,
    confirmed: bool,
    runner: Callable[..., Any] = subprocess.run,
    postflight: Callable[[], dict[str, Any]] = lite_travel.diagnose_worker,
    node_command: str | Path | None = None,
    postflight_sleep: Callable[[float], None] = time.sleep,
    on_postflight_retry: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    if not confirmed:
        raise LiteTravelOperationError("外部変更の確認が必要です。")
    if operation.get("status") not in {"planned", "failed"}:
        raise LiteTravelOperationError("更新操作の状態が不正です。")
    if (
        operation.get("status") == "failed"
        and operation.get("failure_code") == "postflight_not_ready"
        and "deploy" in (operation.get("completed_steps") or [])
    ):
        return _finish_update_postflight_with_retry(
            operation,
            postflight,
            sleeper=postflight_sleep,
            on_retry=on_postflight_retry,
        )
    root = relay_root()
    try:
        node, wrangler, _wrangler_cli, _runtime = (
            lite_cloud_setup.resolve_lite_command_runtime(
                root, node_command=node_command, runner=runner
            )
        )
    except lite_cloud_setup.LiteCloudSetupError as exc:
        raise LiteTravelOperationError(
            "Lite専用runtimeを確認できません。準備ツールの修復を実行してください。"
        ) from exc
    recovered_config_path = configured_wrangler_config_path()
    if not recovered_config_path:
        raise LiteTravelOperationError("Lite用クラウドの接続設定を自動確認できませんでした。")
    config = lite_travel._resolve_wrangler_config(recovered_config_path)[1]
    _build_update_assets(config, node=node, runner=runner, root=root)
    _ensure_request_expiry_cron(config)
    database = str(operation["database_name"])
    steps = [
        ("bookmark", [node, str(wrangler), "d1", "time-travel", "info", database, "--json", "--config", config.as_posix()]),
        ("migration", [node, str(wrangler), "d1", "migrations", "apply", database, "--remote", "--config", config.as_posix()]),
        ("deploy", [node, str(wrangler), "deploy", "--config", config.as_posix()]),
    ]
    operation["status"] = "running"
    operation.setdefault("completed_steps", []).append("preflight")
    _save_operation(operation)
    for step, command in steps:
        try:
            result = runner(command, cwd=root.as_posix(), capture_output=True, text=True, timeout=300, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            operation.update(status="failed", failed_step=step, failure_code=f"{step}_execution_failed")
            _save_operation(operation)
            raise LiteTravelOperationError(f"{step}を実行できませんでした。") from exc
        if result.returncode != 0:
            operation.update(status="failed", failed_step=step, failure_code=f"{step}_failed")
            _save_operation(operation)
            raise LiteTravelOperationError(f"{step}に失敗しました。自動restoreは行いません。")
        if step == "bookmark":
            try:
                parsed = json.loads(result.stdout or "{}")
                operation["bookmark"] = str(parsed.get("bookmark") or parsed.get("timestamp") or "recorded")[:200]
            except (ValueError, AttributeError):
                operation["bookmark"] = "recorded"
        operation["completed_steps"].append(step)
        _save_operation(operation)
    return _finish_update_postflight_with_retry(
        operation,
        postflight,
        sleeper=postflight_sleep,
        on_retry=on_postflight_retry,
    )


def _finish_update_postflight_with_retry(
    operation: dict[str, Any],
    postflight: Callable[[], dict[str, Any]],
    *,
    sleeper: Callable[[float], None],
    on_retry: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    """Cloudflareの公開伝播を待ち、更新処理を繰り返さず事後診断だけ再試行する。"""
    total_attempts = len(UPDATE_POSTFLIGHT_RETRY_DELAYS) + 1
    diagnostics: dict[str, Any] = {}
    for attempt in range(1, total_attempts + 1):
        diagnostics = postflight()
        state = str(diagnostics.get("state") or "unknown")
        operation["postflight_attempts"] = attempt
        if state in UPDATE_POSTFLIGHT_SUCCESS_STATES:
            return _finish_update_postflight(operation, diagnostics)
        if state not in UPDATE_POSTFLIGHT_RETRYABLE_STATES or attempt >= total_attempts:
            return _finish_update_postflight(operation, diagnostics)

        delay = UPDATE_POSTFLIGHT_RETRY_DELAYS[attempt - 1]
        operation.update(
            status="failed",
            failed_step="postflight",
            failure_code="postflight_not_ready",
            postflight_state=state,
        )
        _save_operation(operation)
        if on_retry is not None:
            try:
                on_retry(
                    {
                        "attempt": attempt,
                        "total_attempts": total_attempts,
                        "state": state,
                        "delay_seconds": delay,
                    }
                )
            except Exception:
                # 表示側の進捗通知失敗で、更新の成立確認まで止めない。
                pass
        sleeper(delay)

    return _finish_update_postflight(operation, diagnostics)


def _finish_update_postflight(operation: dict[str, Any], diagnostics: dict[str, Any]) -> dict[str, Any]:
    """更新の成立条件と、利用を妨げない運用警告を分けて記録する。"""
    state = str(diagnostics.get("state") or "unknown")
    operation["postflight_state"] = state
    if state not in UPDATE_POSTFLIGHT_SUCCESS_STATES:
        operation.update(status="failed", failed_step="postflight", failure_code="postflight_not_ready")
        _save_operation(operation)
        attempts = max(1, int(operation.get("postflight_attempts") or 1))
        raise LiteTravelOperationError(
            f"Cloudflareへの反映を{attempts}回確認しましたが、"
            f"事後診断が完了条件を満たしていません（{state}）。"
            "更新操作記録を保ったまま、接続状態を再診断してください。"
        )
    operation.pop("failed_step", None)
    operation.pop("failure_code", None)
    if state == "maintenance_overdue":
        resources = (diagnostics.get("diagnostics") or {}).get("resources") or {}
        try:
            sessions = max(0, int(resources.get("overdue_sessions") or 0))
            standby = max(0, int(resources.get("overdue_standby") or 0))
        except (TypeError, ValueError):
            sessions = 0
            standby = 0
        operation["postflight_warning"] = (
            "更新は完了しました。削除期限を迎えたデータがあります"
            f"（帰宅後{sessions}件・お出かけ前{standby}件）。接続状態カードから確認してください。"
        )
    else:
        operation.pop("postflight_warning", None)
    if "postflight" not in operation.setdefault("completed_steps", []):
        operation["completed_steps"].append("postflight")
    operation.update(status="completed", completed_at=dt.datetime.now(dt.timezone.utc).isoformat())
    _save_operation(operation)
    return operation
