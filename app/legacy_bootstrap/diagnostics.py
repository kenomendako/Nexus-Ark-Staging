"""初回更新失敗の非秘密診断。復旧receiptや署名検証には使用しない。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import uuid

STEPS = frozenset({
    'unknown', 'download', 'runtime', 'copy', 'environment', 'trial', 'switch',
    'write_swap_intent', 'park_old_root', 'write_old_parked', 'promote_new_root',
    'write_new_promoted', 'verify_promoted_root', 'write_committed',
})
EXCEPTIONS = frozenset({
    'OSError', 'PermissionError', 'FileNotFoundError', 'FileExistsError',
    'NotADirectoryError', 'IsADirectoryError', 'RuntimeError', 'ValueError',
    'TransactionError', 'UnknownTransactionError', 'UnsafePathError',
    'ManualRecoveryRequired', 'BootstrapError',
})
RECOVERY_STATES = frozenset({
    'unknown', 'preparing', 'prepared', 'swap_intent', 'old_parked',
    'new_promoted', 'committed', 'rolled_back', 'manual_recovery_required',
})


def failure_detail(exc: Exception, *, phase: str = 'unknown') -> dict:
    """例外本文・filename・tracebackは一切公開せず、causeを上限付きで確認する。"""
    step = getattr(exc, 'bootstrap_step', phase)
    state = getattr(exc, 'bootstrap_recovery_state', 'unknown')
    result = {
        'step': step if isinstance(step, str) and step in STEPS else 'unknown',
        'exception_type': 'unknown',
        'recovery_state': state if isinstance(state, str) and state in RECOVERY_STATES else 'unknown',
    }
    current = exc
    seen = set()
    for _ in range(8):
        if id(current) in seen:
            break
        seen.add(id(current))
        name = type(current).__name__
        result['exception_type'] = name if name in EXCEPTIONS else 'unknown'
        # 最初のOS例外のerrno/WinErrorを同じ原因から取り出す。
        if isinstance(current, OSError):
            for key, maximum in (('errno', 4095), ('winerror', 65535)):
                number = getattr(current, key, None)
                if type(number) is int and 0 <= number <= maximum:
                    result[key] = number
            break
        current = current.__cause__
        if current is None:
            break
    return result


def save_failure_detail(root: Path, detail: dict) -> bool:
    """所有を確認できる既存workspaceのdownload内だけへbest-effortで保存する。

    失敗時も元の更新失敗を隠さない。新規workspace作成、receipt変更、復旧判断はしない。
    """
    from .transaction import (
        _assert_safe_ancestors, _is_reparse_or_symlink, _read_known_receipt,
        workspace_path,
    )
    temporary = None
    try:
        workspace = workspace_path(root)
        _assert_safe_ancestors(workspace)
        receipt = _read_known_receipt(root, workspace)
        directory = workspace / 'download'
        _assert_safe_ancestors(directory)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or _is_reparse_or_symlink(directory, info):
            return False
        target = directory / 'bootstrap-failure.json'
        if os.path.lexists(target):
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or _is_reparse_or_symlink(target, info):
                return False
        # 呼び出し側から未検証の任意辞書を保存しない。
        payload = {'schema': 1, 'operation_id': receipt['operation_id']}
        for key, allowed in (('step', STEPS), ('exception_type', EXCEPTIONS | {'unknown'}),
                             ('recovery_state', RECOVERY_STATES)):
            value = detail.get(key)
            payload[key] = value if isinstance(value, str) and value in allowed else 'unknown'
        for key, maximum in (('errno', 4095), ('winerror', 65535)):
            number = detail.get(key)
            if type(number) is int and 0 <= number <= maximum:
                payload[key] = number
        candidate = directory / ('.bootstrap-failure.' + uuid.uuid4().hex + '.tmp')
        with candidate.open('x', encoding='utf-8') as stream:
            temporary = candidate
            json.dump(payload, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        temporary = None
        return True
    except Exception:
        return False
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass
