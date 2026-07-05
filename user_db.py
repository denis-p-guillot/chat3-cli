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
    llm_model: str | None
    odoo_url: str | None
    odoo_login: str | None
    odoo_password_encrypted: str | None


@dataclass
class WorkspaceRow:
    id: int
    user_id: int
    name: str
    created_at: str


@dataclass
class SshConnectionRow:
    id: int
    user_id: int
    home_workspace_id: int
    name: str
    host: str
    port: int
    username: str
    auth_mode: str
    private_key_encrypted: str | None
    password_encrypted: str | None
    created_at: str
    updated_at: str
    shared_workspace_ids: tuple[int, ...] = ()


_SSH_CONN_COLUMNS = """
    c.id, c.user_id, c.home_workspace_id, c.name, c.host, c.port, c.username, c.auth_mode,
    c.private_key_encrypted, c.password_encrypted, c.created_at, c.updated_at
"""


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
    if "llm_model" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN llm_model TEXT")
    if "odoo_url" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN odoo_url TEXT")
    if "odoo_login" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN odoo_login TEXT")
    if "odoo_password_encrypted" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN odoo_password_encrypted TEXT")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ssh_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            workspace_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            auth_mode TEXT NOT NULL DEFAULT 'private_key',
            private_key_encrypted TEXT,
            password_encrypted TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(user_id, workspace_id, name)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ssh_connections_user ON ssh_connections(user_id)")
    cur2 = conn.execute("PRAGMA table_info(ssh_connections)")
    ssh_cols = {r[1] for r in cur2.fetchall()}
    if "auth_mode" not in ssh_cols:
        conn.execute("ALTER TABLE ssh_connections ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'private_key'")
    if "password_encrypted" not in ssh_cols:
        conn.execute("ALTER TABLE ssh_connections ADD COLUMN password_encrypted TEXT")
    needs_workspace_migration = "workspace_id" not in ssh_cols
    if needs_workspace_migration:
        # Migrate legacy user-scoped SSH rows to workspace-scoped rows.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ssh_connections_v2 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                workspace_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT NOT NULL,
                auth_mode TEXT NOT NULL DEFAULT 'private_key',
                private_key_encrypted TEXT,
                password_encrypted TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(user_id, workspace_id, name)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ssh_connections_v2_user ON ssh_connections_v2(user_id)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ssh_connections_v2_user_workspace ON ssh_connections_v2(user_id, workspace_id)"
        )
        conn.execute(
            """
            INSERT INTO ssh_connections_v2 (
                id, user_id, workspace_id, name, host, port, username, auth_mode,
                private_key_encrypted, password_encrypted, created_at, updated_at
            )
            SELECT
                s.id,
                s.user_id,
                COALESCE(
                    (
                        SELECT u.active_workspace_id
                        FROM users u
                        WHERE u.id = s.user_id
                    ),
                    (
                        SELECT w.id
                        FROM workspaces w
                        WHERE w.user_id = s.user_id
                        ORDER BY w.id
                        LIMIT 1
                    ),
                    1
                ) AS workspace_id,
                s.name,
                s.host,
                s.port,
                s.username,
                COALESCE(NULLIF(trim(s.auth_mode), ''), 'private_key') AS auth_mode,
                s.private_key_encrypted,
                s.password_encrypted,
                s.created_at,
                s.updated_at
            FROM ssh_connections s
            """
        )
        conn.execute("DROP TABLE ssh_connections")
        conn.execute("ALTER TABLE ssh_connections_v2 RENAME TO ssh_connections")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ssh_connections_user ON ssh_connections(user_id)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ssh_connections_user_workspace ON ssh_connections(user_id, workspace_id)"
        )
    else:
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ssh_connections_user_workspace ON ssh_connections(user_id, workspace_id)"
        )
    if "private_key_encrypted" in ssh_cols:
        conn.execute(
            """
            UPDATE ssh_connections
            SET auth_mode = 'private_key'
            WHERE auth_mode IS NULL OR trim(auth_mode) = ''
            """
        )
    _migrate_ssh_connections_m2m(conn)


def _ssh_fingerprint(row: sqlite3.Row) -> tuple:
    return (
        int(row["user_id"]),
        (row["host"] or "").strip(),
        int(row["port"] or 22),
        (row["username"] or "").strip(),
        (row["auth_mode"] or "private_key").strip(),
        row["private_key_encrypted"],
        row["password_encrypted"],
    )


def _ssh_connections_columns(conn: sqlite3.Connection) -> set[str]:
    return {r[1] for r in conn.execute("PRAGMA table_info(ssh_connections)").fetchall()}


