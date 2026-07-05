"""HTTP API for chat3: streams agent events (SSE) for the React UI."""

from __future__ import annotations

import asyncio
import gzip
import html
import json
import os
import tarfile
import urllib.error
import urllib.request
import queue
import re
import secrets
import shlex
import shutil
import threading
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

_BASE_DIR = Path(__file__).resolve().parent


def _bootstrap_secret_key() -> None:
    """Load SECRET_KEY from env, optional .env file, or a persisted local file (data/.local_secret_key)."""
    try:
        from dotenv import load_dotenv

        load_dotenv(_BASE_DIR / ".env")
    except ImportError:
        pass
    key = os.environ.get("SECRET_KEY", "").strip()
    if len(key) >= 16:
        return
    local = _BASE_DIR / "data" / ".local_secret_key"
    if local.exists():
        disk = local.read_text(encoding="utf-8").strip()
        if len(disk) >= 16:
            os.environ["SECRET_KEY"] = disk
            return
    local.parent.mkdir(parents=True, exist_ok=True)
    generated = secrets.token_hex(32)
    local.write_text(generated, encoding="utf-8")
    os.environ["SECRET_KEY"] = generated


_bootstrap_secret_key()

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel, Field, model_validator

from odoo_sso import (
    build_odoo_login_url,
    create_sso_state,
    exchange_odoo_sso_code,
    init_odoo_sso_db,
    odoo_sso_shared_secret,
    pop_sso_state,
)
from plantuml_codec import plantuml_encode

from auth_api import complete_odoo_sso_for_user, get_current_user, get_openai_key_for_user, router as auth_router
from chat3 import (
    BASE_DIR,
    WORKSPACE_DIR,
    available_models,
    ensure_dirs,
    ensure_named_workspace_layout,
    iter_agent_turn,
    named_workspace_root,
    resolve_user_model,
    workspace_session,
)
from local_file_analysis import MAX_ANALYSIS_READ_BYTES, analyze_workspace_file
from prompt_optimization import (
    build_diagnose_followup_digest,
    expand_user_message_with_workspace as _expand_user_message_budgeted,
    workspace_files_manifest,
)
from ssh_exec import run_ssh_command
from user_crypto import decrypt_api_key, encrypt_api_key
from user_sessions import ensure_user_sessions_ready, record_user_session, remove_workspace_session
from user_db import (
    UserRow,
    SshConnectionRow,
    WorkspaceRow,
    create_workspace,
    delete_workspace,
    delete_ssh_connection,
    ensure_user_workspaces_ready,
    get_user_by_id,
    get_ssh_connection,
    get_workspace,
    init_db,
    list_ssh_connections,
    list_ssh_connections_catalog,
    list_workspaces,
    purge_ssh_connection,
    set_active_workspace,
    set_ssh_connection_workspaces,
    share_ssh_connection,
    unshare_ssh_connection,
    update_user_odoo,
    upsert_ssh_connection,
)

app = FastAPI(title="PurpleCloud Brain AI", version="1.0.0")

APP_VERSION = "0.6"
_SERVER_BOOT_ID = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api")

# Stored on disk under workspace/users/<id>/w/<ws_id>/uploads/...
MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024
MAX_ATTACHMENTS = 200
MAX_TOTAL_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024
MAX_WORKSPACE_LIST_ENTRIES = 800
MAX_ARCHIVE_EXTRACT_FILES = 4_000
MAX_ARCHIVE_EXTRACT_TOTAL_BYTES = 1_500_000_000
MAX_ARCHIVE_GREP_MATCHES = 200

MAX_PLANTUML_SOURCE_CHARS = 400_000


class PlantUmlRenderBody(BaseModel):
    """Render PlantUML text via a PlantUML server (see PLANTUML_SERVER env)."""

    source: str = Field(..., max_length=MAX_PLANTUML_SOURCE_CHARS)
    format: str = Field(default="svg", description="svg or png")

    @model_validator(mode="after")
    def _normalize_format(self) -> PlantUmlRenderBody:
        fmt = (self.format or "svg").strip().lower()
        if fmt not in ("svg", "png"):
            raise ValueError('format must be "svg" or "png"')
        self.format = fmt
        return self


def _plantuml_server_base() -> str:
    return (os.environ.get("PLANTUML_SERVER") or "https://www.plantuml.com/plantuml").rstrip("/")


def _fetch_plantuml_image(source: str, fmt: str) -> bytes:
    encoded = plantuml_encode(source)
    url = f"{_plantuml_server_base()}/{fmt}/{encoded}"
    req = urllib.request.Request(url, headers={"User-Agent": "PurpleCloud-Brain/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:4000]
        raise HTTPException(
            status_code=502,
            detail=f"PlantUML server returned HTTP {exc.code}: {detail}",
        ) from exc
    except OSError as exc:
        raise HTTPException(status_code=502, detail=f"PlantUML request failed: {exc}") from exc


def current_user_workspace(
    user: UserRow = Depends(get_current_user),
) -> tuple[UserRow, int, WorkspaceRow]:
    ws_id = ensure_user_workspaces_ready(user.id)
    ws = get_workspace(ws_id, user.id)
    if ws is None:
        raise HTTPException(status_code=500, detail="Active workspace missing.")
    fresh = get_user_by_id(user.id)
    assert fresh is not None
    return fresh, ws_id, ws


def sanitize_filename(name: str) -> str:
    base = Path(name).name.replace("\x00", "")
    if not base or base in (".", ".."):
        return "unnamed"
    return base[:200]


def _is_diagnose_archive(path: Path) -> bool:
    low = path.name.lower()
    return low.endswith(".tar") or low.endswith(".tar.gz") or low.endswith(".tgz") or low.endswith(".gz") or low.endswith(".gzip")


def _archive_cache_root(path: Path) -> Path:
    key = f"{int(path.stat().st_mtime_ns)}_{path.stat().st_size}"
    base = re.sub(r"[^a-zA-Z0-9._-]+", "_", path.name)[:120]
    return path.parent / ".diagnose_extract" / f"{base}_{key}"


def _safe_extract_member_path(root: Path, member_name: str) -> Path:
    safe_name = member_name.replace("\\", "/").lstrip("/")
    target = (root / safe_name).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"Unsafe archive member path: {member_name}") from exc
    return target


def _extract_tar_archive(path: Path, out_dir: Path) -> list[Path]:
    extracted: list[Path] = []
    files = 0
    total = 0
    with tarfile.open(path, mode="r:*") as tf:
        members = tf.getmembers()
        for m in members:
            if m.isdir():
                continue
            files += 1
            if files > MAX_ARCHIVE_EXTRACT_FILES:
                raise ValueError(f"Archive has too many files (>{MAX_ARCHIVE_EXTRACT_FILES}).")
            size = int(max(m.size, 0))
            total += size
            if total > MAX_ARCHIVE_EXTRACT_TOTAL_BYTES:
                raise ValueError("Archive is too large after extraction.")
            target = _safe_extract_member_path(out_dir, m.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            src = tf.extractfile(m)
            if src is None:
                continue
            with src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
            extracted.append(target)
    return extracted


def _extract_gzip_file(path: Path, out_dir: Path) -> list[Path]:
    base_name = path.name
    low = base_name.lower()
    if low.endswith(".gz"):
        base_name = base_name[:-3] or "unzipped"
    elif low.endswith(".gzip"):
        base_name = base_name[:-5] or "unzipped"
    target = _safe_extract_member_path(out_dir, sanitize_filename(base_name))
    target.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "rb") as src, target.open("wb") as dst:
        shutil.copyfileobj(src, dst, length=1024 * 1024)
    return [target]


def _extract_archive_for_diagnose(path: Path) -> tuple[Path, list[Path]]:
    if not _is_diagnose_archive(path):
        return path.parent, []
    out_dir = _archive_cache_root(path)
    marker = out_dir / ".ok"
    if marker.exists():
        files = [p for p in out_dir.rglob("*") if p.is_file() and p.name != ".ok"]
        return out_dir, files
    out_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[Path]
    low = path.name.lower()
    if low.endswith(".tar") or low.endswith(".tar.gz") or low.endswith(".tgz"):
        extracted = _extract_tar_archive(path, out_dir)
    else:
        extracted = _extract_gzip_file(path, out_dir)
    marker.write_text("ok", encoding="utf-8")
    return out_dir, extracted


def _grep_extracted_files(files: list[Path], root: Path) -> list[str]:
    if not files:
        return []
    patt = re.compile(r"(error|exception|traceback|fatal|failed|timeout|refused)", re.IGNORECASE)
    out: list[str] = []
    for fp in files:
        if len(out) >= MAX_ARCHIVE_GREP_MATCHES:
            break
        try:
            if fp.stat().st_size > MAX_ANALYSIS_READ_BYTES:
                continue
            raw = fp.read_bytes()
        except OSError:
            continue
        if b"\x00" in raw[:4096]:
            continue
        txt = raw.decode("utf-8", errors="replace")
        for idx, line in enumerate(txt.splitlines(), start=1):
            if patt.search(line):
                rel = fp.relative_to(root).as_posix()
                snippet = line.strip()
                if len(snippet) > 300:
                    snippet = snippet[:300] + "…"
                out.append(f"- `{rel}:{idx}` {snippet}")
                if len(out) >= MAX_ARCHIVE_GREP_MATCHES:
                    break
    return out


def _resolve_user_workspace_rel(rel: str, user_id: int) -> Path:
    """Resolve paths stored as users/<user_id>/w/<workspace_id>/uploads/... relative to WORKSPACE_DIR."""
    raw = rel.strip().replace("\\", "/")
    if not raw or raw.startswith("/") or ".." in raw.split("/"):
        raise ValueError(f"Invalid workspace path: {rel}")
    uid_str = str(int(user_id))
    if not raw.startswith(f"users/{uid_str}/"):
        raise ValueError("Workspace path is not for this user.")
    full = (WORKSPACE_DIR / raw).resolve()
    user_root = (WORKSPACE_DIR / "users" / uid_str).resolve()
    try:
        full.relative_to(user_root)
    except ValueError as exc:
        raise ValueError("Workspace path is not allowed for this user.") from exc
    return full


def expand_workspace_file(rel: str, user_id: int) -> str:
    """Inject only local analysis into the prompt — never raw full-file dumps. Never raises HTTPException."""
    try:
        path = _resolve_user_workspace_rel(rel, user_id)
    except ValueError as exc:
        return f"---\n**Attachment skipped:** {exc}\n"
    if not path.exists() or not path.is_file():
        return (
            "---\n"
            f"**Attachment not found:** `{rel}`\n\n"
            "The file may have been removed, or this message refers to another workspace.\n"
        )
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        return (
            "---\n"
            f"**Attachment too large to process:** `{rel}` (max {MAX_FILE_BYTES} bytes).\n"
        )
    body = analyze_workspace_file(path, rel)
    if not _is_diagnose_archive(path):
        return (
            "---\n"
            "**User attachment (parsed and summarized locally — you do not receive the full file as raw bytes):**\n\n"
            f"{body}\n"
        )

    archive_extra = ""
    try:
        extract_root, extracted = _extract_archive_for_diagnose(path)
        grep_lines = _grep_extracted_files(extracted, extract_root)
        preview = "\n".join(grep_lines[:50]) if grep_lines else "- No obvious error keywords matched."
        archive_extra = (
            "\n\n### Archive diagnostics (auto-extracted for Diagnose Error)\n"
            f"- **Extracted files:** {len(extracted)}\n"
            f"- **Extraction root:** `{extract_root.relative_to(WORKSPACE_DIR).as_posix()}`\n"
            "- **Keyword grep hits (`error|exception|traceback|fatal|failed|timeout|refused`):**\n"
            f"{preview}\n"
        )
    except Exception as exc:
        archive_extra = (
            "\n\n### Archive diagnostics (auto-extracted for Diagnose Error)\n"
            f"- Extraction failed: {exc}\n"
        )
    return (
        "---\n"
        "**User attachment (parsed and summarized locally — you do not receive the full file as raw bytes):**\n\n"
        f"{body}{archive_extra}\n"
    )


def expand_user_message_with_workspace(text: str, workspace_files: list[str], user_id: int) -> str:
    if len(workspace_files) > MAX_ATTACHMENTS:
        workspace_files = workspace_files[:MAX_ATTACHMENTS]
    return _expand_user_message_budgeted(text, workspace_files, user_id, expand_workspace_file)


class ChatMessage(BaseModel):
    role: str
    content: str = Field(default="", max_length=500_000)
    workspace_files: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)

    @model_validator(mode="after")
    def _validate_message(self) -> ChatMessage:
        if self.role not in ("user", "assistant"):
            raise ValueError(f"Invalid role: {self.role}")
        if self.role == "assistant" and self.workspace_files:
            raise ValueError("workspace_files are only allowed on user messages.")
        if self.role == "user":
            has_ws = bool(self.workspace_files and len(self.workspace_files) > 0)
            if not self.content.strip() and not has_ws:
                raise ValueError("User message must include text and/or workspace files.")
        return self


