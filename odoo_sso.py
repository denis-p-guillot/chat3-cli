"""Odoo SSO handshake helpers for PurpleCloud Brain AI."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from chat3 import BASE_DIR

DB_PATH = BASE_DIR / "data" / "chat3.db"
STATE_TTL = timedelta(minutes=10)


def public_base_url(fallback: str | None = None) -> str:
    env = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if env:
        return env
    if fallback:
        return fallback.rstrip("/")
    return "http://127.0.0.1:8787"


def odoo_sso_shared_secret() -> str:
    return os.getenv("ODOO_SSO_SHARED_SECRET", "").strip()


def sign_sso_payload(payload_b64: str, *, secret: str | None = None) -> str:
    key = (secret or odoo_sso_shared_secret()).encode("utf-8")
    return hmac.new(key, payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()


def parse_signed_sso_payload(*, payload_b64: str, sig: str, expected_state: str) -> dict[str, str]:
    secret = odoo_sso_shared_secret()
    if not secret:
        raise ValueError("Brain AI SSO is not configured.")
    expected_sig = sign_sso_payload(payload_b64, secret=secret)
    if not secrets.compare_digest(sig, expected_sig):
        raise ValueError("Invalid Odoo SSO signature.")

    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("Invalid Odoo SSO payload.") from exc
    if not isinstance(data, dict):
        raise ValueError("Invalid Odoo SSO payload.")

    if str(data.get("state") or "") != expected_state:
        raise ValueError("SSO state mismatch.")
    exp = int(data.get("exp") or 0)
    if exp < int(time.time()):
        raise ValueError("SSO payload expired.")

    login = str(data.get("login") or "").strip()
    api_key = str(data.get("api_key") or "").strip()
    if not login or not api_key:
        raise ValueError("Odoo SSO payload is missing credentials.")
    return {"login": login, "api_key": api_key}


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
    base = odoo_url.rstrip("/")
    # Finish on /web/login so Website does not swallow a custom /web/... path.
    finish_url = f"{base}/web/login?brain_sso_state={urllib.parse.quote(state, safe='')}"
    params: dict[str, str] = {"redirect": finish_url}
    if odoo_db:
        params["db"] = odoo_db
    query = urllib.parse.urlencode(params)
    return f"{base}/web/login?{query}"
