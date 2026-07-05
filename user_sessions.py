"""Persist each user's chat sessions across all workspaces (projects)."""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from chat3 import WORKSPACE_DIR, ensure_named_workspace_layout


def user_sessions_root(user_id: int) -> Path:
    """User-level folder for all chat sessions: workspace/users/<id>/sessions/."""
    return (WORKSPACE_DIR / "users" / str(int(user_id)) / "sessions").resolve()


def ensure_user_sessions_layout(user_id: int) -> Path:
    root = user_sessions_root(user_id)
    (root / "projects").mkdir(parents=True, exist_ok=True)
    (root / "archive").mkdir(parents=True, exist_ok=True)
    return root


def _sessions_index_path(user_id: int) -> Path:
    return ensure_user_sessions_layout(user_id) / "index.json"


def _project_current_path(user_id: int, workspace_id: int) -> Path:
    return ensure_user_sessions_layout(user_id) / "projects" / f"w{int(workspace_id)}" / "current.json"


def _chat_messages_path(user_id: int, workspace_id: int) -> Path:
    return ensure_named_workspace_layout(user_id, workspace_id) / "chat_messages.json"


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _archive_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _load_index(user_id: int) -> dict[str, Any]:
    data = _load_json(_sessions_index_path(user_id))
    if not data:
        return {"user_id": int(user_id), "updated_at": _utc_now_iso(), "projects": [], "archives": []}
    data.setdefault("user_id", int(user_id))
    data.setdefault("projects", [])
    data.setdefault("archives", [])
    if not isinstance(data["projects"], list):
        data["projects"] = []
    if not isinstance(data["archives"], list):
        data["archives"] = []
    return data


def _save_index(user_id: int, index: dict[str, Any]) -> None:
    index["user_id"] = int(user_id)
    index["updated_at"] = _utc_now_iso()
    _write_json(_sessions_index_path(user_id), index)


def _upsert_project_index(
    index: dict[str, Any],
    *,
    workspace_id: int,
    workspace_name: str,
    message_count: int,
    updated_at: str,
) -> None:
    rel = f"projects/w{int(workspace_id)}/current.json"
    entry = {
        "workspace_id": int(workspace_id),
        "workspace_name": workspace_name,
        "current_path": rel,
        "message_count": int(message_count),
        "updated_at": updated_at,
    }
    projects: list[dict[str, Any]] = index["projects"]
    for i, row in enumerate(projects):
        if isinstance(row, dict) and row.get("workspace_id") == workspace_id:
            projects[i] = entry
            break
    else:
        projects.append(entry)
    projects.sort(key=lambda r: (str(r.get("workspace_name", "")).lower(), int(r.get("workspace_id", 0))))


def _append_archive_index(
    index: dict[str, Any],
    *,
    workspace_id: int,
    workspace_name: str,
    archive_rel: str,
    message_count: int,
    archived_at: str,
) -> None:
    index["archives"].append(
        {
            "path": archive_rel,
            "workspace_id": int(workspace_id),
            "workspace_name": workspace_name,
            "archived_at": archived_at,
            "message_count": int(message_count),
        }
    )


def _maybe_archive_current_session(
    user_id: int,
    workspace_id: int,
    workspace_name: str,
    *,
    next_messages: list[Any],
    index: dict[str, Any],
) -> None:
    if next_messages:
        return
    current_path = _project_current_path(user_id, workspace_id)
    existing = _load_json(current_path)
    if not existing:
        return
    old_messages = existing.get("messages")
    if not isinstance(old_messages, list) or not old_messages:
        return

    archived_at = _utc_now_iso()
    archive_name = f"{_archive_stamp()}_w{int(workspace_id)}.json"
    archive_rel = f"archive/{archive_name}"
    archive_path = ensure_user_sessions_layout(user_id) / archive_rel
    archive_payload = {
        **existing,
        "archived_at": archived_at,
        "workspace_id": int(workspace_id),
        "workspace_name": workspace_name,
    }
    _write_json(archive_path, archive_payload)
    _append_archive_index(
        index,
        workspace_id=workspace_id,
        workspace_name=workspace_name,
        archive_rel=archive_rel,
        message_count=len(old_messages),
        archived_at=archived_at,
    )


def record_user_session(
    user_id: int,
    workspace_id: int,
    workspace_name: str,
    messages: list[Any],
) -> None:
    """Mirror workspace chat history into the user's sessions folder."""
    ensure_user_sessions_layout(user_id)
    index = _load_index(user_id)
    _maybe_archive_current_session(
        user_id,
        workspace_id,
        workspace_name,
        next_messages=messages,
        index=index,
    )

    updated_at = _utc_now_iso()
    payload = {
        "user_id": int(user_id),
        "workspace_id": int(workspace_id),
        "workspace_name": workspace_name,
        "updated_at": updated_at,
        "message_count": len(messages),
        "messages": messages,
    }
    _write_json(_project_current_path(user_id, workspace_id), payload)
    _upsert_project_index(
        index,
        workspace_id=workspace_id,
        workspace_name=workspace_name,
        message_count=len(messages),
        updated_at=updated_at,
    )
    _save_index(user_id, index)


def sync_user_sessions_from_workspaces(user_id: int) -> None:
    """Backfill sessions from existing per-workspace chat_messages.json files."""
    from user_db import list_workspaces

    ensure_user_sessions_layout(user_id)
    index = _load_index(user_id)
    changed = False

    for ws in list_workspaces(user_id):
        chat_path = _chat_messages_path(user_id, ws.id)
        if not chat_path.is_file():
            continue
        chat_data = _load_json(chat_path)
        if not chat_data:
            continue
        messages = chat_data.get("messages")
        if not isinstance(messages, list):
            continue

        current_path = _project_current_path(user_id, ws.id)
        current_data = _load_json(current_path)
        current_messages = current_data.get("messages") if current_data else None
        if isinstance(current_messages, list) and current_messages == messages:
            continue

        updated_at = _utc_now_iso()
        payload = {
            "user_id": int(user_id),
            "workspace_id": int(ws.id),
            "workspace_name": ws.name,
            "updated_at": updated_at,
            "message_count": len(messages),
            "messages": messages,
        }
        _write_json(current_path, payload)
        _upsert_project_index(
            index,
            workspace_id=ws.id,
            workspace_name=ws.name,
            message_count=len(messages),
            updated_at=updated_at,
        )
        changed = True

    if changed:
        _save_index(user_id, index)


def remove_workspace_session(user_id: int, workspace_id: int) -> None:
    """Drop a project's current session mirror when its workspace is deleted."""
    root = user_sessions_root(user_id)
    project_dir = root / "projects" / f"w{int(workspace_id)}"
    if project_dir.exists():
        shutil.rmtree(project_dir, ignore_errors=True)

    index_path = root / "index.json"
    if not index_path.is_file():
        return
    index = _load_index(user_id)
    index["projects"] = [
        row
        for row in index["projects"]
        if not (isinstance(row, dict) and row.get("workspace_id") == workspace_id)
    ]
    _save_index(user_id, index)


def ensure_user_sessions_ready(user_id: int) -> None:
    """Create the user sessions folder and backfill once from existing workspace chats."""
    ensure_user_sessions_layout(user_id)
    if not _sessions_index_path(user_id).exists():
        sync_user_sessions_from_workspaces(user_id)
