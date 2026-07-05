"""Login, registration, JWT cookies, and current-user dependency."""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Annotated

import jwt
from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Response
from passlib.context import CryptContext
from pydantic import BaseModel, Field

from chat3 import available_models, resolve_user_model
from user_crypto import decrypt_api_key, encrypt_api_key
from user_db import (
    UserRow,
    create_user,
    ensure_user_workspaces_ready,
    get_user_by_id,
    get_user_by_username,
    get_workspace,
    init_db,
    update_user_api_key_encrypted,
    update_user_llm_model,
    update_user_odoo,
    update_user_profile,
    user_exists,
)
from user_sessions import ensure_user_sessions_ready

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

SECRET_KEY = os.environ.get("SECRET_KEY", "")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7
COOKIE_NAME = "access_token"

router = APIRouter(prefix="/auth", tags=["auth"])


def _require_secret_key() -> None:
    if not SECRET_KEY or len(SECRET_KEY) < 16:
        raise HTTPException(
            status_code=503,
            detail="Server not configured: set SECRET_KEY in the environment (at least 16 characters).",
        )


def _truncate_for_bcrypt(password: str) -> str:
    """Bcrypt hashes at most 72 UTF-8 bytes (not characters)."""
    raw = password.encode("utf-8")
    if len(raw) <= 72:
        return password
    return raw[:72].decode("utf-8", errors="ignore")


def hash_password(password: str) -> str:
    return pwd_context.hash(_truncate_for_bcrypt(password))


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(_truncate_for_bcrypt(plain), hashed)


def create_access_token(user_id: int, username: str) -> str:
    _require_secret_key()
    expire = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "username": username, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, object]:
    _require_secret_key()
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


def get_openai_key_for_user(user: UserRow) -> str | None:
    if not user.openai_api_key_encrypted:
        return None
    try:
        return decrypt_api_key(user.openai_api_key_encrypted)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Could not decrypt stored API key. Check SECRET_KEY.") from exc


def get_odoo_password_for_user(user: UserRow) -> str | None:
    if not user.odoo_password_encrypted:
        return None
    try:
        return decrypt_api_key(user.odoo_password_encrypted)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="Could not decrypt stored Odoo password. Check SECRET_KEY.") from exc


