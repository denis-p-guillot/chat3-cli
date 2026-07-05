"""Odoo SSO handshake helpers for PurpleCloud Brain AI."""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from chat3 import BASE_DIR

DB_PATH = BASE_DIR / "data" / "chat3.db"
STATE_TTL = timedelta(minutes=10)
RETURN_PATH = "/purplecloud/brain/sso/return"


def public_base_url(fallback: str | None = None) -> str:
    env = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if env:
        return env
    if fallback:
        return fallback.rstrip("/")
    return "http://127.0.0.1:8787"


def odoo_sso_shared_secret() -> str:
    return os.getenv("ODOO_SSO_SHARED_SECRET", "").strip()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_odoo_sso_db() -> None:
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS odoo_sso_states (
                state TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                odoo_url TEXT NOT NULL,
                odoo_db TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def _purge_expired_states(conn: sqlite3.Connection) -> None:
    cutoff = (datetime.now(timezone.utc) - STATE_TTL).replace(microsecond=0).isoformat()
    conn.execute("DELETE FROM odoo_sso_states WHERE created_at < ?", (cutoff,))


@dataclass
class OdooSsoState:
    user_id: int
    odoo_url: str
    odoo_db: str | None


def create_sso_state(*, user_id: int, odoo_url: str, odoo_db: str | None) -> str:
    init_odoo_sso_db()
    state = secrets.token_urlsafe(24)
    conn = _connect()
    try:
        _purge_expired_states(conn)
        conn.execute(
            """
            INSERT INTO odoo_sso_states (state, user_id, odoo_url, odoo_db, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                state,
                user_id,
                odoo_url.rstrip("/"),
                odoo_db.strip() if odoo_db else None,
                datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return state


def pop_sso_state(state: str) -> OdooSsoState | None:
    init_odoo_sso_db()
    conn = _connect()
    try:
        _purge_expired_states(conn)
        row = conn.execute(
            "SELECT user_id, odoo_url, odoo_db, created_at FROM odoo_sso_states WHERE state = ?",
            (state,),
        ).fetchone()
        if not row:
            return None
        created = datetime.fromisoformat(str(row["created_at"]))
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - created > STATE_TTL:
            conn.execute("DELETE FROM odoo_sso_states WHERE state = ?", (state,))
            conn.commit()
            return None
        conn.execute("DELETE FROM odoo_sso_states WHERE state = ?", (state,))
        conn.commit()
        return OdooSsoState(
            user_id=int(row["user_id"]),
            odoo_url=str(row["odoo_url"]),
            odoo_db=str(row["odoo_db"]) if row["odoo_db"] else None,
        )
    finally:
        conn.close()


def build_odoo_login_url(*, odoo_url: str, odoo_db: str | None, state: str) -> str:
    redirect_path = RETURN_PATH
    if state:
        redirect_path = f"{RETURN_PATH}?state={urllib.parse.quote(state, safe='')}"
    params: dict[str, str] = {"redirect": redirect_path}
    if odoo_db:
        params["db"] = odoo_db
    query = urllib.parse.urlencode(params)
    return f"{odoo_url.rstrip('/')}/web/login?{query}"


def _jsonrpc(url: str, path: str, params: dict[str, Any]) -> Any:
    payload = {"jsonrpc": "2.0", "method": "call", "params": params, "id": 1}
    req = urllib.request.Request(
        url=f"{url.rstrip('/')}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Odoo HTTP {exc.code}: {detail[:400]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Odoo at {url}: {exc.reason}") from exc
    if body.get("error"):
        err = body["error"]
        message = err.get("data", {}).get("message") or err.get("message") or str(err)
        raise RuntimeError(message)
    return body.get("result")


def exchange_odoo_sso_code(*, odoo_url: str, code: str, secret: str) -> dict[str, str]:
    result = _jsonrpc(
        odoo_url,
        "/purplecloud/brain/sso/exchange",
        {"code": code, "secret": secret},
    )
    if not isinstance(result, dict):
        raise RuntimeError("Unexpected Odoo SSO exchange response.")
    login = str(result.get("login") or "").strip()
    api_key = str(result.get("api_key") or "").strip()
    if not login or not api_key:
        raise RuntimeError("Odoo did not return login credentials.")
    return {"login": login, "api_key": api_key}