class ChatBody(BaseModel):
    messages: list[ChatMessage] = Field(..., max_length=300)


@app.on_event("startup")
def _startup() -> None:
    init_db()
    init_odoo_sso_db()
    ensure_dirs()


class OdooSsoStartBody(BaseModel):
    odoo_url: str | None = Field(default=None, max_length=500)
    odoo_db: str | None = Field(default=None, max_length=128)


def _odoo_sso_callback_html(*, ok: bool, message: str, login: str = "") -> str:
    payload = json.dumps(
        {"type": "odoo-sso", "ok": ok, "message": message, "login": login},
        ensure_ascii=False,
    )
    safe_message = html.escape(message)
    safe_login = html.escape(login)
    return f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Odoo SSO</title></head>
<body>
<p>{safe_message}</p>
<script>
  const payload = {payload};
  if (window.opener) {{
    window.opener.postMessage(payload, window.location.origin);
  }}
  window.setTimeout(() => window.close(), 400);
</script>
</body>
</html>"""


@app.post("/api/odoo/sso/start")
def odoo_sso_start(body: OdooSsoStartBody, user: UserRow = Depends(get_current_user)) -> dict[str, str]:
    if not odoo_sso_shared_secret():
        raise HTTPException(
            status_code=503,
            detail="ODOO_SSO_SHARED_SECRET is not configured on the Brain AI server.",
        )
    odoo_url = (body.odoo_url or user.odoo_url or "").strip().rstrip("/")
    if not odoo_url:
        raise HTTPException(status_code=400, detail="Enter your Odoo URL before starting SSO.")
    odoo_db = (body.odoo_db or user.odoo_db or "").strip() or None
    update_user_odoo(
        user.id,
        url=odoo_url,
        login=user.odoo_login,
        password_encrypted=user.odoo_password_encrypted,
        db=odoo_db,
        auth_mode=user.odoo_auth_mode,
    )
    state = create_sso_state(user_id=user.id, odoo_url=odoo_url, odoo_db=odoo_db)
    return {
        "authorize_url": build_odoo_login_url(odoo_url=odoo_url, odoo_db=odoo_db, state=state),
        "state": state,
    }


@app.get("/api/odoo/sso/callback")
def odoo_sso_callback(
    code: str = Query(..., min_length=8),
    state: str = Query(..., min_length=8),
) -> Response:
    secret = odoo_sso_shared_secret()
    if not secret:
        return Response(
            content=_odoo_sso_callback_html(ok=False, message="Brain AI SSO is not configured."),
            media_type="text/html",
            status_code=503,
        )
    pending = pop_sso_state(state)
    if not pending:
        return Response(
            content=_odoo_sso_callback_html(ok=False, message="SSO session expired. Try again from Settings."),
            media_type="text/html",
            status_code=400,
        )
    try:
        creds = exchange_odoo_sso_code(odoo_url=pending.odoo_url, code=code, secret=secret)
        complete_odoo_sso_for_user(
            pending.user_id,
            odoo_url=pending.odoo_url,
            odoo_db=pending.odoo_db,
            login=creds["login"],
            api_key=creds["api_key"],
        )
    except Exception as exc:
        return Response(
            content=_odoo_sso_callback_html(
                ok=False,
                message=f"Odoo SSO failed: {exc}. Install the purplecloud_brain_sso module on Odoo and configure the shared secret.",
            ),
            media_type="text/html",
            status_code=502,
        )
    return Response(
        content=_odoo_sso_callback_html(
            ok=True,
            message=f"Connected to Odoo as {creds['login']}.",
            login=creds["login"],
        ),
        media_type="text/html",
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _read_ui_version_file() -> dict[str, Any]:
    for rel in ("web/dist/version.json", "web/public/version.json"):
        path = BASE_DIR / rel
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return {}


@app.get("/api/version")
def app_version() -> Response:
    """Public build identity used by the UI auto-update watcher."""
    ui = _read_ui_version_file()
    build_id = str(ui.get("build_id") or _SERVER_BOOT_ID)
    payload = {
        "app_version": str(ui.get("app_version") or APP_VERSION),
        "build_id": build_id,
        "server_boot_id": _SERVER_BOOT_ID,
        "agent_id": f"{build_id}|{_SERVER_BOOT_ID}",
        "built_at": ui.get("built_at"),
    }
    return Response(
        content=json.dumps(payload, ensure_ascii=False),
        media_type="application/json",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


@app.get("/api/meta")
def meta(ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace)) -> dict[str, Any]:
    user, ws_id, ws = ctx
    root = ensure_named_workspace_layout(user.id, ws_id)
    return {
        "model": resolve_user_model(user.llm_model),
        "available_models": list(available_models()),
        "workspace": str(WORKSPACE_DIR),
        "base_dir": str(BASE_DIR),
        "user_workspace": f"users/{user.id}/w/{ws_id}",
        "user_workspace_abs": str(root),
        "active_workspace_id": str(ws_id),
        "active_workspace_name": ws.name,
    }


def prepare_history(body: ChatBody, user_id: int) -> list[dict[str, str]]:
    last_expand_idx = -1
    for i, m in enumerate(body.messages):
        if m.role == "user" and m.workspace_files:
            last_expand_idx = i

    history: list[dict[str, str]] = []
    for i, m in enumerate(body.messages):
        if m.role == "user" and m.workspace_files:
            files = list(m.workspace_files)[:MAX_ATTACHMENTS]
            if i == last_expand_idx:
                content = expand_user_message_with_workspace(m.content, files, user_id)
            else:
                content = workspace_files_manifest(m.content, files)
        else:
            content = m.content
        history.append({"role": m.role, "content": content})
    return history


def _chat_messages_path(user_id: int, workspace_id: int) -> Path:
    return ensure_named_workspace_layout(user_id, workspace_id) / "chat_messages.json"


MAX_CHAT_MESSAGES = 500
MAX_CHAT_JSON_BYTES = 50 * 1024 * 1024


class ChatHistoryPutBody(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_CHAT_MESSAGES)


@app.get("/api/chat/history")
def get_chat_history(ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace)) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    ensure_user_sessions_ready(user.id)
    path = _chat_messages_path(user.id, ws_id)
    if not path.exists():
        return {"messages": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid chat history JSON: {exc}") from exc
    if not isinstance(data, dict):
        return {"messages": []}
    messages = data.get("messages")
    if not isinstance(messages, list):
        return {"messages": []}
    return {"messages": messages}


@app.put("/api/chat/history")
def put_chat_history(
    body: ChatHistoryPutBody,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, str]:
    user, ws_id, ws = ctx
    raw = json.dumps({"messages": body.messages}, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_CHAT_JSON_BYTES:
        raise HTTPException(status_code=400, detail="Chat history payload is too large.")
    path = _chat_messages_path(user.id, ws_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(raw, encoding="utf-8")
    record_user_session(user.id, ws_id, ws.name if ws else f"Workspace {ws_id}", body.messages)
    return {"status": "ok"}


@app.post("/api/chat/stream")
async def chat_stream(
    body: ChatBody,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> StreamingResponse:
    user, ws_id, _ws = ctx
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty.")
    key = get_openai_key_for_user(user)
    if not key:
        raise HTTPException(
            status_code=503,
            detail="No OpenAI API key configured for your account. Add your key in Settings.",
        )
    client = OpenAI(api_key=key)
    active_model = resolve_user_model(user.llm_model)

    # Starlette runs *sync* StreamingResponse iterators in a thread pool; successive next() calls
    # can use different threads, so ContextVar tokens from workspace_session() break on exit.
    # Run the whole turn in one dedicated thread and bridge with a queue.
    async def event_stream() -> AsyncIterator[bytes]:
        q: queue.Queue[bytes | None] = queue.Queue()

        def worker() -> None:
            try:
                with workspace_session(user.id, ws_id):
                    try:
                        history = prepare_history(body, user.id)
                    except Exception as exc:
                        err = {"type": "error", "message": f"Could not prepare messages: {exc}"}
                        q.put(f"data: {json.dumps(err)}\n\n".encode("utf-8"))
                        q.put(f"data: {json.dumps({'type': 'done'})}\n\n".encode("utf-8"))
                        return
                    try:
                        for ev in iter_agent_turn(client, history, model=active_model):
                            q.put(
                                f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8")
                            )
                        q.put(f"data: {json.dumps({'type': 'done'})}\n\n".encode("utf-8"))
                    except Exception as exc:
                        err = {"type": "error", "message": str(exc)}
                        q.put(f"data: {json.dumps(err)}\n\n".encode("utf-8"))
            finally:
                q.put(None)

        threading.Thread(target=worker, daemon=True).start()
        heartbeat_step = "Diagnosis still running: collecting remote diagnostics..."
        while True:
            try:
                chunk = await asyncio.to_thread(q.get, True, 2.0)
            except queue.Empty:
                hb = {"type": "activity", "step": heartbeat_step}
                yield f"data: {json.dumps(hb, ensure_ascii=False)}\n\n".encode("utf-8")
                continue
            if chunk is None:
                break
            yield chunk

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/workspace/upload")
async def upload_workspace_files(
    files: list[UploadFile] = File(...),
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, Any]:
    """Save files under workspace/users/<id>/w/<ws_id>/uploads/ and return paths relative to workspace."""
    user, ws_id, _ws = ctx
    if not files:
        raise HTTPException(status_code=400, detail="No files.")
    if len(files) > MAX_ATTACHMENTS:
        raise HTTPException(status_code=400, detail=f"Too many files (max {MAX_ATTACHMENTS}).")
    ensure_dirs()
    user_root = ensure_named_workspace_layout(user.id, ws_id)
    user_dir = user_root / "uploads"
    out: list[dict[str, str | int]] = []
    batch_total = 0
    for uf in files:
        try:
            safe = sanitize_filename(uf.filename or "unnamed")
            rel = f"users/{user.id}/w/{ws_id}/uploads/{uuid4().hex}_{safe}"
            dest = user_dir / f"{rel.split('/')[-1]}"
            total = 0
            try:
                with dest.open("wb") as f:
                    while True:
                        chunk = await uf.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_FILE_BYTES:
                            dest.unlink(missing_ok=True)
                            raise HTTPException(
                                status_code=400,
                                detail=f"File too large (max {MAX_FILE_BYTES // (1024 ** 3)} GB per file).",
                            )
                        f.write(chunk)
            except HTTPException:
                raise
            except Exception as exc:
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=500, detail=str(exc)) from exc
            batch_total += total
            if batch_total > MAX_TOTAL_UPLOAD_BYTES:
                dest.unlink(missing_ok=True)
                raise HTTPException(status_code=400, detail="Total upload size for this request is too large.")
            out.append({"path": rel, "name": safe, "size": total})
        finally:
            await uf.close()
    return {"files": out}


@app.get("/api/workspace/files")
def workspace_files(ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace)) -> dict[str, Any]:
    """List files visible in the active workspace root."""
    user, ws_id, _ws = ctx
    root = ensure_named_workspace_layout(user.id, ws_id)
    entries: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if len(entries) >= MAX_WORKSPACE_LIST_ENTRIES:
            break
        rel = path.relative_to(root).as_posix()
        if not rel:
            continue
        if path.is_dir():
            entries.append({"path": rel, "type": "dir"})
        elif path.is_file():
            try:
                size = path.stat().st_size
            except OSError:
                size = 0
            entries.append({"path": rel, "type": "file", "size": size})
    return {
        "root": f"users/{user.id}/w/{ws_id}",
        "entries": entries,
        "truncated": len(entries) >= MAX_WORKSPACE_LIST_ENTRIES,
    }


@app.get("/api/workspace/download")
def workspace_download(
    path: str,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> FileResponse:
    user, _ws_id, _ws = ctx
    try:
        full = _resolve_user_workspace_rel(path, user.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not full.exists() or not full.is_file():
        raise HTTPException(status_code=404, detail="Workspace file not found.")
    return FileResponse(path=str(full), filename=full.name, media_type="application/octet-stream")


class CreateWorkspaceBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)


class SshConnectionShareBody(BaseModel):
    workspace_id: int = Field(..., ge=1)


class SshConnectionWorkspacesBody(BaseModel):
    workspace_ids: list[int] = Field(..., min_length=1, max_length=100)


class SshConnectionIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    host: str = Field(..., min_length=1, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(..., min_length=1, max_length=128)
    auth_mode: str = Field(default="private_key", pattern="^(private_key|password|private_key_password)$")
    private_key: str | None = Field(default=None, max_length=200_000)
    password: str | None = Field(default=None, max_length=10_000)


class DiagnoseErrorBody(BaseModel):
    context: str = Field(default="", max_length=200_000)
    ssh_connections: list[str] = Field(default_factory=list, max_length=50)
    generate_report: bool = True


class DiagnoseRenderReportBody(BaseModel):
    context: str = Field(default="", max_length=200_000)
    ssh_connections_data: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    activity: list[str] = Field(default_factory=list, max_length=5000)
    assistant_summary: str = Field(default="", max_length=500_000)


def _render_issue_analysis_html(
    context: str,
    user_id: int,
    workspace_id: int,
    ssh_connections: list[dict[str, Any]],
    activity: list[str],
    assistant_summary: str = "",
) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    safe_context = html.escape(context.strip() or "(No context provided)")
    ssh_items = "".join(
        f"<li><code>{html.escape(c['name'])}</code> — {html.escape(c['username'])}@{html.escape(c['host'])}:{int(c['port'])} ({html.escape(c['auth_mode'])})</li>"
        for c in ssh_connections
    )
    ssh_section = (
        f"""
    <section class="section">
      <h2>SSH Access Scope</h2>
      <p>The following saved SSH connections were explicitly attached to this diagnosis run:</p>
      <ul>{ssh_items}</ul>
      <p>These can be used for remote checks (logs/processes/config) in follow-up investigation steps.</p>
    </section>
