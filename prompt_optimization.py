"""
Token-efficient prompt assembly: attachment budgets, prioritization, diagnose digests.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

# ~30k tokens at ~4 chars/token — tunable
MAX_PROMPT_ATTACHMENT_CHARS = 120_000
# Max files to fully expand per user message (server also stops at char budget)
MAX_AUTO_EXPAND_FILES = 20
MAX_MANIFEST_PATHS = 80
MAX_DIAGNOSE_ACTIVITY_TAIL = 25
MAX_CONTEXT_IN_DIGEST = 8_000

_DIAGNOSE_HIGHLIGHT_RE = re.compile(
    r"\[(?:Reasoning|Analysis|Search)\]|finding|error|failed|root cause",
    re.IGNORECASE,
)


def attachment_priority(rel: str) -> int:
    """Higher score = expand first when budget is limited."""
    low = rel.replace("\\", "/").lower()
    name = low.rsplit("/", 1)[-1]
    score = 0
    if "issue_analysis.html" in low:
        score += 400
    if "diagnostics_summary" in low:
        score += 390
    if "diagnostics/" in low:
        score += 200
    if low.endswith(".log") or ".log." in name:
        score += 80
    if any(x in name for x in ("traceback", "error", "exception", "fatal")):
        score += 160
    if low.endswith((".txt", ".md")):
        score += 80
    if low.endswith((".py", ".xml", ".sql", ".js", ".ts")):
        score += 60
    if low.endswith((".json", ".csv", ".yaml", ".yml")):
        score += 50
    if low.endswith((".tar", ".tar.gz", ".tgz", ".gz", ".zip")):
        score += 40
    if "/uploads/" in low:
        score += 10
    return score


def sort_workspace_files(paths: list[str]) -> list[str]:
    return sorted(paths, key=lambda p: (-attachment_priority(p), p))


def workspace_files_manifest(text: str, workspace_files: list[str]) -> str:
    """Lightweight reference for older user turns (no re-expansion)."""
    parts: list[str] = []
    if text.strip():
        parts.append(text.strip())
    shown = workspace_files[:MAX_MANIFEST_PATHS]
    lines = ["### Workspace files (from this earlier message)", ""]
    lines.append(
        "Full local summaries are omitted here to save context. "
        "Use `grep_files`, `fs_read_file`, or `fs_read_file_chunk` (root `workspace`) if needed."
    )
    lines.append("")
    for rel in shown:
        lines.append(f"- `{rel}`")
    if len(workspace_files) > len(shown):
        lines.append(f"- … and {len(workspace_files) - len(shown)} more")
    parts.append("\n".join(lines))
    return "\n\n".join(parts)


def expand_user_message_with_workspace(
    text: str,
    workspace_files: list[str],
    user_id: int,
    expand_file: Callable[[str, int], str],
) -> str:
    """Expand attachments with priority ordering and a global character budget."""
    parts: list[str] = []
    if text.strip():
        parts.append(text.strip())

    if not workspace_files:
        return "\n\n".join(parts)

    if len(workspace_files) > MAX_AUTO_EXPAND_FILES:
        parts.append(
            f"[Note: {len(workspace_files)} workspace file(s) linked; "
            f"up to {MAX_AUTO_EXPAND_FILES} are summarized below by priority. "
            f"Use tools for the rest.]"
        )

    ordered = sort_workspace_files(workspace_files)[:MAX_AUTO_EXPAND_FILES]
    budget = MAX_PROMPT_ATTACHMENT_CHARS
    expanded = 0
    skipped: list[str] = []

    for rel in ordered:
        block = expand_file(rel, user_id)
        block_len = len(block)
        if expanded > 0 and block_len > budget:
            skipped.append(rel)
            continue
        parts.append(block)
        budget -= block_len
        expanded += 1
        if budget <= 0:
            skipped.extend(ordered[expanded:])
            break

    if skipped:
        parts.append(_skipped_files_notice(skipped))

    return "\n\n".join(parts)


def _skipped_files_notice(skipped: list[str]) -> str:
    lines = [
        "### Additional workspace files (not expanded — prompt budget)",
        "",
        f"{len(skipped)} file(s) are on disk but omitted from this prompt to save tokens. "
        "Use `grep_files` or `fs_read_file_chunk` with root `workspace` to inspect them.",
        "",
    ]
    for rel in skipped[:40]:
        lines.append(f"- `{rel}`")
    if len(skipped) > 40:
        lines.append(f"- … and {len(skipped) - 40} more")
    return "\n".join(lines)


def _summarize_activity(activity: list[str]) -> str:
    if not activity:
        return "- (no activity recorded)"

    highlights = [s for s in activity if _DIAGNOSE_HIGHLIGHT_RE.search(s)]
    tail = activity[-MAX_DIAGNOSE_ACTIVITY_TAIL :]

    lines = ["### Run activity (compact)", ""]
    if highlights:
        lines.append("**Key steps:**")
        for step in highlights[:20]:
            lines.append(f"- {step}")
        if len(highlights) > 20:
            lines.append(f"- … and {len(highlights) - 20} more highlighted steps")
        lines.append("")

    # Phase counts
    phases: dict[str, int] = {}
    for step in activity:
        low = step.lower()
        if "downloading" in low:
            phases["downloads"] = phases.get("downloads", 0) + 1
        elif "collecting remote" in low or "saved base diagnostic" in low:
            phases["collection"] = phases.get("collection", 0) + 1
        elif "analyzing" in low:
            phases["analysis"] = phases.get("analysis", 0) + 1
        else:
            phases["other"] = phases.get("other", 0) + 1
    if phases:
        summary = ", ".join(f"{k}: {v}" for k, v in sorted(phases.items()))
        lines.append(f"**Phase counts:** {summary} ({len(activity)} steps total)")
        lines.append("")

    lines.append(f"**Recent steps (last {len(tail)}):**")
    for step in tail:
        lines.append(f"- {step}")

    return "\n".join(lines)


def _format_ssh_digest(attached: list[dict[str, Any]]) -> str:
    if not attached:
        return "### Remote diagnostics\n\nNo SSH connections were run.\n"

    sections: list[str] = ["### Remote diagnostics summary", ""]
    for conn in attached:
        if not conn.get("diagnostics"):
            name = conn.get("name", "unknown")
            sections.append(f"#### {name}\n\nSkipped or failed (no diagnostics payload).\n")
            continue

        name = conn.get("name", "unknown")
        host = conn.get("host", "")
        port = conn.get("port", 22)
        username = conn.get("username", "")
        status = conn.get("status", "unknown")
        sections.append(f"#### {name} (`{username}@{host}:{port}`) — {status}")
        sections.append("")

        findings = list(conn.get("findings") or [])
        if findings:
            sections.append("**Findings:**")
            for f in findings[:12]:
                sections.append(f"- {f}")
            if len(findings) > 12:
                sections.append(f"- … and {len(findings) - 12} more")
            sections.append("")

        code_findings = list(conn.get("code_findings") or [])
        if code_findings:
            sections.append("**Code analysis:**")
            for f in code_findings[:8]:
                sections.append(f"- {f}")
            sections.append("")

        code_corr = list(conn.get("code_log_correlation") or [])
        if code_corr:
            sections.append("**Code/log correlation:**")
            for f in code_corr[:6]:
                sections.append(f"- {f}")
            sections.append("")

        artifacts = list(conn.get("artifact_paths") or [])
        if artifacts:
            sections.append("**Artifacts (workspace paths — use tools, not assumed loaded):**")
            for p in artifacts[:25]:
                sections.append(f"- `{p}`")
            if len(artifacts) > 25:
                sections.append(f"- … and {len(artifacts) - 25} more")
            sections.append("")

    return "\n".join(sections)


def build_diagnose_followup_digest(
    context: str,
    attached: list[dict[str, Any]],
    activity: list[str],
) -> str:
    """Compact prompt for the post-diagnose LLM turn (findings + paths, not full activity log)."""
    ctx = (context or "").strip()
    if len(ctx) > MAX_CONTEXT_IN_DIGEST:
        ctx = ctx[:MAX_CONTEXT_IN_DIGEST] + "\n… [context truncated for prompt budget]"

    parts = [
        "[Diagnose Error — analysis request]",
        "",
        "Automated diagnostics finished. Data below is a **compact digest**; full logs and files are on disk.",
        "Do **not** claim you read entire large files unless a tool returned that content.",
        "",
        "### Provided context",
        ctx or "(none)",
        "",
        _format_ssh_digest(attached),
        "",
        _summarize_activity(activity),
        "",
        "### Your task",
        "1. **Top 5 findings** with evidence (log lines, artifact paths, or code patterns).",
        "2. **Most likely root cause** (hypothesis, confidence, assumptions).",
        "3. **Recommended next actions** (immediate validation/containment).",
        "4. **Remediation plan** (P0/P1/P2, owners, rollback notes).",
        "",
        "Provide analysis text only. Do NOT claim files were updated. "
        "This content will be embedded in `issue_analysis.html`.",
    ]
    return "\n".join(parts)
