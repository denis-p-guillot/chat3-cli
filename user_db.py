"""SQLite persistence for users and named workspaces (local chat3 server)."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from chat3 import BASE_DIR

DB_PATH = BASE_DIR / "data" / "chat3.db"


@dataclass
class UserRow:
    id: int
    username: str
    password_hash: str
    display_name: str
    openai_api_key_encrypted: str | None
    active_workspace_id: int | None


@dataclass
class WorkspaceRow:
    id: int
    user_id: int
    name: str
    created_at: str


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id)")
    cur = conn.execute("PRAGMA table_info(users)")
    cols = {r[1] for r in cur.fetchall()}
    if "active_workspace_id" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN active_workspace_id INTEGER")


def init_db() -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                openai_api_key_encrypted TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        _migrate_schema(conn)
        conn.commit()
    finally:
        conn.close()


def _user_row_from_row(row: sqlite3.Row) -> UserRow:
    return UserRow(
        id=row["id"],
        username=row["username"],
        password_hash=row["password_hash"],
        display_name=row["display_name"] or "",
        openai_api_key_encrypted=row["openai_api_key_encrypted"],
        active_workspace_id=row["active_workspace_id"],
    )


def create_user(username: str, password_hash: str, display_name: str) -> int:
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)",
            (username.strip().lower(), password_hash, display_name.strip() or username),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


def get_user_by_username(username: str) -> UserRow | None:
    conn = _connect()
    try:
        cur = conn.execute(
            """
            SELECT id, username, password_hash, display_name, openai_api_key_encrypted, active_workspace_id
            FROM users WHERE username = ?
            """,
            (username.strip().lower(),),
        )
        row = cur.fetchone()
        if not row:
            return None
        return _user_row_from_row(row)
    finally:
        conn.close()


def get_user_by_id(user_id: int) -> UserRow | None:
    conn = _connect()
    try:
        cur = conn.execute(
            """
            SELECT id, username, password_hash, display_name, openai_api_key_encrypted, active_workspace_id
            FROM users WHERE id = ?
            """,
            (user_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return _user_row_from_row(row)
    finally:
        conn.close()


def update_user_profile(user_id: int, display_name: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE users SET display_name = ? WHERE id = ?",
            (display_name.strip(), user_id),
        )
        conn.commit()
    finally:
        conn.close()


def update_user_api_key_encrypted(user_id: int, encrypted: str | None) -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE users SET openai_api_key_encrypted = ? WHERE id = ?",
            (encrypted, user_id),
        )
        conn.commit()
    finally:
        conn.close()


def user_exists(username: str) -> bool:
    return get_user_by_username(username) is not None


def list_workspaces(user_id: int) -> list[WorkspaceRow]:
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, user_id, name, created_at FROM workspaces WHERE user_id = ? ORDER BY id",
            (user_id,),
        )
        return [
            WorkspaceRow(
                id=r["id"],
                user_id=r["user_id"],
                name=r["name"] or "",
                created_at=r["created_at"] or "",
            )
            for r in cur.fetchall()
        ]
    finally:
        conn.close()


def get_workspace(workspace_id: int, user_id: int) -> WorkspaceRow | None:
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, user_id, name, created_at FROM workspaces WHERE id = ? AND user_id = ?",
            (workspace_id, user_id),
        )
        row = cur.fetchone()
        if not row:
            return None
        return WorkspaceRow(
            id=row["id"],
            user_id=row["user_id"],
            name=row["name"] or "",
            created_at=row["created_at"] or "",
        )
    finally:
        conn.close()


def create_workspace(user_id: int, name: str) -> int:
    clean = name.strip()[:128] or "Untitled"
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO workspaces (user_id, name) VALUES (?, ?)",
            (user_id, clean),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


def set_active_workspace(user_id: int, workspace_id: int) -> bool:
    if get_workspace(workspace_id, user_id) is None:
        return False
    conn = _connect()
    try:
        conn.execute(
            "UPDATE users SET active_workspace_id = ? WHERE id = ?",
            (workspace_id, user_id),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def ensure_user_workspaces_ready(user_id: int) -> int:
    """Ensure user has at least one workspace and a valid active_workspace_id. Returns active workspace id."""
    conn = _connect()
    try:
        rows = list(conn.execute("SELECT id FROM workspaces WHERE user_id = ? ORDER BY id", (user_id,)))
        if not rows:
            cur = conn.execute(
                "INSERT INTO workspaces (user_id, name) VALUES (?, ?)",
                (user_id, "Default"),
            )
            ws_id = int(cur.lastrowid)
            conn.execute("UPDATE users SET active_workspace_id = ? WHERE id = ?", (ws_id, user_id))
            conn.commit()
            from chat3 import migrate_legacy_user_data_to_named_workspace

            migrate_legacy_user_data_to_named_workspace(user_id, ws_id)
            return ws_id
        ws_ids = [int(r["id"]) for r in rows]
        u = conn.execute("SELECT active_workspace_id FROM users WHERE id = ?", (user_id,)).fetchone()
        active = u["active_workspace_id"] if u else None
        if active is None or int(active) not in ws_ids:
            conn.execute(
                "UPDATE users SET active_workspace_id = ? WHERE id = ?",
                (ws_ids[0], user_id),
            )
            conn.commit()
            return ws_ids[0]
        return int(active)
    finally:
        conn.close()