"""
        if ssh_connections
        else """
    <section class="section">
      <h2>SSH Access Scope</h2>
      <p>No SSH connections were attached to this diagnosis run.</p>
    </section>
"""
    )
    grouped_activity: list[tuple[str, list[str]]] = [
        ("Setup", []),
        ("Connection Prep", []),
        ("Diagnostics Collection", []),
        ("Downloads", []),
        ("Analysis", []),
        ("Report", []),
        ("Other", []),
    ]
    for step in activity:
        s = step.lower()
        idx = 6
        if "starting diagnosis run" in s:
            idx = 0
        elif "using ssh connection" in s or "skipped ssh connection" in s or "credential decryption failed" in s:
            idx = 1
        elif "collecting remote diagnostics" in s or "saved base diagnostic artifacts" in s:
            idx = 2
        elif "downloading " in s or "saved downloaded " in s:
            idx = 3
        elif "analyzing downloaded files" in s or "re-analyzed downloaded logs" in s:
            idx = 4
        elif "report generated" in s:
            idx = 5
        grouped_activity[idx][1].append(step)

    analysis_flow_items_parts: list[str] = []
    for group_name, steps in grouped_activity:
        if not steps:
            continue
        items = "".join(f"<li>{html.escape(item)}</li>" for item in steps)
        analysis_flow_items_parts.append(
            f"<li><strong>{html.escape(group_name)}</strong><ol>{items}</ol></li>"
        )
    analysis_flow_items = "".join(analysis_flow_items_parts) or "<li>No activity captured.</li>"
    analysis_flow_section = f"""
    <section class="section">
      <h2>Full Analysis Flow</h2>
      <p>Complete execution stages grouped by phase (chronological order preserved inside each phase):</p>
      <ol>{analysis_flow_items}</ol>
    </section>
"""

    def _collapsed_sample(title: str, content: str) -> str:
        return (
            f"<details><summary>{html.escape(title)} (click to expand)</summary>"
            f"<pre>{html.escape(content)}</pre>"
            "</details>"
        )

    remote_cards = "".join(
        f"""
    <section class="section">
      <h2>Remote Diagnostics: {html.escape(str(c.get('name', 'unknown')))}</h2>
      <p><strong>Target:</strong> {html.escape(str(c.get('username', '')))}@{html.escape(str(c.get('host', '')))}:{int(c.get('port', 22))}</p>
      <p><strong>Status:</strong> {html.escape(str(c.get('status', 'unknown')))}</p>
      <h3>Findings</h3>
      <ul>{"".join(f"<li>{html.escape(x)}</li>" for x in c.get('findings', [])) or "<li>No automatic findings.</li>"}</ul>
      <h3>Log samples</h3>
      {_collapsed_sample("Nginx logs", str(c.get('nginx_logs', '(no data)')))}
      {_collapsed_sample("Odoo logs", str(c.get('odoo_logs', '(no data)')))}
      {_collapsed_sample("PostgreSQL logs", str(c.get('postgres_logs', '(no data)')))}
      {_collapsed_sample("pg_stat_statements", str(c.get('pg_stat_statements', '(no data)')))}
      {_collapsed_sample("Odoo addons inventory", str(c.get('odoo_addons', '(no data)')))}
      {_collapsed_sample("Custom addons selected", str("\\n".join(c.get('custom_addons_selected', [])) if c.get('custom_addons_selected') else '(none)'))}
      <h3>Code-centric analysis</h3>
      <ul>{"".join(f"<li>{html.escape(x)}</li>" for x in c.get('code_findings', [])) or "<li>No code analysis findings.</li>"}</ul>
      <h3>Code/log correlation</h3>
      <ul>{"".join(f"<li>{html.escape(x)}</li>" for x in c.get('code_log_correlation', [])) or "<li>No correlation notes.</li>"}</ul>
      {_collapsed_sample("Custom addons code bundle", str(c.get('custom_addons_code_bundle', '(no data)')))}
      {_collapsed_sample("Remote files inventory", str(c.get('remote_files', '(no data)')))}
      <h3>Downloaded artifacts (workspace paths)</h3>
      <pre>{html.escape(str("\n".join(c.get('artifact_paths', [])) if c.get('artifact_paths') else '(none)'))}</pre>
      <h3>Debug samples</h3>
      {_collapsed_sample("Raw SSH output", str(c.get('raw_output', '(no output)')))}
    </section>
"""
        for c in ssh_connections
        if c.get("diagnostics")
    )
    if not remote_cards:
        remote_cards = """
    <section class="section">
      <h2>Remote Diagnostics</h2>
      <p>No remote diagnostics were executed in this run.</p>
    </section>