def _ensure_ssh_connection_workspaces_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ssh_connection_workspaces (
            connection_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            workspace_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (connection_id, workspace_id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ssh_connection_workspaces_user ON ssh_connection_workspaces(user_id, workspace_id)"
    )


def _backfill_ssh_connection_workspaces(conn: sqlite3.Connection) -> None:
    """Ensure each profile is linked to its home workspace (and keep existing shares)."""
    rows = conn.execute(
        "SELECT id, user_id, home_workspace_id FROM ssh_connections"
    ).fetchall()
    for row in rows:
        conn.execute(
            """
            INSERT OR IGNORE INTO ssh_connection_workspaces (connection_id, user_id, workspace_id)
            VALUES (?, ?, ?)
            """,
            (int(row["id"]), int(row["user_id"]), int(row["home_workspace_id"])),
        )


def _migrate_ssh_connections_m2m(conn: sqlite3.Connection) -> None:
    """Move SSH profiles to user-owned rows with many-to-many workspace links."""
    cols = _ssh_connections_columns(conn)
    if not cols:
        return
    if "home_workspace_id" in cols:
        _ensure_ssh_connection_workspaces_table(conn)
        _backfill_ssh_connection_workspaces(conn)
        return
    if "workspace_id" not in cols:
        return

    junction_exists = bool(
        conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='ssh_connection_workspaces'"
        ).fetchone()
    )

    conn.execute(
        """
        CREATE TABLE ssh_connections_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            home_workspace_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            auth_mode TEXT NOT NULL DEFAULT 'private_key',
            private_key_encrypted TEXT,
            password_encrypted TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(user_id, name)
        )
        """
    )

    if junction_exists:
        conn.execute(
            """
            INSERT INTO ssh_connections_new (
                id, user_id, home_workspace_id, name, host, port, username, auth_mode,
                private_key_encrypted, password_encrypted, created_at, updated_at
            )
            SELECT
                id, user_id, workspace_id, name, host, port, username, auth_mode,
                private_key_encrypted, password_encrypted, created_at, updated_at
            FROM ssh_connections
            ORDER BY id
            """
        )
        _ensure_ssh_connection_workspaces_table(conn)
        for old in conn.execute("SELECT id, user_id, workspace_id FROM ssh_connections").fetchall():
            conn.execute(
                """
                INSERT OR IGNORE INTO ssh_connection_workspaces (connection_id, user_id, workspace_id)
                VALUES (?, ?, ?)
                """,
                (int(old["id"]), int(old["user_id"]), int(old["workspace_id"])),
            )
    else:
        _ensure_ssh_connection_workspaces_table(conn)
        old_rows = conn.execute(
            """
            SELECT id, user_id, workspace_id, name, host, port, username, auth_mode,
                   private_key_encrypted, password_encrypted, created_at, updated_at
            FROM ssh_connections
            ORDER BY user_id, id
            """
        ).fetchall()

        fingerprint_to_id: dict[tuple, int] = {}
        names_taken: set[tuple[int, str]] = set()

        for old in old_rows:
            user_id = int(old["user_id"])
            ws_id = int(old["workspace_id"])
            name = (old["name"] or "").strip()[:128]
            fp = _ssh_fingerprint(old)
            conn_id = fingerprint_to_id.get(fp)
            if conn_id is None:
                name_key = (user_id, name.lower())
                if name_key in names_taken:
                    name = f"{name} (ws {ws_id})"[:128]
                    name_key = (user_id, name.lower())
                cur = conn.execute(
                    """
                    INSERT INTO ssh_connections_new (
                        user_id, home_workspace_id, name, host, port, username, auth_mode,
                        private_key_encrypted, password_encrypted, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        ws_id,
                        name,
                        (old["host"] or "").strip()[:255],
                        int(old["port"] or 22),
                        (old["username"] or "").strip()[:128],
                        (old["auth_mode"] or "private_key").strip(),
                        old["private_key_encrypted"],
                        old["password_encrypted"],
                        old["created_at"],
                        old["updated_at"],
                    ),
                )
                conn_id = int(cur.lastrowid)
                fingerprint_to_id[fp] = conn_id
                names_taken.add((user_id, name.lower()))
            conn.execute(
                """
                INSERT OR IGNORE INTO ssh_connection_workspaces (connection_id, user_id, workspace_id)
                VALUES (?, ?, ?)
                """,
                (conn_id, user_id, ws_id),
            )

    conn.execute("DROP TABLE ssh_connections")
    conn.execute("ALTER TABLE ssh_connections_new RENAME TO ssh_connections")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ssh_connections_user ON ssh_connections(user_id)")


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
        llm_model=row["llm_model"],
        odoo_url=row["odoo_url"],
        odoo_login=row["odoo_login"],
        odoo_password_encrypted=row["odoo_password_encrypted"],
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
            SELECT id, username, password_hash, display_name, openai_api_key_encrypted, active_workspace_id, llm_model,
                   odoo_url, odoo_login, odoo_password_encrypted
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
            SELECT id, username, password_hash, display_name, openai_api_key_encrypted, active_workspace_id, llm_model,
                   odoo_url, odoo_login, odoo_password_encrypted
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


def update_user_llm_model(user_id: int, llm_model: str | None) -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE users SET llm_model = ? WHERE id = ?",
            (llm_model.strip() if llm_model else None, user_id),
        )
        conn.commit()
    finally:
        conn.close()


def update_user_odoo(
    user_id: int,
    *,
    url: str | None,
    login: str | None,
    password_encrypted: str | None,
) -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            UPDATE users
            SET odoo_url = ?, odoo_login = ?, odoo_password_encrypted = ?
            WHERE id = ?
            """,
            (
                url.strip() if url else None,
                login.strip() if login else None,
                password_encrypted,
                user_id,
            ),
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


def delete_workspace(user_id: int, workspace_id: int) -> tuple[bool, int | None]:
    """Delete a workspace and return (deleted, resulting_active_workspace_id)."""
    conn = _connect()
    try:
        exists = conn.execute(
            "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
            (workspace_id, user_id),
        ).fetchone()
        if not exists:
            return False, None

        conn.execute(
            "DELETE FROM ssh_connection_workspaces WHERE user_id = ? AND workspace_id = ?",
            (workspace_id, user_id),
        )
        for row in conn.execute("SELECT id FROM ssh_connections WHERE user_id = ?", (user_id,)):
            _cleanup_orphan_ssh_connection(conn, int(row["id"]))

        conn.execute("DELETE FROM workspaces WHERE id = ? AND user_id = ?", (workspace_id, user_id))

        row = conn.execute("SELECT active_workspace_id FROM users WHERE id = ?", (user_id,)).fetchone()
        active = int(row["active_workspace_id"]) if row and row["active_workspace_id"] is not None else None

        ids = [int(r["id"]) for r in conn.execute("SELECT id FROM workspaces WHERE user_id = ? ORDER BY id", (user_id,))]
        if not ids:
            cur = conn.execute(
                "INSERT INTO workspaces (user_id, name) VALUES (?, ?)",
                (user_id, "Default"),
            )
            new_active = int(cur.lastrowid)
        elif active == workspace_id or active is None:
            new_active = ids[0]
        else:
            new_active = active

        conn.execute("UPDATE users SET active_workspace_id = ? WHERE id = ?", (new_active, user_id))
        conn.commit()
        return True, new_active
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


def _ssh_row_from_row(row: sqlite3.Row, shared_workspace_ids: tuple[int, ...] = ()) -> SshConnectionRow:
    home_ws = row["home_workspace_id"] if "home_workspace_id" in row.keys() else row["workspace_id"]
    return SshConnectionRow(
        id=row["id"],
        user_id=row["user_id"],
        home_workspace_id=int(home_ws),
        name=row["name"] or "",
        host=row["host"] or "",
        port=int(row["port"] or 22),
        username=row["username"] or "",
        auth_mode=row["auth_mode"] or "private_key",
        private_key_encrypted=row["private_key_encrypted"],
        password_encrypted=row["password_encrypted"],
        created_at=row["created_at"] or "",
        updated_at=row["updated_at"] or "",
        shared_workspace_ids=shared_workspace_ids,
    )


def _load_shared_workspace_ids(conn: sqlite3.Connection, connection_id: int) -> tuple[int, ...]:
    cur = conn.execute(
        """
        SELECT workspace_id
        FROM ssh_connection_workspaces
        WHERE connection_id = ?
        ORDER BY workspace_id
        """,
        (int(connection_id),),
    )
    return tuple(int(r["workspace_id"]) for r in cur.fetchall())


def _ensure_workspace_owned(conn: sqlite3.Connection, user_id: int, workspace_id: int) -> bool:
    row = conn.execute(
        "SELECT id FROM workspaces WHERE id = ? AND user_id = ?",
        (int(workspace_id), int(user_id)),
    ).fetchone()
    return row is not None


def _link_ssh_connection(conn: sqlite3.Connection, user_id: int, connection_id: int, workspace_id: int) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO ssh_connection_workspaces (connection_id, user_id, workspace_id)
        VALUES (?, ?, ?)
        """,
        (int(connection_id), int(user_id), int(workspace_id)),
    )


def _unlink_ssh_connection(conn: sqlite3.Connection, user_id: int, connection_id: int, workspace_id: int) -> bool:
    cur = conn.execute(
        """
        DELETE FROM ssh_connection_workspaces
        WHERE connection_id = ? AND user_id = ? AND workspace_id = ?
        """,
        (int(connection_id), int(user_id), int(workspace_id)),
    )
    return cur.rowcount > 0


def _cleanup_orphan_ssh_connection(conn: sqlite3.Connection, connection_id: int) -> None:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM ssh_connection_workspaces WHERE connection_id = ?",
        (int(connection_id),),
    ).fetchone()
    if row and int(row["n"]) == 0:
        conn.execute("DELETE FROM ssh_connections WHERE id = ?", (int(connection_id),))


def _fetch_ssh_connection_row(
    conn: sqlite3.Connection,
    user_id: int,
    connection_id: int,
    *,
    workspace_id: int | None = None,
) -> SshConnectionRow | None:
    if workspace_id is None:
        cur = conn.execute(
            f"""
            SELECT {_SSH_CONN_COLUMNS.strip()}
            FROM ssh_connections c
            WHERE c.user_id = ? AND c.id = ?
            """,
            (int(user_id), int(connection_id)),
        )
    else:
        cur = conn.execute(
            f"""
            SELECT {_SSH_CONN_COLUMNS.strip()}
            FROM ssh_connections c
            INNER JOIN ssh_connection_workspaces l ON l.connection_id = c.id
            WHERE c.user_id = ? AND c.id = ? AND l.workspace_id = ?
            """,
            (int(user_id), int(connection_id), int(workspace_id)),
        )
    row = cur.fetchone()
    if not row:
        return None
    shared = _load_shared_workspace_ids(conn, int(row["id"]))
    return _ssh_row_from_row(row, shared)


def list_ssh_connections(user_id: int, workspace_id: int) -> list[SshConnectionRow]:
    conn = _connect()
    try:
        cur = conn.execute(
            f"""
            SELECT {_SSH_CONN_COLUMNS.strip()}
            FROM ssh_connections c
            INNER JOIN ssh_connection_workspaces l ON l.connection_id = c.id
            WHERE c.user_id = ? AND l.workspace_id = ?
            ORDER BY lower(c.name), c.id
            """,
            (user_id, workspace_id),
        )
        rows = cur.fetchall()
        out: list[SshConnectionRow] = []
        for row in rows:
            shared = _load_shared_workspace_ids(conn, int(row["id"]))
            out.append(_ssh_row_from_row(row, shared))
        return out
    finally:
        conn.close()


def list_ssh_connections_catalog(user_id: int) -> list[SshConnectionRow]:
    conn = _connect()
    try:
        cur = conn.execute(
            f"""
            SELECT {_SSH_CONN_COLUMNS.strip()}
            FROM ssh_connections c
            WHERE c.user_id = ?
            ORDER BY lower(c.name), c.id
            """,
            (user_id,),
        )
        rows = cur.fetchall()
        out: list[SshConnectionRow] = []
        for row in rows:
            shared = _load_shared_workspace_ids(conn, int(row["id"]))
            out.append(_ssh_row_from_row(row, shared))
        return out
    finally:
        conn.close()


def get_ssh_connection(user_id: int, workspace_id: int, connection_id: int) -> SshConnectionRow | None:
    conn = _connect()
    try:
        return _fetch_ssh_connection_row(conn, user_id, connection_id, workspace_id=workspace_id)
    finally:
        conn.close()


def get_ssh_connection_by_name(user_id: int, workspace_id: int, name: str) -> SshConnectionRow | None:
    conn = _connect()
    try:
        cur = conn.execute(
            f"""
            SELECT {_SSH_CONN_COLUMNS.strip()}
            FROM ssh_connections c
            INNER JOIN ssh_connection_workspaces l ON l.connection_id = c.id
            WHERE c.user_id = ? AND l.workspace_id = ? AND c.name = ?
            """,
            (user_id, workspace_id, name.strip()),
        )
        row = cur.fetchone()
        if not row:
            return None
        shared = _load_shared_workspace_ids(conn, int(row["id"]))
        return _ssh_row_from_row(row, shared)
    finally:
        conn.close()


def upsert_ssh_connection(
    user_id: int,
    workspace_id: int,
    name: str,
    host: str,
    port: int,
    username: str,
    auth_mode: str,
    private_key_encrypted: str | None,
    password_encrypted: str | None,
) -> int:
    clean_name = name.strip()[:128]
    clean_host = host.strip()[:255]
    clean_username = username.strip()[:128]
    key_value = private_key_encrypted if private_key_encrypted is not None else ""
    conn = _connect()
    try:
        if not _ensure_workspace_owned(conn, user_id, workspace_id):
            raise ValueError("Workspace not found.")
        existing = conn.execute(
            "SELECT id FROM ssh_connections WHERE user_id = ? AND name = ?",
            (user_id, clean_name),
        ).fetchone()
        if existing:
            conn_id = int(existing["id"])
            conn.execute(
                """
                UPDATE ssh_connections
                SET host = ?, port = ?, username = ?, auth_mode = ?, private_key_encrypted = ?, password_encrypted = ?, updated_at = datetime('now')
                WHERE id = ? AND user_id = ?
                """,
                (
                    clean_host,
                    int(port),
                    clean_username,
                    auth_mode.strip(),
                    key_value,
                    password_encrypted,
                    conn_id,
                    user_id,
                ),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO ssh_connections (
                    user_id, home_workspace_id, name, host, port, username, auth_mode, private_key_encrypted, password_encrypted
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    int(workspace_id),
                    clean_name,
                    clean_host,
                    int(port),
                    clean_username,
                    auth_mode.strip(),
                    key_value,
                    password_encrypted,
                ),
            )
            conn_id = int(cur.lastrowid)
        _link_ssh_connection(conn, user_id, conn_id, workspace_id)
        conn.commit()
        return conn_id
    finally:
        conn.close()


def share_ssh_connection(user_id: int, connection_id: int, workspace_id: int) -> bool:
    conn = _connect()
    try:
        row = _fetch_ssh_connection_row(conn, user_id, connection_id)
        if row is None or not _ensure_workspace_owned(conn, user_id, workspace_id):
            return False
        _link_ssh_connection(conn, user_id, connection_id, workspace_id)
        conn.commit()
        return True
    finally:
        conn.close()


def set_ssh_connection_workspaces(user_id: int, connection_id: int, workspace_ids: list[int]) -> bool:
    clean_ids = sorted({int(w) for w in workspace_ids})
    if not clean_ids:
        return False
    conn = _connect()
    try:
        row = _fetch_ssh_connection_row(conn, user_id, connection_id)
        if row is None:
            return False
        for ws_id in clean_ids:
            if not _ensure_workspace_owned(conn, user_id, ws_id):
                return False
        conn.execute(
            "DELETE FROM ssh_connection_workspaces WHERE connection_id = ? AND user_id = ?",
            (int(connection_id), int(user_id)),
        )
        for ws_id in clean_ids:
            _link_ssh_connection(conn, user_id, connection_id, ws_id)
        conn.commit()
        return True
    finally:
        conn.close()


def unshare_ssh_connection(user_id: int, connection_id: int, workspace_id: int) -> bool:
    conn = _connect()
    try:
        row = _fetch_ssh_connection_row(conn, user_id, connection_id)
        if row is None:
            return False
        shared = _load_shared_workspace_ids(conn, connection_id)
        if len(shared) <= 1:
            return False
        if not _unlink_ssh_connection(conn, user_id, connection_id, workspace_id):
            return False
        _cleanup_orphan_ssh_connection(conn, connection_id)
        conn.commit()
        return True
    finally:
        conn.close()


def delete_ssh_connection(user_id: int, workspace_id: int, connection_id: int) -> bool:
    """Remove an SSH profile from one workspace; delete it entirely when unlinked everywhere."""
    conn = _connect()
    try:
        row = _fetch_ssh_connection_row(conn, user_id, connection_id, workspace_id=workspace_id)
        if row is None:
            return False
        if not _unlink_ssh_connection(conn, user_id, connection_id, workspace_id):
            return False
        _cleanup_orphan_ssh_connection(conn, connection_id)
        conn.commit()
        return True
    finally:
        conn.close()


def purge_ssh_connection(user_id: int, connection_id: int) -> bool:
    conn = _connect()
    try:
        cur = conn.execute(
            "DELETE FROM ssh_connections WHERE id = ? AND user_id = ?",
            (int(connection_id), int(user_id)),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
