"""HTTP API for chat3: streams agent events (SSE) for the React UI."""

from __future__ import annotations

import json
import os
import secrets
from collections.abc import Iterator
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

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel, Field, model_validator

from auth_api import get_current_user, get_openai_key_for_user, router as auth_router
from chat3 import (
    BASE_DIR,
    MODEL,
    WORKSPACE_DIR,
    ensure_dirs,
    ensure_named_workspace_layout,
    iter_agent_turn,
    workspace_session,
)
from local_file_analysis import analyze_workspace_file
from user_db import (
    UserRow,
    WorkspaceRow,
    create_workspace,
    ensure_user_workspaces_ready,
    get_user_by_id,
    get_workspace,
    init_db,
    list_workspaces,
    set_active_workspace,
)

app = FastAPI(title="PurpleCloud Brain AI", version="1.0.0")

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
MAX_FILE_BYTES = 500 * 1024 * 1024
MAX_ATTACHMENTS = 20
MAX_TOTAL_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024


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
    return (
        "---\n"
        "**User attachment (parsed and summarized locally — you do not receive the full file as raw bytes):**\n\n"
        f"{body}\n"
    )


def expand_user_message_with_workspace(text: str, workspace_files: list[str], user_id: int) -> str:
    parts: list[str] = []
    if text.strip():
        parts.append(text.strip())
    if len(workspace_files) > MAX_ATTACHMENTS:
        parts.append(f"[Too many workspace files (max {MAX_ATTACHMENTS}); extras ignored.]")
        workspace_files = workspace_files[:MAX_ATTACHMENTS]
    for rel in workspace_files:
        parts.append(expand_workspace_file(rel, user_id))
    return "\n\n".join(parts)


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
    ensure_dirs()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/meta")
def meta(ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace)) -> dict[str, str]:
    user, ws_id, ws = ctx
    root = ensure_named_workspace_layout(user.id, ws_id)
    return {
        "model": MODEL,
        "workspace": str(WORKSPACE_DIR),
        "base_dir": str(BASE_DIR),
        "user_workspace": f"users/{user.id}/w/{ws_id}",
        "user_workspace_abs": str(root),
        "active_workspace_id": str(ws_id),
        "active_workspace_name": ws.name,
    }


def prepare_history(body: ChatBody, user_id: int) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    for m in body.messages:
        if m.role == "user" and m.workspace_files:
            content = expand_user_message_with_workspace(m.content, list(m.workspace_files), user_id)
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
    user, ws_id, _ws = ctx
    raw = json.dumps({"messages": body.messages}, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_CHAT_JSON_BYTES:
        raise HTTPException(status_code=400, detail="Chat history payload is too large.")
    path = _chat_messages_path(user.id, ws_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(raw, encoding="utf-8")
    return {"status": "ok"}


@app.post("/api/chat/stream")
def chat_stream(
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

    def event_stream() -> Iterator[bytes]:
        with workspace_session(user.id, ws_id):
            try:
                history = prepare_history(body, user.id)
            except Exception as exc:
                err = {"type": "error", "message": f"Could not prepare messages: {exc}"}
                yield f"data: {json.dumps(err)}\n\n".encode("utf-8")
                yield f"data: {json.dumps({'type': 'done'})}\n\n".encode("utf-8")
                return
            try:
                for ev in iter_agent_turn(client, history):
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8")
                yield f"data: {json.dumps({'type': 'done'})}\n\n".encode("utf-8")
            except Exception as exc:
                err = {"type": "error", "message": str(exc)}
                yield f"data: {json.dumps(err)}\n\n".encode("utf-8")

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
                                detail=f"File too large (max {MAX_FILE_BYTES // (1024 * 1024)} MB per file).",
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


class CreateWorkspaceBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)


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


_web_dist = BASE_DIR / "web" / "dist"
if _web_dist.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(_web_dist), html=True),
        name="spa",
    )
