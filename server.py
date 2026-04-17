"""HTTP API for chat3: streams agent events (SSE) for the React UI."""

from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import Iterator
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel, Field, model_validator

from chat3 import BASE_DIR, MODEL, WORKSPACE_DIR, ensure_dirs, iter_agent_turn

app = FastAPI(title="chat3", version="1.0.0")

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

MAX_ATTACHMENT_BYTES = 512 * 1024
MAX_ATTACHMENTS = 5
MAX_TOTAL_ATTACHMENTS_BYTES = 2 * 1024 * 1024


class Attachment(BaseModel):
    name: str = Field(..., max_length=255)
    media_type: str = Field(default="application/octet-stream", max_length=120)
    data_base64: str = Field(..., min_length=1, max_length=MAX_ATTACHMENT_BYTES * 2 + 1024)


def sanitize_filename(name: str) -> str:
    base = Path(name).name.replace("\x00", "")
    if not base or base in (".", ".."):
        return "unnamed"
    return base[:200]


def format_attachment_block(name: str, media_type: str, raw: bytes) -> str:
    mt = media_type.strip() or "application/octet-stream"
    safe_name = sanitize_filename(name)
    text_like = mt.startswith("text/") or mt in ("application/json", "application/xml")
    if text_like:
        try:
            body = raw.decode("utf-8")
        except UnicodeDecodeError:
            body = raw.decode("utf-8", errors="replace")
        return f"---\n**Attached file:** `{safe_name}` (`{mt}`)\n\n```text\n{body}\n```"
    b64 = base64.b64encode(raw).decode()
    return f"---\n**Attached file:** `{safe_name}` (`{mt}`)\n\n```base64\n{b64}\n```"


def expand_user_message(text: str, attachments: list[Attachment]) -> str:
    parts: list[str] = []
    if text.strip():
        parts.append(text.strip())
    total = 0
    for i, a in enumerate(attachments):
        if i >= MAX_ATTACHMENTS:
            raise HTTPException(
                status_code=400,
                detail=f"Too many attachments (max {MAX_ATTACHMENTS}).",
            )
        try:
            raw = base64.b64decode(a.data_base64, validate=False)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"Invalid base64 for {a.name!r}.") from exc
        if len(raw) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Attachment {a.name!r} exceeds {MAX_ATTACHMENT_BYTES} bytes.",
            )
        total += len(raw)
        if total > MAX_TOTAL_ATTACHMENTS_BYTES:
            raise HTTPException(status_code=400, detail="Total attachment size too large.")
        parts.append(format_attachment_block(a.name, a.media_type, raw))
    return "\n\n".join(parts)


class ChatMessage(BaseModel):
    role: str
    content: str = Field(default="", max_length=500_000)
    attachments: list[Attachment] | None = None

    @model_validator(mode="after")
    def _validate_message(self) -> ChatMessage:
        if self.role not in ("user", "assistant"):
            raise ValueError(f"Invalid role: {self.role}")
        if self.role == "assistant" and self.attachments:
            raise ValueError("Attachments are only allowed on user messages.")
        if self.role == "user":
            has_att = bool(self.attachments and len(self.attachments) > 0)
            if not self.content.strip() and not has_att:
                raise ValueError("User message must include text and/or attachments.")
        return self


class ChatBody(BaseModel):
    messages: list[ChatMessage] = Field(..., max_length=300)


@app.on_event("startup")
def _startup() -> None:
    ensure_dirs()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/meta")
def meta() -> dict[str, str]:
    return {
        "model": MODEL,
        "workspace": str(WORKSPACE_DIR),
        "base_dir": str(BASE_DIR),
    }


def prepare_history(body: ChatBody) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    for m in body.messages:
        if m.role == "user" and m.attachments:
            content = expand_user_message(m.content, m.attachments)
        else:
            content = m.content
        history.append({"role": m.role, "content": content})
    return history


def _sse_events(client: OpenAI, history: list[dict[str, str]]) -> Iterator[bytes]:
    try:
        for ev in iter_agent_turn(client, history):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8")
        yield f"data: {json.dumps({'type': 'done'})}\n\n".encode("utf-8")
    except Exception as exc:
        err = {"type": "error", "message": str(exc)}
        yield f"data: {json.dumps(err)}\n\n".encode("utf-8")


@app.post("/api/chat/stream")
def chat_stream(body: ChatBody) -> StreamingResponse:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY is not set on the server.",
        )
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty.")
    history = prepare_history(body)
    client = OpenAI()
    return StreamingResponse(
        _sse_events(client, history),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


_web_dist = BASE_DIR / "web" / "dist"
if _web_dist.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(_web_dist), html=True),
        name="spa",
    )
