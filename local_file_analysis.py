"""
Parse and summarize workspace files locally. The model receives these summaries only,
not raw file contents — it should orchestrate tools for full reads when needed.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import mimetypes
import re
import zipfile
from pathlib import Path
from typing import Any

MAX_ANALYSIS_READ_BYTES = 4 * 1024 * 1024
MAX_SAMPLE_LINES = 60
MAX_SAMPLE_CHARS = 12000

_LOG_ERROR_LINE_RE = re.compile(
    r"\b(error|exception|traceback|fatal|critical|failed|panic|segfault|timeout|refused)\b",
    re.IGNORECASE,
)
_MAX_LOG_CLUSTERS = 12
_MAX_CLUSTER_CONTEXT = 4
_MAX_CLUSTER_SNIPPET_LINES = 10
_LOG_LIKE_SUFFIXES = {".log", ".trace", ".out"}


def _sha256_file_prefix(path: Path, limit: int = 1_048_576) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        h.update(f.read(limit))
    return h.hexdigest()[:16] + "…"


def _is_log_like_path(path: Path) -> bool:
    low = path.name.lower()
    if any(low.endswith(s) for s in _LOG_LIKE_SUFFIXES):
        return True
    return any(tok in low for tok in ("error", "traceback", "odoo", "nginx", "postgres", "pg_"))


def _summarize_log_error_clusters(text: str) -> str | None:
    """Extract compact error/traceback clusters instead of blind head/tail sampling."""
    lines = text.splitlines()
    if len(lines) < 3:
        return None

    hit_indices: list[int] = []
    for i, line in enumerate(lines):
        if _LOG_ERROR_LINE_RE.search(line):
            hit_indices.append(i)
    if not hit_indices:
        return None

    clusters: list[tuple[int, int]] = []
    start = hit_indices[0]
    end = hit_indices[0]
    for idx in hit_indices[1:]:
        if idx <= end + _MAX_CLUSTER_CONTEXT + 1:
            end = idx
        else:
            clusters.append((start, end))
            start = idx
            end = idx
    clusters.append((start, end))

    parts = [
        f"- **Error-line clusters:** {len(hit_indices)} matching lines in {len(lines):,} total "
        f"({len(clusters)} cluster(s) below)"
    ]
    for ci, (s, e) in enumerate(clusters[:_MAX_LOG_CLUSTERS], start=1):
        lo = max(0, s - _MAX_CLUSTER_CONTEXT)
        hi = min(len(lines), e + _MAX_CLUSTER_CONTEXT + 1)
        snippet = lines[lo:hi]
        if len(snippet) > _MAX_CLUSTER_SNIPPET_LINES:
            snippet = snippet[:_MAX_CLUSTER_SNIPPET_LINES] + ["… [cluster truncated]"]
        parts.append(f"- **Cluster {ci}** (lines {lo + 1}–{hi}):")
        parts.append("```text\n" + "\n".join(snippet) + "\n```")
    if len(clusters) > _MAX_LOG_CLUSTERS:
        parts.append(f"- … and {len(clusters) - _MAX_LOG_CLUSTERS} more cluster(s) not shown")
    parts.append(
        "\n*Non-error lines omitted. Use `grep_files` or `fs_read_file_chunk` for the full file.*"
    )
    return "\n".join(parts)


def _sample_text_lines(text: str, max_lines: int = MAX_SAMPLE_LINES, max_chars: int = MAX_SAMPLE_CHARS) -> str:
    lines = text.splitlines()
    if len(lines) <= max_lines and len(text) <= max_chars:
        return text
    head = "\n".join(lines[: max_lines // 2])
    if len(head) > max_chars // 2:
        head = head[: max_chars // 2] + "\n… [truncated]"
    tail = "\n".join(lines[-(max_lines // 4) :]) if len(lines) > max_lines // 2 else ""
    return f"{head}\n\n… ({len(lines)} lines total, sample truncated) …\n\n{tail}"


def _json_shape(obj: Any, max_depth: int = 4, depth: int = 0) -> str:
    if depth > max_depth:
        return "- **Structure:** (too deep)"
    if isinstance(obj, dict):
        keys = list(obj.keys())
        preview = ", ".join(repr(k) for k in keys[:40])
        more = f" … (+{len(keys) - 40} keys)" if len(keys) > 40 else ""
        return f"- **JSON object keys ({len(keys)}):** {preview}{more}"
    if isinstance(obj, list):
        return f"- **JSON array length:** {len(obj)}"
    return f"- **JSON scalar type:** {type(obj).__name__}"


def analyze_workspace_file(path: Path, rel: str) -> str:
    """Return markdown describing local parsing / stats. No API calls."""
    st = path.stat()
    size = st.st_size
    mt = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    parts: list[str] = [
        f"### Local analysis: `{rel}`",
        f"- **Size:** {size:,} bytes",
        f"- **MIME (guess):** `{mt}`",
    ]

    if size == 0:
        parts.append("- **Empty file.**")
        return "\n".join(parts)

    suf = path.suffix.lower()

    if suf == ".zip" and zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path, "r") as zf:
                names = zf.namelist()
                parts.append(f"- **ZIP entries:** {len(names)}")
                parts.append("- **First members (up to 25):**")
                for n in names[:25]:
                    parts.append(f"  - `{n}`")
                if len(names) > 25:
                    parts.append(f"  - … and {len(names) - 25} more")
        except OSError as e:
            parts.append(f"- **ZIP read error:** {e}")
        parts.append(
            "\n*Use tools `archive_list` / `archive_extract` for full listing or extraction; do not invent archive contents.*"
        )
        return "\n".join(parts)

    with path.open("rb") as f:
        prefix = f.read(min(65536, size))

    text_like_suffixes = {
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".md",
        ".txt",
        ".csv",
        ".json",
        ".xml",
        ".html",
        ".htm",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".cfg",
        ".log",
        ".sh",
        ".env",
        ".rs",
        ".go",
        ".java",
        ".kt",
        ".swift",
        ".rb",
        ".php",
        ".css",
        ".scss",
        ".sql",
        ".vue",
        ".svelte",
    }
    if b"\x00" in prefix[:4096] and suf not in text_like_suffixes:
        parts.append("- **Kind:** binary (no UTF-8 text preview)")
        parts.append(f"- **SHA256 prefix:** `{_sha256_file_prefix(path)}`")
        parts.append("\n*Use tools if byte-accurate content is required; do not invent binary data.*")
        return "\n".join(parts)

    to_read = min(size, MAX_ANALYSIS_READ_BYTES)
    with path.open("rb") as f:
        raw = f.read(to_read)
    text = raw.decode("utf-8", errors="replace")
    truncated = size > to_read

    if suf in (".json",) or mt == "application/json":
        if size <= MAX_ANALYSIS_READ_BYTES:
            try:
                obj = json.loads(text)
                parts.append("- **JSON:** valid (parsed locally)")
                parts.append(_json_shape(obj))
            except json.JSONDecodeError as e:
                parts.append(f"- **JSON:** invalid — {e}")
                parts.append("```text\n" + _sample_text_lines(text) + "\n```")
        else:
            parts.append(
                f"- **JSON:** file exceeds local analysis buffer ({MAX_ANALYSIS_READ_BYTES // (1024 * 1024)} MiB); "
                "full parse skipped. Use `fs_read_file` with root `workspace` if needed."
            )
            parts.append("```text\n" + _sample_text_lines(text) + "\n```")
        return "\n".join(parts)

    if suf in (".csv", ".tsv"):
        delim = "\t" if suf == ".tsv" else ","
        try:
            r = csv.reader(io.StringIO(text), delimiter=delim)
            rows: list[list[str]] = []
            for i, row in enumerate(r):
                if i >= 12:
                    break
                rows.append(row)
            if rows:
                header = rows[0]
                parts.append(f"- **Columns ({len(header)}):** {', '.join(header[:20])}")
                parts.append("- **Sample rows:**")
                for row in rows[1:9]:
                    parts.append(f"  - {row[:12]}")
        except Exception as e:  # noqa: BLE001
            parts.append(f"- **CSV parse note:** {e}")
        return "\n".join(parts)

    line_count = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
    parts.append(f"- **Lines (in analyzed portion):** ~{line_count}")
    if truncated:
        parts.append("- **Note:** only the first portion of the file was analyzed locally (size cap).")
    log_clusters = _summarize_log_error_clusters(text) if _is_log_like_path(path) else None
    if log_clusters:
        parts.append("- **Log analysis (error-focused):**")
        parts.append(log_clusters)
    else:
        parts.append("- **Sample (local excerpt):**")
        parts.append("```text\n" + _sample_text_lines(text) + "\n```")
    parts.append(
        "\n*Use `fs_read_file`, `grep_files`, or `fs_read_file_chunk` for authoritative full content.*"
    )
    return "\n".join(parts)