"""
    normalized_assistant_summary = assistant_summary.strip() or "(No AI follow-up conclusions were captured for this run.)"
    assistant_section = f"""
    <section class="section">
      <h2>AI Follow-up Conclusions</h2>
      <pre>{html.escape(normalized_assistant_summary)}</pre>
    </section>
"""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PurpleCloud Issue Investigation Report</title>
  <style>
    :root {{
      --bg:#0c0815; --panel:#171027; --panel2:#201635; --text:#f3ecff; --muted:#b8a9d6;
      --line:#3a2b5c; --accent:#8b5cf6; --accent2:#c4b5fd;
    }}
    * {{ box-sizing:border-box; }}
    body {{
      margin:0;
      font-family:'Plus Jakarta Sans',Inter,Segoe UI,Roboto,Arial,sans-serif;
      background:
        radial-gradient(circle at top left, rgba(139,92,246,.17), transparent 30%),
        radial-gradient(circle at top right, rgba(124,58,237,.16), transparent 25%),
        linear-gradient(180deg, #10091a 0%, var(--bg) 100%);
      color:var(--text);
    }}
    .wrap {{ max-width:980px; margin:0 auto; padding:32px 20px 64px; }}
    .hero {{ border:1px solid rgba(192,132,252,.22); border-radius:20px; padding:28px; background:linear-gradient(135deg,rgba(168,85,247,.2),rgba(124,58,237,.15)); box-shadow:0 18px 40px rgba(0,0,0,.35); }}
    .section {{ margin-top:16px; border:1px solid rgba(184,169,214,.14); border-radius:16px; padding:20px; background:rgba(23,16,39,.86); box-shadow:0 10px 28px rgba(0,0,0,.25); }}
    .eyebrow {{ font-size:12px; text-transform:uppercase; letter-spacing:.12em; color:var(--accent2); }}
    h1,h2 {{ margin:0 0 10px; }}
    p,li {{ color:var(--muted); line-height:1.6; }}
    pre {{ background:#120d1f; border:1px solid var(--line); border-radius:10px; padding:14px; white-space:pre-wrap; word-break:break-word; color:#f3e8ff; }}
    .footer {{ margin-top:20px; color:#a997ca; font-size:.88rem; text-align:center; border-top:1px solid rgba(184,169,214,.15); padding-top:14px; }}
    a {{ color:#c4b5fd; text-decoration:none; }}
    a:hover {{ text-decoration:underline; }}
    details {{ margin:10px 0; border:1px solid rgba(184,169,214,.18); border-radius:10px; background:#120d1f; }}
    summary {{ cursor:pointer; padding:10px 12px; color:#d8c9f8; font-weight:600; }}
    details pre {{ margin:0 12px 12px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="eyebrow">PurpleCloud Report</div>
      <h1>Issue Investigation Report</h1>
      <p>Generated automatically by <strong>Diagnose Error</strong> for workspace <strong>{workspace_id}</strong> (user {user_id}) using PurpleCloud styling conventions.</p>
    </section>
    <section class="section">
      <h2>Provided Context</h2>
      <pre>{safe_context}</pre>
    </section>
    <section class="section">
      <h2>Initial Analysis Checklist</h2>
      <ul>
        <li>Confirm reproducible steps and expected vs actual behavior.</li>
        <li>Collect server logs, browser console logs, and recent deploy or config changes.</li>
        <li>Identify impacted modules, requests, and potential loops/timeouts.</li>
        <li>Validate data integrity and permission/auth side effects.</li>
      </ul>
    </section>
{ssh_section}
{analysis_flow_section}
{remote_cards}
{assistant_section}
    <section class="section">
      <h2>Standardized Next Actions</h2>
      <p>Use this fixed output contract for every diagnosis report:</p>
      <ol>
        <li><strong>Concrete Findings</strong>: 5 concise findings with direct evidence references (logs/code/artifacts).</li>
        <li><strong>Likely Root Cause</strong>: primary hypothesis, confidence level, and assumptions.</li>
        <li><strong>Recommended Next Actions</strong>: immediate validation and containment actions.</li>
        <li><strong>Remediation Plan</strong>: prioritized implementation steps (P0/P1/P2), owner suggestions, and rollback notes.</li>
      </ol>
    </section>
    <div class="footer">
      Generated at {now} · Styled for PurpleCloud<br/>
      <a href="https://purple-cloud.ai/" target="_blank" rel="noopener noreferrer">purple-cloud.ai</a>
    </div>
  </div>
</body>
</html>
"""


def _write_issue_analysis_report(
    context: str,
    user_id: int,
    ws_id: int,
    attached: list[dict[str, Any]],
    activity: list[str],
    assistant_summary: str = "",
) -> dict[str, Any]:
    root = ensure_named_workspace_layout(user_id, ws_id)
    out_path = root / "issue_analysis.html"
    report_activity = [*activity, "Report generated."]
    out_path.write_text(
        _render_issue_analysis_html(context, user_id, ws_id, attached, report_activity, assistant_summary),
        encoding="utf-8",
    )
    rel = f"users/{user_id}/w/{ws_id}/issue_analysis.html"
    return {"path": rel, "name": "issue_analysis.html", "activity": report_activity}


def _diagnose_state_path(user_id: int, ws_id: int) -> Path:
    return ensure_named_workspace_layout(user_id, ws_id) / "diagnose_state.json"


def _extract_tagged(body: str, tag: str) -> str:
    # Accept both populated and empty tagged sections, with LF or CRLF line endings.
    begin_pat = rf"===BEGIN_{re.escape(tag)}==="
    end_pat = rf"===END_{re.escape(tag)}==="
    m = re.search(
        rf"{begin_pat}\s*\r?\n?(.*?)(?:\r?\n)?{end_pat}",
        body,
        flags=re.S,
    )
    if not m:
        return "(not found)"
    return (m.group(1) or "").strip() or "(empty)"


def _analyze_remote_text(nginx_logs: str, odoo_logs: str, pg_logs: str, pg_stats: str) -> list[str]:
    findings: list[str] = []
    def _count(pattern: str, text: str) -> int:
        return len(re.findall(pattern, text, flags=re.I))

    n_5xx = _count(r"\b50[0-9]\b", nginx_logs)
    if n_5xx:
        findings.append(f"Nginx shows {n_5xx} HTTP 5xx occurrences in sampled lines.")
    n_odoo_err = _count(r"\b(error|traceback|exception)\b", odoo_logs)
    if n_odoo_err:
        findings.append(f"Odoo logs contain {n_odoo_err} error/traceback keywords in sampled lines.")
    n_pg_err = _count(r"\b(error|fatal|panic|canceling statement)\b", pg_logs)
    if n_pg_err:
        findings.append(f"PostgreSQL logs contain {n_pg_err} error/fatal keywords in sampled lines.")
    # Nginx latency/perf hints in common log formats (request_time / upstream_response_time)
    nginx_req_times = [float(x) for x in re.findall(r"request_time[=:\s\"]+([0-9]+(?:\.[0-9]+)?)", nginx_logs, flags=re.I)]
    nginx_upstream_times = [
        float(x) for x in re.findall(r"upstream_response_time[=:\s\"]+([0-9]+(?:\.[0-9]+)?)", nginx_logs, flags=re.I)
    ]
    slow_req = [x for x in nginx_req_times if x >= 1.0]
    slow_up = [x for x in nginx_upstream_times if x >= 1.0]
    if slow_req:
        findings.append(
            f"Nginx shows {len(slow_req)} slow requests (>=1s) in sampled lines; max request_time is {max(slow_req):.3f}s."
        )
    if slow_up:
        findings.append(
            f"Nginx upstream latency appears elevated ({len(slow_up)} entries >=1s); max upstream_response_time is {max(slow_up):.3f}s."
        )

    # Odoo latency/perf hints
    odoo_slow_keywords = _count(r"\b(slow|timeout|longpolling|worker.*busy|db.*slow|took\s+[0-9.]+s)\b", odoo_logs)
    if odoo_slow_keywords:
        findings.append(f"Odoo logs include {odoo_slow_keywords} performance-related indicators (slow/timeout/worker busy).")

    # PostgreSQL latency/perf hints
    pg_slow_lines = _count(r"\b(duration:\s*[0-9.]+\s*ms|statement timeout|temporary file|checkpoint)\b", pg_logs)
    if pg_slow_lines:
        findings.append(f"PostgreSQL logs show {pg_slow_lines} potential performance markers (duration/timeout/temp files/checkpoints).")
    pg_stats_l = pg_stats.lower()
    if "extension is not available" in pg_stats_l:
        findings.append("pg_stat_statements extension is not available on this server.")
    elif "access is denied" in pg_stats_l or "permission denied" in pg_stats_l:
        findings.append("pg_stat_statements appears present but access is denied for the SSH user.")
    elif pg_stats and pg_stats not in {"(not found)", "(empty)"}:
        findings.append("pg_stat_statements returned top slow/expensive query summary.")
        # Parse pg_stat_statements table-like output (tab-separated) and flag expensive totals/means.
        expensive_rows = 0
        mean_over_100ms = 0
        for line in pg_stats.splitlines():
            if not line.strip() or line.lower().startswith("queryid"):
                continue
            cols = line.split("\t")
            if len(cols) < 4:
                continue
            # total_exec_time (new) or total_time (old) in col #3 ; mean in col #4
            try:
                total_ms = float(cols[2])
                mean_ms = float(cols[3])
            except ValueError:
                continue
            if total_ms >= 10_000:
                expensive_rows += 1
            if mean_ms >= 100:
                mean_over_100ms += 1
        if expensive_rows:
            findings.append(f"pg_stat_statements shows {expensive_rows} query patterns with cumulative runtime >= 10s.")
        if mean_over_100ms:
            findings.append(f"pg_stat_statements shows {mean_over_100ms} query patterns with mean runtime >= 100ms.")
    if not findings:
        findings.append("No obvious high-signal errors detected in sampled logs.")
    return findings


