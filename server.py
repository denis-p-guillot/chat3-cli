"""HTTP API for chat3: streams agent events (SSE) for the React UI."""

from __future__ import annotations

import asyncio
import html
import json
import os
import queue
import re
import secrets
import threading
from collections.abc import AsyncIterator
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

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
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
from ssh_exec import run_ssh_command
from user_crypto import decrypt_api_key, encrypt_api_key
from user_db import (
    UserRow,
    SshConnectionRow,
    WorkspaceRow,
    create_workspace,
    delete_ssh_connection,
    ensure_user_workspaces_ready,
    get_user_by_id,
    get_ssh_connection,
    get_workspace,
    init_db,
    list_ssh_connections,
    list_workspaces,
    set_active_workspace,
    upsert_ssh_connection,
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
MAX_WORKSPACE_LIST_ENTRIES = 800


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
                        for ev in iter_agent_turn(client, history):
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


def _render_issue_analysis_html(
    context: str,
    user_id: int,
    workspace_id: int,
    ssh_connections: list[dict[str, Any]],
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
    remote_cards = "".join(
        f"""
    <section class="section">
      <h2>Remote Diagnostics: {html.escape(str(c.get('name', 'unknown')))}</h2>
      <p><strong>Target:</strong> {html.escape(str(c.get('username', '')))}@{html.escape(str(c.get('host', '')))}:{int(c.get('port', 22))}</p>
      <p><strong>Status:</strong> {html.escape(str(c.get('status', 'unknown')))}</p>
      <h3>Findings</h3>
      <ul>{"".join(f"<li>{html.escape(x)}</li>" for x in c.get('findings', [])) or "<li>No automatic findings.</li>"}</ul>
      <h3>Nginx logs</h3>
      <pre>{html.escape(str(c.get('nginx_logs', '(no data)')))}</pre>
      <h3>Odoo logs</h3>
      <pre>{html.escape(str(c.get('odoo_logs', '(no data)')))}</pre>
      <h3>PostgreSQL logs</h3>
      <pre>{html.escape(str(c.get('postgres_logs', '(no data)')))}</pre>
      <h3>pg_stat_statements</h3>
      <pre>{html.escape(str(c.get('pg_stat_statements', '(no data)')))}</pre>
      <h3>Odoo addons inventory</h3>
      <pre>{html.escape(str(c.get('odoo_addons', '(no data)')))}</pre>
      <h3>Remote files inventory</h3>
      <pre>{html.escape(str(c.get('remote_files', '(no data)')))}</pre>
      <h3>Downloaded artifacts (workspace paths)</h3>
      <pre>{html.escape(str("\n".join(c.get('artifact_paths', [])) if c.get('artifact_paths') else '(none)'))}</pre>
      <h3>Raw SSH Output (debug)</h3>
      <pre>{html.escape(str(c.get('raw_output', '(no output)')))}</pre>
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
{remote_cards}
    <section class="section">
      <h2>Next Actions</h2>
      <p>Use this report as the baseline artifact. Add concrete findings, stack traces, and patch recommendations.</p>
    </section>
    <div class="footer">
      Generated at {now} · Styled for PurpleCloud<br/>
      <a href="https://purple-cloud.ai/" target="_blank" rel="noopener noreferrer">purple-cloud.ai</a>
    </div>
  </div>
</body>
</html>
"""


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


def _collect_remote_diagnostics(row: SshConnectionRow, key: str | None, password: str | None) -> dict[str, Any]:
    script = r"""
set +e
SUDO=""
if sudo -n true >/dev/null 2>&1; then
  SUDO="sudo -n"
fi
run_cmd() {
  if [ -n "$SUDO" ]; then
    $SUDO sh -lc "$1" 2>/dev/null || true
  else
    sh -lc "$1" 2>/dev/null || true
  fi
}

echo "===BEGIN_NGINX==="
NGINX_OUT=""
NGINX_ERR_PATH="$(run_cmd "nginx -T | rg -o \"error_log\\s+[^;]+\" | awk '{print \$2}' | head -n 1")"
NGINX_ACC_PATH="$(run_cmd "nginx -T | rg -o \"access_log\\s+[^;]+\" | awk '{print \$2}' | head -n 1")"
if [ -n "$NGINX_ERR_PATH" ] || [ -n "$NGINX_ACC_PATH" ]; then
  NGINX_OUT="$(run_cmd "tail -n 200 \"$NGINX_ERR_PATH\" \"$NGINX_ACC_PATH\"")"
fi
if [ -z "$NGINX_OUT" ] && [ -d /var/log/nginx ]; then
  NGINX_OUT="$(run_cmd "tail -n 200 /var/log/nginx/error.log /var/log/nginx/access.log /var/log/nginx/*error*.log /var/log/nginx/*access*.log")"
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
  PGLOG_OUT="$(run_cmd "tail -n 250 /var/log/postgresql/*.log /var/log/postgresql/postgresql*.log")"
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
  if [ -n "$SUDO" ]; then
    $SUDO -u postgres psql -X -A -F $'\t' -d postgres -c "$PSQL_Q1" 2>/dev/null \
      || $SUDO -u postgres psql -X -A -F $'\t' -d postgres -c "$PSQL_Q2" 2>/dev/null \
      || psql -X -A -F $'\t' -d postgres -c "$PSQL_Q1" 2>/dev/null \
      || psql -X -A -F $'\t' -d postgres -c "$PSQL_Q2" 2>/dev/null \
      || (psql -X -A -F $'\t' -d postgres -c "$PSQL_CHECK" 2>/dev/null | rg -q '^pg_stat_statements$' && echo "pg_stat_statements extension exists but access is denied for current SSH user.") \
      || ($SUDO -u postgres psql -X -A -F $'\t' -d postgres -c "$PSQL_CHECK" 2>/dev/null | rg -q '^pg_stat_statements$' && echo "pg_stat_statements extension exists but query access failed in this environment.") \
      || echo "pg_stat_statements extension is not available or access is denied."
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
REMOTE_FILES_OUT="$(run_cmd "echo '## NGINX LOG FILES'; ls -1 /var/log/nginx 2>/dev/null | head -n 200; \
echo; echo '## ODOO LOG FILES'; ls -1 /var/log/odoo 2>/dev/null | head -n 200; \
echo; echo '## POSTGRES LOG FILES'; ls -1 /var/log/postgresql 2>/dev/null | head -n 200; \
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
        command=script,
        timeout_seconds=120,
    )
    body = (res.get("stdout", "") or "") + ("\n" + res.get("stderr", "") if res.get("stderr") else "")
    nginx_logs = _extract_tagged(body, "NGINX")
    odoo_logs = _extract_tagged(body, "ODOO")
    postgres_logs = _extract_tagged(body, "PGLOG")
    pg_stats = _extract_tagged(body, "PGSTATS")
    odoo_addons = _extract_tagged(body, "ODOO_ADDONS")
    remote_files = _extract_tagged(body, "REMOTE_FILES")
    raw_output = body.strip() or "(no output)"
    if len(raw_output) > 6000:
        raw_output = raw_output[:6000] + "\n\n...[truncated]..."
    findings = _analyze_remote_text(nginx_logs, odoo_logs, postgres_logs, pg_stats)
    if any(x == "(not found)" for x in (nginx_logs, odoo_logs, postgres_logs, pg_stats)):
        findings.insert(
            0,
            "Diagnostics command output could not be fully parsed into sections; raw SSH output is included below.",
        )
    if res.get("stderr"):
        findings.append("SSH command produced stderr output (see raw output section).")
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


def _ssh_row_to_public(row: SshConnectionRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "host": row.host,
        "port": row.port,
        "username": row.username,
        "auth_mode": row.auth_mode,
        "has_private_key": bool(row.private_key_encrypted),
        "has_password": bool(row.password_encrypted),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


@app.get("/api/connectivity/ssh")
def ssh_connections_list(user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    rows = list_ssh_connections(user.id)
    return {"connections": [_ssh_row_to_public(r) for r in rows]}


@app.post("/api/connectivity/ssh")
def ssh_connections_upsert(body: SshConnectionIn, user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
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
        name=body.name,
        host=body.host,
        port=body.port,
        username=body.username,
        auth_mode=auth_mode,
        private_key_encrypted=private_key_enc,
        password_encrypted=password_enc,
    )
    row = get_ssh_connection(user.id, cid)
    if row is None:
        raise HTTPException(status_code=500, detail="Could not read saved SSH connection.")
    return {"connection": _ssh_row_to_public(row)}


@app.delete("/api/connectivity/ssh/{connection_id}")
def ssh_connections_delete(connection_id: int, user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    if not delete_ssh_connection(user.id, connection_id):
        raise HTTPException(status_code=404, detail="SSH connection not found.")
    return {"status": "ok"}


@app.post("/api/connectivity/ssh/{connection_id}/test")
def ssh_connections_test(connection_id: int, user: UserRow = Depends(get_current_user)) -> dict[str, Any]:
    row = get_ssh_connection(user.id, connection_id)
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


@app.post("/api/tools/diagnose-error")
def tools_diagnose_error(
    body: DiagnoseErrorBody,
    ctx: tuple[UserRow, int, WorkspaceRow] = Depends(current_user_workspace),
) -> dict[str, Any]:
    user, ws_id, _ws = ctx
    attached: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in body.ssh_connections:
        clean = name.strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        row = next((r for r in list_ssh_connections(user.id) if r.name == clean), None)
        if row is None:
            continue
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
            continue
        info.update(_collect_remote_diagnostics(row, key, password))
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
            info["artifact_paths"] = artifact_paths
        attached.append(info)
    root = ensure_named_workspace_layout(user.id, ws_id)
    out_path = root / "issue_analysis.html"
    out_path.write_text(
        _render_issue_analysis_html(body.context, user.id, ws_id, attached),
        encoding="utf-8",
    )
    rel = f"users/{user.id}/w/{ws_id}/issue_analysis.html"
    return {"status": "ok", "path": rel, "name": "issue_analysis.html", "ssh_connections": attached}


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