def get_current_user(
    access_token: Annotated[str | None, Cookie()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> UserRow:
    raw = access_token
    if not raw and authorization and authorization.startswith("Bearer "):
        raw = authorization[7:].strip()
    if not raw:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(raw)
        uid = int(str(payload["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired session") from exc
    user = get_user_by_id(uid)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


class RegisterBody(BaseModel):
    username: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=200)


class LoginBody(BaseModel):
    username: str = Field(..., max_length=254)
    password: str


class SettingsBody(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    openai_api_key: str | None = Field(default=None, max_length=500)
    llm_model: str | None = Field(default=None, max_length=128)
    odoo_url: str | None = Field(default=None, max_length=500)
    odoo_login: str | None = Field(default=None, max_length=254)
    odoo_password: str | None = Field(default=None, max_length=500)


# Legacy username (no @): letters, digits, . _ -
_LEGACY_USERNAME_RE = re.compile(r"^[a-zA-Z0-9._-]{3,64}$")
# Pragmatic email (RFC-ish): local@domain with common local-part chars
_EMAIL_RE = re.compile(
    r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
    r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$"
)


def _valid_login_identifier(raw: str) -> bool:
    s = raw.strip()
    if len(s) < 3 or len(s) > 254:
        return False
    if "@" in s:
        if s.count("@") != 1:
            return False
        return bool(_EMAIL_RE.match(s))
    return bool(_LEGACY_USERNAME_RE.match(s))


def _set_auth_cookie(response: Response, token: str) -> None:
    secure = os.getenv("COOKIE_SECURE", "").lower() in ("1", "true", "yes")
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        max_age=ACCESS_TOKEN_EXPIRE_DAYS * 86400,
        samesite="lax",
        secure=secure,
        path="/",
    )


def _clear_auth_cookie(response: Response) -> None:
    secure = os.getenv("COOKIE_SECURE", "").lower() in ("1", "true", "yes")
    response.delete_cookie(key=COOKIE_NAME, path="/", samesite="lax", secure=secure)


@router.post("/register")
def register(body: RegisterBody, response: Response) -> dict[str, str]:
    _require_secret_key()
    init_db()
    u = body.username.strip()
    if not _valid_login_identifier(u):
        raise HTTPException(
            status_code=400,
            detail="Use a username (letters, digits, . _ -) or a valid email address.",
        )
    if user_exists(u):
        raise HTTPException(status_code=400, detail="Username already taken")
    uid = create_user(u, hash_password(body.password), body.display_name.strip())
    ensure_user_workspaces_ready(uid)
    ensure_user_sessions_ready(uid)
    token = create_access_token(uid, u.lower())
    _set_auth_cookie(response, token)
    return {"status": "ok", "username": u.lower()}


@router.post("/login")
def login(body: LoginBody, response: Response) -> dict[str, str]:
    _require_secret_key()
    init_db()
    user = get_user_by_username(body.username)
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    ensure_user_workspaces_ready(user.id)
    ensure_user_sessions_ready(user.id)
    token = create_access_token(user.id, user.username)
    _set_auth_cookie(response, token)
    return {"status": "ok", "username": user.username}


@router.post("/logout")
def logout(response: Response) -> dict[str, str]:
    _clear_auth_cookie(response)
    return {"status": "ok"}


class MeOut(BaseModel):
    id: int
    username: str
    display_name: str
    has_openai_key: bool
    active_workspace_id: int
    active_workspace_name: str


@router.get("/me", response_model=MeOut)
def me(user: UserRow = Depends(get_current_user)) -> MeOut:
    ws_id = ensure_user_workspaces_ready(user.id)
    ensure_user_sessions_ready(user.id)
    ws = get_workspace(ws_id, user.id)
    return MeOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        has_openai_key=bool(user.openai_api_key_encrypted),
        active_workspace_id=ws_id,
        active_workspace_name=ws.name if ws else "",
    )


class SettingsOut(BaseModel):
    display_name: str
    has_openai_key: bool
    llm_model: str
    available_models: list[str]
    odoo_url: str
    odoo_login: str
    has_odoo_password: bool


def _settings_out(user: UserRow) -> SettingsOut:
    return SettingsOut(
        display_name=user.display_name,
        has_openai_key=bool(user.openai_api_key_encrypted),
        llm_model=resolve_user_model(user.llm_model),
        available_models=list(available_models()),
        odoo_url=user.odoo_url or "",
        odoo_login=user.odoo_login or "",
        has_odoo_password=bool(user.odoo_password_encrypted),
    )


@router.get("/settings", response_model=SettingsOut)
def get_settings(user: UserRow = Depends(get_current_user)) -> SettingsOut:
    return _settings_out(user)


@router.put("/settings")
def put_settings(body: SettingsBody, user: UserRow = Depends(get_current_user)) -> SettingsOut:
    if body.display_name is not None:
        update_user_profile(user.id, body.display_name)
    if body.openai_api_key is not None:
        key = body.openai_api_key.strip()
        if key:
            enc = encrypt_api_key(key)
            update_user_api_key_encrypted(user.id, enc)
        else:
            update_user_api_key_encrypted(user.id, None)
    if body.llm_model is not None:
        model = body.llm_model.strip()
        allowed = set(available_models())
        if model not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown model. Choose one of: {', '.join(available_models())}",
            )
        update_user_llm_model(user.id, model)
    if body.odoo_url is not None or body.odoo_login is not None or body.odoo_password is not None:
        url = user.odoo_url or ""
        login = user.odoo_login or ""
        password_encrypted = user.odoo_password_encrypted
        if body.odoo_url is not None:
            url = body.odoo_url.strip()
        if body.odoo_login is not None:
            login = body.odoo_login.strip()
        if body.odoo_password is not None:
            pwd = body.odoo_password.strip()
            if pwd:
                password_encrypted = encrypt_api_key(pwd)
            else:
                password_encrypted = None
        update_user_odoo(
            user.id,
            url=url or None,
            login=login or None,
            password_encrypted=password_encrypted,
        )
    fresh = get_user_by_id(user.id)
    assert fresh is not None
    return _settings_out(fresh)