def _collect_remote_diagnostics(
    row: SshConnectionRow,
    key: str | None,
    password: str | None,
    emit_activity: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    def emit(step: str) -> None:
        if emit_activity is not None:
            emit_activity(step)

    emit(f"[Action] Starting remote diagnostics script on '{row.name}'.")
    sudo_env_prefix = ""
    if password:
        sudo_env_prefix = f"PC_SUDO_PASS={shlex.quote(password)}; export PC_SUDO_PASS; "
    script = r"""
set +e
SUDO=""
if sudo -n true >/dev/null 2>&1; then
  SUDO="sudo -n"
elif [ -n "$PC_SUDO_PASS" ] && printf '%s\n' "$PC_SUDO_PASS" | sudo -S -p '' true >/dev/null 2>&1; then
  SUDO="sudo -S -p ''"
fi
run_cmd() {
  if [ -n "$SUDO" ]; then
    if [ "$SUDO" = "sudo -S -p ''" ]; then
      printf '%s\n' "$PC_SUDO_PASS" | sudo -S -p '' sh -lc "$1" 2>/dev/null || true
    else
      $SUDO sh -lc "$1" 2>/dev/null || true
    fi
  else
    sh -lc "$1" 2>/dev/null || true
  fi
}

tail_newest() {
  # Usage: tail_newest "<glob patterns>" <max_files> <lines_per_file>
  GLOB_EXPR="$1"
  MAX_FILES="${2:-3}"
  LINES="${3:-250}"
  run_cmd "ls -1t $GLOB_EXPR 2>/dev/null | head -n $MAX_FILES | xargs -r tail -n $LINES"
}

echo "===BEGIN_NGINX==="
NGINX_OUT=""
NGINX_ERR_PATH="$(run_cmd "nginx -T | rg -o \"error_log\\s+[^;]+\" | awk '{print \$2}' | head -n 1")"
NGINX_ACC_PATH="$(run_cmd "nginx -T | rg -o \"access_log\\s+[^;]+\" | awk '{print \$2}' | head -n 1")"
if [ -n "$NGINX_ERR_PATH" ] || [ -n "$NGINX_ACC_PATH" ]; then
  NGINX_OUT="$(run_cmd "tail -n 200 \"$NGINX_ERR_PATH\" \"$NGINX_ACC_PATH\"")"
fi
if [ -z "$NGINX_OUT" ] && [ -d /var/log/nginx ]; then
  NGINX_OUT="$(tail_newest "/var/log/nginx/*error*.log /var/log/nginx/*access*.log /var/log/nginx/*.log" 5 300)"
fi
if [ -z "$NGINX_OUT" ]; then
  NGINX_OUT="$(run_cmd "journalctl -u nginx -u nginx.service -u nginx-mainline -n 200 --no-pager")"
fi
printf "%s\n" "$NGINX_OUT"
echo "===END_NGINX==="

echo "===BEGIN_ODOO==="
ODOO_OUT=""
ODOO_CONF_PATH="$(run_cmd "ps aux | rg -o -- '--config[= ]\\S+' | head -n 1 | sed -E 's/^--config[= ]//'")"
if [ -n "$ODOO_CONF_PATH" ]; then
  ODOO_LOG_PATH="$(run_cmd "rg -n '^\\s*logfile\\s*=' \"$ODOO_CONF_PATH\" | head -n 1 | awk -F= '{print \$2}' | xargs")"
  if [ -n "$ODOO_LOG_PATH" ]; then
    ODOO_OUT="$(run_cmd "tail -n 250 \"$ODOO_LOG_PATH\"")"
  fi
fi
if [ -z "$ODOO_OUT" ] && [ -d /var/log/nginx ]; then
  # Some stacks write Odoo logs through Nginx-managed files (odoo.error.log, etc.).
  ODOO_OUT="$(tail_newest "/var/log/nginx/odoo*.log /var/log/nginx/*odoo*.log" 5 300)"
fi
for f in /var/log/odoo/odoo.log /var/log/odoo/*.log /var/log/odoo.log /opt/odoo/log/*.log; do
  if [ -z "$ODOO_OUT" ] && [ -f "$f" ]; then
    ODOO_OUT="$(run_cmd "tail -n 250 \"$f\"")"
    [ -n "$ODOO_OUT" ] && break
  fi
done
if [ -z "$ODOO_OUT" ]; then
  ODOO_OUT="$(run_cmd "journalctl -u odoo -u odoo.service -u odoo-server -n 250 --no-pager")"
fi
if [ -z "$ODOO_OUT" ]; then
  ODOO_OUT="$(docker ps --format '{{.Names}}' 2>/dev/null | rg -i 'odoo' | head -n 1 | xargs -I{} docker logs --tail 250 {} 2>/dev/null || true)"
fi
printf "%s\n" "$ODOO_OUT"
echo "===END_ODOO==="

echo "===BEGIN_PGLOG==="
PGLOG_OUT=""
PGLOG_PATH="$(run_cmd "sudo -n -u postgres psql -X -A -t -d postgres -c \"SHOW log_directory;\" | head -n1 | xargs")"
PGLOG_FILE="$(run_cmd "sudo -n -u postgres psql -X -A -t -d postgres -c \"SHOW log_filename;\" | head -n1 | xargs")"
if [ -n "$PGLOG_PATH" ] && [ "$PGLOG_PATH" != "stderr" ]; then
  case "$PGLOG_PATH" in
    /*) PGLOG_GLOB="$PGLOG_PATH/$PGLOG_FILE" ;;
    *) PGLOG_GLOB="/var/lib/postgresql/$PGLOG_PATH/$PGLOG_FILE" ;;
  esac
  PGLOG_OUT="$(run_cmd "ls -1t $PGLOG_GLOB 2>/dev/null | head -n 3 | xargs -r tail -n 250")"
fi
if [ -z "$PGLOG_OUT" ] && [ -d /var/log/postgresql ]; then
  PGLOG_OUT="$(tail_newest "/var/log/postgresql/*.log /var/log/postgresql/postgresql*.log" 5 300)"
fi
if [ -z "$PGLOG_OUT" ]; then
  PGLOG_OUT="$(run_cmd "journalctl -u postgresql -u postgresql.service -u postgresql@* -n 250 --no-pager")"
fi
printf "%s\n" "$PGLOG_OUT"
echo "===END_PGLOG==="

echo "===BEGIN_PGSTATS==="
if command -v psql >/dev/null 2>&1; then
  PSQL_Q1="SELECT queryid,calls,total_exec_time,mean_exec_time,rows,left(query,300) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC NULLS LAST LIMIT 15;"
  PSQL_Q2="SELECT queryid,calls,total_time,mean_time,rows,left(query,300) AS query FROM pg_stat_statements ORDER BY total_time DESC NULLS LAST LIMIT 15;"
  PSQL_CHECK="SELECT extname FROM pg_extension WHERE extname='pg_stat_statements';"
  PSQL_DBS="$(run_cmd "sudo -n -u postgres psql -X -A -t -d postgres -c \"SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate;\"")"
  if [ -n "$SUDO" ]; then
    PGS_OUT=""
    for DB in $PSQL_DBS postgres; do
      [ -z "$DB" ] && continue
      PGS_OUT="$($SUDO -u postgres psql -X -A -F $'\t' -d "$DB" -c "$PSQL_Q1" 2>/dev/null \
        || $SUDO -u postgres psql -X -A -F $'\t' -d "$DB" -c "$PSQL_Q2" 2>/dev/null || true)"
      if [ -n "$PGS_OUT" ]; then
        echo "# database: $DB"
        echo "$PGS_OUT"
        break
      fi
    done
    if [ -z "$PGS_OUT" ]; then
      psql -X -A -F $'\t' -d postgres -c "$PSQL_Q1" 2>/dev/null \
        || psql -X -A -F $'\t' -d postgres -c "$PSQL_Q2" 2>/dev/null \
        || (psql -X -A -F $'\t' -d postgres -c "$PSQL_CHECK" 2>/dev/null | rg -q '^pg_stat_statements$' && echo "pg_stat_statements extension exists but access is denied for current SSH user.") \
        || ($SUDO -u postgres psql -X -A -F $'\t' -d postgres -c "$PSQL_CHECK" 2>/dev/null | rg -q '^pg_stat_statements$' && echo "pg_stat_statements extension exists but query access failed in this environment.") \
        || echo "pg_stat_statements extension is not available or access is denied."
    fi
  else
    psql -X -A -F $'\t' -d postgres -c "$PSQL_Q1" 2>/dev/null \
      || psql -X -A -F $'\t' -d postgres -c "$PSQL_Q2" 2>/dev/null \
      || echo "pg_stat_statements extension is not available or access is denied."
  fi
else
  echo "psql is not installed on remote host."
fi
echo "===END_PGSTATS==="

echo "===BEGIN_ODOO_ADDONS==="
ODOO_ADDONS_OUT=""
if [ -n "$ODOO_CONF_PATH" ] && [ -f "$ODOO_CONF_PATH" ]; then
  ODOO_ADDONS_PATHS="$(run_cmd "rg -n '^\s*addons_path\s*=' \"$ODOO_CONF_PATH\" | head -n 1 | awk -F= '{print \$2}' | xargs")"
  if [ -n "$ODOO_ADDONS_PATHS" ]; then
    ODOO_ADDONS_OUT="$(run_cmd "for p in $(echo \"$ODOO_ADDONS_PATHS\" | tr ',' ' '); do
      echo \"## ADDONS PATH: $p\"
      if [ -d \"$p\" ]; then
        ls -1 \"$p\" 2>/dev/null | head -n 200
      else
        echo \"(path not found)\"
      fi
      echo
    done")"
  fi
fi
if [ -z "$ODOO_ADDONS_OUT" ]; then
  ODOO_ADDONS_OUT="(no addons inventory found)"
fi
printf "%s\n" "$ODOO_ADDONS_OUT"
echo "===END_ODOO_ADDONS==="

echo "===BEGIN_REMOTE_FILES==="
REMOTE_FILES_OUT="$(run_cmd "echo '## NGINX LOG FILES'; ls -1 /var/log/nginx/*.log /var/log/nginx/*odoo*.log 2>/dev/null | head -n 200; \
echo; echo '## ODOO LOG FILES'; ls -1 /var/log/odoo/*.log /var/log/odoo.log /opt/odoo/log/*.log 2>/dev/null | head -n 200; \
echo; echo '## POSTGRES LOG FILES'; ls -1 /var/log/postgresql/*.log /var/log/postgresql/postgresql*.log 2>/dev/null | head -n 200; \
echo; echo '## COMMON ODOO ADDONS PATHS'; ls -1 /odoo/addons /opt/odoo/addons /mnt/extra-addons 2>/dev/null | head -n 200")"
printf "%s\n" "$REMOTE_FILES_OUT"
echo "===END_REMOTE_FILES==="
"""
    res = run_ssh_command(
        host=row.host,
        port=row.port,
        username=row.username,
        auth_mode=row.auth_mode,
        private_key=key,
        password=password,
        command=f"{sudo_env_prefix}{script}",
        timeout_seconds=120,
        get_pty=True,
    )
    emit(f"[Step] Remote diagnostics script finished on '{row.name}' (return code: {res.get('returncode')}).")
    body = (res.get("stdout", "") or "") + ("\n" + res.get("stderr", "") if res.get("stderr") else "")
    emit(f"[Search] Parsing diagnostics sections for '{row.name}' (nginx, odoo, postgres, pg_stat_statements, inventory).")
    nginx_logs = _extract_tagged(body, "NGINX")
    odoo_logs = _extract_tagged(body, "ODOO")
    postgres_logs = _extract_tagged(body, "PGLOG")
    pg_stats = _extract_tagged(body, "PGSTATS")
    odoo_addons = _extract_tagged(body, "ODOO_ADDONS")
    remote_files = _extract_tagged(body, "REMOTE_FILES")
    raw_output = body.strip() or "(no output)"
    if len(raw_output) > 6000:
        raw_output = raw_output[:6000] + "\n\n...[truncated]..."
    emit(f"[Analysis] Running initial error/performance analysis for '{row.name}'.")
    findings = _analyze_remote_text(nginx_logs, odoo_logs, postgres_logs, pg_stats)
    emit(f"[Reasoning] Initial analysis produced {len(findings)} finding(s) for '{row.name}'.")
    remote_log_names = re.findall(r"(?im)^(?:.*\.)?(?:log|log\.\d+|log\.\d+\.gz)$", remote_files)
    if (
        any(x and "-- no entries --" in x.lower() for x in (nginx_logs, odoo_logs, postgres_logs))
        and remote_log_names
    ):
        findings.insert(
            0,
            "Remote log files are present but sampled sections are empty/low-signal; collector now attempts newest-file tails. Re-run diagnosis to refresh.",
        )
    if any(x == "(not found)" for x in (nginx_logs, odoo_logs, postgres_logs, pg_stats)):
        findings.insert(
            0,
            "Diagnostics command output could not be fully parsed into sections; raw SSH output is included below.",
        )
    if res.get("stderr"):
        findings.append("SSH command produced stderr output (see raw output section).")
    emit(f"[Step] Diagnostics extraction complete for '{row.name}'.")
    return {
        "diagnostics": True,
        "status": "ok" if res.get("ok") else "warning",
        "nginx_logs": nginx_logs,
        "odoo_logs": odoo_logs,
        "postgres_logs": postgres_logs,
        "pg_stat_statements": pg_stats,
        "odoo_addons": odoo_addons,
        "remote_files": remote_files,
        "raw_output": raw_output,
        "findings": findings,
        "returncode": res.get("returncode"),
    }


def _extract_remote_log_paths(remote_files: str) -> dict[str, list[str]]:
    buckets: dict[str, list[str]] = {"nginx": [], "odoo": [], "postgres": []}
    current: str | None = None
    for raw in remote_files.splitlines():
        line = raw.strip()
        if not line:
            continue
        upper = line.upper()
        if upper.startswith("## NGINX LOG FILES"):
            current = "nginx"
            continue
        if upper.startswith("## ODOO LOG FILES"):
            current = "odoo"
            continue
        if upper.startswith("## POSTGRES LOG FILES"):
            current = "postgres"
            continue
        if upper.startswith("## "):
            current = None
            continue
        if current is None:
            continue
        if ".log" not in line.lower():
            continue
        path = line
        if not path.startswith("/"):
            base = {
                "nginx": "/var/log/nginx",
                "odoo": "/var/log/odoo",
                "postgres": "/var/log/postgresql",
            }[current]
            path = f"{base}/{path}"
        if path not in buckets[current]:
            buckets[current].append(path)
    return buckets


def _fetch_remote_log_tail(
    row: SshConnectionRow,
    key: str | None,
    password: str | None,
    remote_path: str,
    lines: int = 2000,
) -> str:
    qpath = shlex.quote(remote_path)
    sudo_env_prefix = ""
    if password:
        sudo_env_prefix = f"PC_SUDO_PASS={shlex.quote(password)}; export PC_SUDO_PASS; "
    cmd = (
        "set +e; "
        f"P={qpath}; "
        f"if [ -r \"$P\" ]; then tail -n {int(lines)} \"$P\"; "
        f"elif sudo -n test -r \"$P\" >/dev/null 2>&1; then sudo -n tail -n {int(lines)} \"$P\"; "
        "elif [ -n \"$PC_SUDO_PASS\" ] && printf '%s\\n' \"$PC_SUDO_PASS\" | sudo -S -p '' test -r \"$P\" >/dev/null 2>&1; "
        f"then printf '%s\\n' \"$PC_SUDO_PASS\" | sudo -S -p '' tail -n {int(lines)} \"$P\"; "
        "else echo \"(unreadable) $P\"; fi"
    )
    res = run_ssh_command(
        host=row.host,
        port=row.port,
        username=row.username,
        auth_mode=row.auth_mode,
        private_key=key,
        password=password,
        command=f"{sudo_env_prefix}{cmd}",
        timeout_seconds=120,
        get_pty=True,
    )
    out = (res.get("stdout", "") or "").strip()
    err = (res.get("stderr", "") or "").strip()
    if out:
        return out
    if err:
        return f"(stderr)\n{err}"
    return "(no output)"


def _extract_odoo_addon_candidates(odoo_addons: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    current_path: str | None = None
    for raw in odoo_addons.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("## ADDONS PATH:"):
            current_path = line.split(":", 1)[1].strip()
            continue
        if current_path is None:
            continue
        if line.startswith("("):
            continue
        # Keep module-like names only.
        if not re.match(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$", line):
            continue
        out.append((current_path, line))
    return out


def _score_custom_addon(path: str, module: str) -> int:
    score = 0
    p = path.lower()
    m = module.lower()
    for token in ("extra", "custom", "private", "client", "enterprise", "addons_custom"):
        if token in p:
            score += 4
    for token in ("custom", "pci", "pc_", "client", "purple", "cloud"):
        if token in m:
            score += 3
    for core in ("base", "web", "mail", "sale", "stock", "account", "hr", "purchase"):
        if m == core or m.startswith(f"{core}_"):
            score -= 3
    return score


def _fetch_remote_addon_code_bundle(
    row: SshConnectionRow,
    key: str | None,
    password: str | None,
    addon_abs_path: str,
) -> str:
    qpath = shlex.quote(addon_abs_path)
    sudo_env_prefix = ""
    if password:
        sudo_env_prefix = f"PC_SUDO_PASS={shlex.quote(password)}; export PC_SUDO_PASS; "
    # Build a bounded textual bundle to keep API payload safe.
    cmd = (
        "set +e; "
        f"P={qpath}; "
        "if [ ! -d \"$P\" ]; then echo \"(missing addon path) $P\"; exit 0; fi; "
        "run_cmd(){ "
        "if [ -r \"$1\" ]; then sh -lc \"$2\"; "
        "elif sudo -n test -r \"$1\" >/dev/null 2>&1; then sudo -n sh -lc \"$2\"; "
        "elif [ -n \"$PC_SUDO_PASS\" ] && printf '%s\\n' \"$PC_SUDO_PASS\" | sudo -S -p '' test -r \"$1\" >/dev/null 2>&1; "
        "then printf '%s\\n' \"$PC_SUDO_PASS\" | sudo -S -p '' sh -lc \"$2\"; "
        "else echo \"(unreadable) $1\"; fi; }; "
        "echo \"# ADDON: $P\"; "
        "echo \"## FILE INVENTORY\"; "
        "find \"$P\" -maxdepth 3 -type f "
        "\\( -name '__manifest__.py' -o -name '__init__.py' -o -name '*.py' -o -name '*.xml' -o -name '*.csv' -o -name '*.js' \\) "
        "| head -n 60; "
        "for f in "
        "\"$P/__manifest__.py\" "
        "\"$P/models/__init__.py\" "
        "\"$P/models\"/*.py "
        "\"$P/controllers\"/*.py "
        "\"$P/security/ir.model.access.csv\" "
        "\"$P/views\"/*.xml "
        "; do "
        "[ -e \"$f\" ] || continue; "
        "echo; echo \"## FILE: $f\"; "
        "run_cmd \"$f\" \"sed -n '1,220p' '$f'\"; "
        "done"
    )
    res = run_ssh_command(
        host=row.host,
        port=row.port,
        username=row.username,
        auth_mode=row.auth_mode,
        private_key=key,
        password=password,
        command=f"{sudo_env_prefix}{cmd}",
        timeout_seconds=120,
        get_pty=True,
    )
    out = (res.get("stdout", "") or "").strip()
    err = (res.get("stderr", "") or "").strip()
    body = out if out else ""
    if err:
        body = f"{body}\n\n(stderr)\n{err}".strip()
    if not body:
        body = "(no output)"
    if len(body) > 220_000:
        body = body[:220_000] + "\n\n...[truncated]..."
    return body


def _analyze_addon_code_with_logs(code_text: str, log_findings: list[str]) -> tuple[list[str], list[str]]:
    code_findings: list[str] = []
    correlations: list[str] = []

    def _count(pat: str) -> int:
        return len(re.findall(pat, code_text, flags=re.I))

    sql_exec = _count(r"\b(cr|self\.env\.cr)\.(execute|executemany)\(")
    if sql_exec:
        code_findings.append(f"Code uses raw SQL execution {sql_exec} time(s); review indexing/query plans for slow SQL findings.")
    loops = _count(r"\bfor\s+\w+\s+in\s+.*:\s*(?:\n|\r\n)\s+.*\.(search|write|create)\(")
    if loops:
        code_findings.append(f"Potential ORM-in-loop pattern appears {loops} time(s); may contribute to Odoo latency.")
    no_limit = _count(r"\.search\(\s*\[.*\]\s*\)")
    if no_limit:
        code_findings.append(f"Unbounded ORM searches detected {no_limit} time(s) in sampled code.")
    http_routes = _count(r"@http\.route")
    if http_routes:
        code_findings.append(f"HTTP controllers detected ({http_routes} route decorators); correlate with nginx/timeout findings.")
    sudo_calls = _count(r"\.sudo\(")
    if sudo_calls:
        code_findings.append(f"Frequent sudo() usage detected ({sudo_calls}); review security and heavy-path queries.")

    findings_text = " ".join(log_findings).lower()
    if "slow request" in findings_text or "upstream latency" in findings_text:
        if http_routes:
            correlations.append("Nginx latency findings align with custom HTTP route handlers found in addon code.")
    if "postgresql logs show" in findings_text or "pg_stat_statements" in findings_text:
        if sql_exec or no_limit:
            correlations.append("PostgreSQL performance findings align with raw SQL/unbounded ORM usage in custom addons.")
    if "odoo logs include" in findings_text and (loops or no_limit):
        correlations.append("Odoo slow/timeout indicators align with potentially heavy ORM loop/search patterns.")

    if not code_findings:
        code_findings.append("No obvious high-risk code patterns found in sampled custom addon snippets.")
    if not correlations:
        correlations.append("No strong direct code-to-log correlation found in sampled addon snippets.")
    return code_findings, correlations


def _ssh_row_to_public(row: SshConnectionRow) -> dict[str, Any]:
    shared = list(row.shared_workspace_ids)
    return {
        "id": row.id,
        "name": row.name,
        "host": row.host,
        "port": row.port,
        "username": row.username,
        "auth_mode": row.auth_mode,
        "has_private_key": bool(row.private_key_encrypted),
        "has_password": bool(row.password_encrypted),
        "home_workspace_id": row.home_workspace_id,
        "shared_workspace_ids": shared,
        "is_shared": len(shared) > 1,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


@app.get("/api/connectivity/ssh")
def ssh_connections_list(ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace)) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    rows = list_ssh_connections(user.id, ws_id)
    return {"connections": [_ssh_row_to_public(r) for r in rows]}


@app.get("/api/connectivity/ssh/catalog")
def ssh_connections_catalog(user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    rows = list_ssh_connections_catalog(user.id)
    return {"connections": [_ssh_row_to_public(r) for r in rows]}


@app.post("/api/connectivity/ssh")
def ssh_connections_upsert(
    body: SshConnectionIn,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    auth_mode = body.auth_mode.strip()
    private_key = (body.private_key or "").strip()
    password = (body.password or "").strip()
    if auth_mode == "private_key":
        if not private_key:
            raise HTTPException(status_code=400, detail="Private key is required for private_key mode.")
    elif auth_mode == "password":
        if not password:
            raise HTTPException(status_code=400, detail="Password is required for password mode.")
    elif auth_mode == "private_key_password":
        if not private_key or not password:
            raise HTTPException(status_code=400, detail="Private key and password are required for private_key_password mode.")
    private_key_enc = encrypt_api_key(private_key) if private_key else None
    password_enc = encrypt_api_key(password) if password else None
    cid = upsert_ssh_connection(
        user_id=user.id,
        workspace_id=ws_id,
        name=body.name,
        host=body.host,
        port=body.port,
        username=body.username,
        auth_mode=auth_mode,
        private_key_encrypted=private_key_enc,
        password_encrypted=password_enc,
    )
    row = get_ssh_connection(user.id, ws_id, cid)
    if row is None:
        raise HTTPException(status_code=500, detail="Could not read saved SSH connection.")
    return {"connection": _ssh_row_to_public(row)}


@app.delete("/api/connectivity/ssh/{connection_id}")
def ssh_connections_delete(
    connection_id: int,
    global_delete: bool = Query(default=False, alias="global"),
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    if global_delete:
        if not purge_ssh_connection(user.id, connection_id):
            raise HTTPException(status_code=404, detail="SSH connection not found.")
    elif not delete_ssh_connection(user.id, ws_id, connection_id):
        raise HTTPException(status_code=404, detail="SSH connection not found.")
    return {"status": "ok"}


@app.post("/api/connectivity/ssh/{connection_id}/share")
def ssh_connections_share(
    connection_id: int,
    body: SshConnectionShareBody,
    user: UserRow = Depends(get_current_user),
) -> dict[str, Any]:
    if not share_ssh_connection(user.id, connection_id, body.workspace_id):
        raise HTTPException(status_code=404, detail="SSH connection or workspace not found.")
    row = get_ssh_connection(user.id, body.workspace_id, connection_id)
    if row is None:
        raise HTTPException(status_code=404, detail="SSH connection not found after sharing.")
    return {"connection": _ssh_row_to_public(row)}


@app.put("/api/connectivity/ssh/{connection_id}/workspaces")
def ssh_connections_set_workspaces(
    connection_id: int,
    body: SshConnectionWorkspacesBody,
    user: UserRow = Depends(get_current_user),
) -> dict[str, Any]:
    if not set_ssh_connection_workspaces(user.id, connection_id, body.workspace_ids):
        raise HTTPException(status_code=400, detail="Could not update SSH workspace links.")
    row = next((r for r in list_ssh_connections_catalog(user.id) if r.id == connection_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="SSH connection not found.")
    return {"connection": _ssh_row_to_public(row)}


@app.delete("/api/connectivity/ssh/{connection_id}/share/{workspace_id}")
def ssh_connections_unshare(
    connection_id: int,
    workspace_id: int,
    user: UserRow = Depends(get_current_user),
) -> dict[str, Any]:
    if not unshare_ssh_connection(user.id, connection_id, workspace_id):
        raise HTTPException(
            status_code=400,
            detail="Could not unshare SSH connection (not linked, not found, or last workspace link).",
        )
    return {"status": "ok"}


@app.post("/api/connectivity/ssh/{connection_id}/test")
def ssh_connections_test(
    connection_id: int,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    row = get_ssh_connection(user.id, ws_id, connection_id)
    if row is None:
        raise HTTPException(status_code=404, detail="SSH connection not found.")
    key: str | None = None
    password: str | None = None
    try:
        if row.private_key_encrypted:
            key = decrypt_api_key(row.private_key_encrypted)
        if row.password_encrypted:
            password = decrypt_api_key(row.password_encrypted)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not decrypt SSH credential: {exc}") from exc
    result = run_ssh_command(
        host=row.host,
        port=row.port,
        username=row.username,
        auth_mode=row.auth_mode,
        private_key=key,
        password=password,
        command="echo connected",
        timeout_seconds=20,
    )
    return {
        "ok": bool(result.get("ok")),
        "stdout": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "returncode": result.get("returncode"),
    }


def _run_diagnose_error(
    body: DiagnoseErrorBody,
    user: UserRow,
    ws_id: int,
    emit_activity: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    attached: list[dict[str, Any]] = []
    activity: list[str] = []
    seen: set[str] = set()

    def push_activity(step: str) -> None:
        activity.append(step)
        if emit_activity is not None:
            emit_activity(step)

    push_activity("Starting diagnosis run.")
    for name in body.ssh_connections:
        clean = name.strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        row = next((r for r in list_ssh_connections(user.id, ws_id) if r.name == clean), None)
        if row is None:
            push_activity(f"Skipped SSH connection '{clean}' (not found).")
            continue
        push_activity(f"Using SSH connection '{row.name}' ({row.username}@{row.host}:{row.port}).")
        info: dict[str, Any] = {
            "name": row.name,
            "host": row.host,
            "port": row.port,
            "username": row.username,
            "auth_mode": row.auth_mode,
        }
        key: str | None = None
        password: str | None = None
        try:
            if row.private_key_encrypted:
                key = decrypt_api_key(row.private_key_encrypted)
            if row.password_encrypted:
                password = decrypt_api_key(row.password_encrypted)
        except Exception as exc:
            info["diagnostics"] = True
            info["status"] = "error"
            info["findings"] = [f"Could not decrypt SSH credentials: {exc}"]
            info["nginx_logs"] = "(credential decryption failed)"
            info["odoo_logs"] = "(credential decryption failed)"
            info["postgres_logs"] = "(credential decryption failed)"
            info["pg_stat_statements"] = "(credential decryption failed)"
            attached.append(info)
            push_activity(f"Credential decryption failed for '{row.name}'.")
            continue
        push_activity(f"Collecting remote diagnostics for '{row.name}'.")
        info.update(_collect_remote_diagnostics(row, key, password, emit_activity=push_activity))
        if info.get("diagnostics"):
            root = ensure_named_workspace_layout(user.id, ws_id)
            artifacts_dir = root / "diagnostics" / re.sub(r"[^a-zA-Z0-9._-]+", "_", row.name.strip() or "connection")
            artifacts_dir.mkdir(parents=True, exist_ok=True)
            artifact_map: dict[str, str] = {
                "nginx_logs.txt": str(info.get("nginx_logs", "")),
                "odoo_logs.txt": str(info.get("odoo_logs", "")),
                "postgres_logs.txt": str(info.get("postgres_logs", "")),
                "pg_stat_statements.txt": str(info.get("pg_stat_statements", "")),
                "odoo_addons.txt": str(info.get("odoo_addons", "")),
                "custom_addons_selected.txt": "\n".join(info.get("custom_addons_selected", []) or []),
                "custom_addons_code_bundle.txt": str(info.get("custom_addons_code_bundle", "")),
                "code_findings.txt": "\n".join(info.get("code_findings", []) or []),
                "code_log_correlation.txt": "\n".join(info.get("code_log_correlation", []) or []),
                "remote_files_inventory.txt": str(info.get("remote_files", "")),
                "raw_output.txt": str(info.get("raw_output", "")),
            }
            artifact_paths: list[str] = []
            for name, content in artifact_map.items():
                p = artifacts_dir / name
                p.write_text(content or "", encoding="utf-8")
                artifact_paths.append(
                    f"users/{user.id}/w/{ws_id}/diagnostics/{artifacts_dir.name}/{name}"
                )
            push_activity(f"Saved base diagnostic artifacts for '{row.name}'.")

            # Pull remote log files into workspace over SSH, then analyze those local copies.
            discovered = _extract_remote_log_paths(str(info.get("remote_files", "")))
            push_activity(
                f"[Search] Found remote log candidates for '{row.name}': "
                f"nginx={len(discovered['nginx'])}, odoo={len(discovered['odoo'])}, postgres={len(discovered['postgres'])}."
            )
            downloaded_by_kind: dict[str, list[str]] = {"nginx": [], "odoo": [], "postgres": []}
            for kind, paths in discovered.items():
                picked = paths[:4]
                if picked:
                    push_activity(f"Downloading {kind} logs for '{row.name}' ({len(picked)} files).")
                for idx, remote_path in enumerate(picked, start=1):
                    push_activity(
                        f"Downloading {kind} log {idx}/{len(picked)} for '{row.name}': {remote_path}"
                    )
                    payload = _fetch_remote_log_tail(row, key, password, remote_path, lines=2000)
                    safe_base = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(remote_path).name or f"{kind}_{idx}.log")
                    local_name = f"remote_{kind}_{idx}_{safe_base}.txt"
                    lp = artifacts_dir / local_name
                    lp.write_text(payload, encoding="utf-8")
                    rel_local = f"users/{user.id}/w/{ws_id}/diagnostics/{artifacts_dir.name}/{local_name}"
                    artifact_paths.append(rel_local)
                    downloaded_by_kind[kind].append(payload)
                    push_activity(
                        f"[Download] Saved downloaded {kind} log for '{row.name}' as '{local_name}' "
                        f"({len(payload.encode('utf-8'))} bytes)."
                    )
            if any(downloaded_by_kind.values()):
                nginx_text = "\n\n".join(downloaded_by_kind["nginx"]).strip() or str(info.get("nginx_logs", ""))
                odoo_text = "\n\n".join(downloaded_by_kind["odoo"]).strip() or str(info.get("odoo_logs", ""))
                pg_text = "\n\n".join(downloaded_by_kind["postgres"]).strip() or str(info.get("postgres_logs", ""))
                info["nginx_logs"] = nginx_text
                info["odoo_logs"] = odoo_text
                info["postgres_logs"] = pg_text
                push_activity(f"Analyzing downloaded files for '{row.name}' (error checks).")
                push_activity(f"Analyzing downloaded files for '{row.name}' (performance checks).")
                info["findings"] = _analyze_remote_text(
                    nginx_text,
                    odoo_text,
                    pg_text,
                    str(info.get("pg_stat_statements", "")),
                )
                push_activity(
                    f"[Reasoning] Post-download analysis for '{row.name}' produced "
                    f"{len(info['findings'])} finding(s)."
                )
                for finding in info["findings"][:8]:
                    push_activity(f"[Reasoning] {finding}")
                push_activity(f"Re-analyzed downloaded logs for '{row.name}' (error + performance checks).")
            else:
                push_activity(
                    f"No downloadable logs found for '{row.name}'; using base diagnostics for analysis."
                )

            addon_candidates = _extract_odoo_addon_candidates(str(info.get("odoo_addons", "")))
            ranked = sorted(addon_candidates, key=lambda x: _score_custom_addon(x[0], x[1]), reverse=True)
            selected = [x for x in ranked if _score_custom_addon(x[0], x[1]) > 0][:5]
            if not selected:
                selected = ranked[:3]
            selected_labels = [f"{p}/{m}" for p, m in selected]
            info["custom_addons_selected"] = selected_labels
            if selected:
                push_activity(
                    f"[Search] Selected {len(selected)} custom addon(s) for code-centric diagnostics on '{row.name}'."
                )
                bundles: list[str] = []
                for path, module in selected:
                    addon_path = f"{path.rstrip('/')}/{module}"
                    push_activity(f"[Download] Fetching addon source snapshot: {addon_path}")
                    bundle = _fetch_remote_addon_code_bundle(row, key, password, addon_path)
                    bundles.append(bundle)
                code_bundle = "\n\n".join(bundles).strip()
                info["custom_addons_code_bundle"] = code_bundle
                push_activity(f"[Analysis] Running code-centric analysis for '{row.name}'.")
                code_findings, code_corr = _analyze_addon_code_with_logs(code_bundle, list(info.get("findings", [])))
                info["code_findings"] = code_findings
                info["code_log_correlation"] = code_corr
                for item in code_findings[:6]:
                    push_activity(f"[Reasoning][Code] {item}")
                for item in code_corr[:6]:
                    push_activity(f"[Reasoning][Correlation] {item}")
            else:
                info["custom_addons_code_bundle"] = "(no custom addons candidates found)"
                info["code_findings"] = ["No custom addons discovered from remote inventory."]
                info["code_log_correlation"] = ["Code/log correlation skipped because no addons were selected."]
                push_activity(f"[Search] No custom addon candidates found for '{row.name}'.")
            info["artifact_paths"] = artifact_paths
        attached.append(info)
    if body.generate_report:
        push_activity("Compiling final report with all collected diagnostics, downloads, and analysis.")
        rendered = _write_issue_analysis_report(body.context, user.id, ws_id, attached, activity)
        activity = list(rendered["activity"])
        if emit_activity is not None:
            emit_activity("Report generated.")
        return {
            "status": "ok",
            "path": rendered["path"],
            "name": rendered["name"],
            "ssh_connections": attached,
            "activity": activity,
        }

    push_activity("Deferring artifact generation until after prompt execution.")
    followup_prompt = build_diagnose_followup_digest(body.context, attached, activity)
    _diagnose_state_path(user.id, ws_id).write_text(
        json.dumps(
            {
                "context": body.context,
                "ssh_connections_data": attached,
                "activity": activity,
                "followup_prompt": followup_prompt,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return {
        "status": "ok",
        "name": "diagnose_state",
        "ssh_connections": attached,
        "activity": activity,
        "followup_prompt": followup_prompt,
    }


@app.post("/api/tools/plantuml/render")
def tools_plantuml_render(
    body: PlantUmlRenderBody,
    _user: UserRow = Depends(get_current_user),
) -> Response:
    """Proxy to a PlantUML server so the browser can embed diagrams without third-party CORS."""
    source = body.source.strip()
    if not source:
        raise HTTPException(status_code=400, detail="source must not be empty.")
    payload = _fetch_plantuml_image(source, body.format)
    if body.format == "svg":
        return Response(content=payload, media_type="image/svg+xml; charset=utf-8")
    return Response(content=payload, media_type="image/png")


@app.post("/api/tools/diagnose-error")
def tools_diagnose_error(
    body: DiagnoseErrorBody,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    return _run_diagnose_error(body, user, ws_id)


@app.post("/api/tools/diagnose-error/render-report")
def tools_diagnose_error_render_report(
    body: DiagnoseRenderReportBody,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    context = body.context
    attached = list(body.ssh_connections_data)
    activity = list(body.activity)
    if not attached or not activity:
        state_path = _diagnose_state_path(user.id, ws_id)
        if not state_path.exists():
            raise HTTPException(status_code=400, detail="No saved diagnose state found for this workspace.")
        try:
            saved = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not read saved diagnose state: {exc}") from exc
        if not isinstance(saved, dict):
            raise HTTPException(status_code=500, detail="Saved diagnose state is invalid.")
        context = str(saved.get("context", context))
        attached = list(saved.get("ssh_connections_data", attached) or [])
        activity = list(saved.get("activity", activity) or [])
        if not attached and not activity:
            raise HTTPException(status_code=400, detail="Saved diagnose state is empty.")

    assistant_summary = (body.assistant_summary or "").strip()
    if not assistant_summary:
        # Fallback: pull latest assistant message from persisted chat history.
        chat_path = _chat_messages_path(user.id, ws_id)
        try:
            if chat_path.exists():
                raw = json.loads(chat_path.read_text(encoding="utf-8"))
                msgs = raw.get("messages", []) if isinstance(raw, dict) else []
                if isinstance(msgs, list):
                    for m in reversed(msgs):
                        if not isinstance(m, dict):
                            continue
                        if m.get("role") != "assistant":
                            continue
                        content = str(m.get("content", "")).strip()
                        if not content:
                            continue
                        if content.startswith("**Error:**"):
                            continue
                        assistant_summary = content
                        break
        except Exception:
            # Keep empty summary; report renderer will show fallback text.
            pass

    rendered = _write_issue_analysis_report(
        context,
        user.id,
        ws_id,
        attached,
        activity,
        assistant_summary,
    )
    return {"status": "ok", "path": rendered["path"], "name": rendered["name"], "activity": rendered["activity"]}


@app.post("/api/tools/diagnose-error/stream")
async def tools_diagnose_error_stream(
    body: DiagnoseErrorBody,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> StreamingResponse:
    user, ws_id, _ws = ctx
    # Hard guard: interactive stream mode never generates the final HTML report.
    body.generate_report = False

    async def event_stream() -> AsyncIterator[bytes]:
        q: queue.Queue[bytes | None] = queue.Queue()

        def worker() -> None:
            try:
                def emit(step: str) -> None:
                    ev = {"type": "activity", "step": step}
                    q.put(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8"))

                emit("Interactive mode enabled: final issue_analysis report generation is deferred.")
                out = _run_diagnose_error(body, user, ws_id, emit_activity=emit)
                q.put(f"data: {json.dumps({'type': 'result', 'result': out}, ensure_ascii=False)}\n\n".encode("utf-8"))
            except Exception as exc:
                q.put(
                    f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n".encode("utf-8")
                )
            finally:
                q.put(f"data: {json.dumps({'type': 'done'})}\n\n".encode("utf-8"))
                q.put(None)

        threading.Thread(target=worker, daemon=True).start()
        while True:
            chunk = await asyncio.to_thread(q.get)
            if chunk is None:
                break
            yield chunk

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/workspaces")
def workspaces_list(user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    ensure_user_workspaces_ready(user.id)
    rows = list_workspaces(user.id)
    u = get_user_by_id(user.id)
    assert u is not None
    return {
        "workspaces": [{"id": w.id, "name": w.name, "created_at": w.created_at} for w in rows],
        "active_id": u.active_workspace_id,
    }


@app.post("/api/workspaces")
def workspaces_create(body: CreateWorkspaceBody, user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    ensure_user_workspaces_ready(user.id)
    wid = create_workspace(user.id, body.name)
    ensure_named_workspace_layout(user.id, wid)
    ws = get_workspace(wid, user.id)
    return {"id": wid, "name": ws.name if ws else body.name.strip()[:128]}


@app.post("/api/workspaces/{workspace_id}/activate")
def workspaces_activate(workspace_id: int, user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    ensure_user_workspaces_ready(user.id)
    if not set_active_workspace(user.id, workspace_id):
        raise HTTPException(status_code=404, detail="Workspace not found.")
    return {"status": "ok", "active_id": workspace_id}


@app.delete("/api/workspaces/{workspace_id}")
def workspaces_delete(workspace_id: int, user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    ensure_user_workspaces_ready(user.id)
    ws_root = named_workspace_root(user.id, workspace_id)
    deleted, active_id = delete_workspace(user.id, workspace_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Workspace not found.")

    remove_workspace_session(user.id, workspace_id)

    # Best effort filesystem cleanup for that workspace subtree.
    if ws_root.exists():
        shutil.rmtree(ws_root, ignore_errors=True)
        w_parent = ws_root.parent
        try:
            if w_parent.exists() and not any(w_parent.iterdir()):
                w_parent.rmdir()
        except OSError:
            pass
    return {"status": "ok", "active_id": active_id}


_web_dist = BASE_DIR / "web" / "dist"
if _web_dist.is_dir():

    @app.get("/")
    def spa_index() -> FileResponse:
        return FileResponse(
            path=str(_web_dist / "index.html"),
            media_type="text/html",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )

    app.mount(
        "/",
        StaticFiles(directory=str(_web_dist), html=True),
        name="spa",
    )
