#!/usr/bin/env python3
from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openai import OpenAI
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.text import Text

MODEL = "gpt-5.4"

SYSTEM_PROMPT = """
You are a helpful technical assistant running in a local CLI.

You have access to filesystem tools, git tools, archive list/extract (tar and zip), grep_files for log search, fs_read_file_chunk for large files, and fs_stat for file metadata.

Allowed roots:
- workspace
- base_dir

Behavior rules:
- Never claim a file or repository was changed unless a tool succeeded.
- Prefer reading files before modifying them when that helps reduce mistakes.
- Always use relative paths within the selected root.
- For destructive actions like deleting files or directories, only do it when the user explicitly asks.
- If the user asks for a modification, perform it using the tools instead of only describing it.
- For Git work, prefer:
  1. inspect repo status
  2. read/edit files
  3. inspect diff
  4. commit changes if requested
- Do not invent repository state.
- Briefly explain what you changed after successful edits.
- Use markdown when useful.

Important stopping rules:
- Use the minimum number of tool calls needed.
- Do not repeat the same tool call with the same arguments unless the user explicitly asks.
- After a successful file change or after gathering enough information to answer, stop calling tools and provide the final answer.
- If a tool returns enough information to answer, respond immediately.
- If a requested action cannot be completed, explain why and stop instead of probing repeatedly.
""".strip()

BASE_DIR = Path(__file__).resolve().parent
HISTORY_DIR = BASE_DIR / "history"
HISTORY_FILE = HISTORY_DIR / "history.json"
WORKSPACE_DIR = BASE_DIR / "workspace"

ALLOWED_ROOTS: dict[str, Path] = {
    "workspace": WORKSPACE_DIR,
    "base_dir": BASE_DIR,
}

READ_MAX_BYTES = 200_000
CHUNK_MAX_BYTES = 500_000
LIST_MAX_ENTRIES = 500
ARCHIVE_MAX_LIST_ENTRIES = 5_000
GREP_MAX_MATCHES = 2_000
MAX_TOOL_ROUNDS = 50
GIT_TIMEOUT_SECONDS = 180

console = Console()


def ensure_dirs() -> None:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_history() -> list[dict[str, Any]]:
    ensure_dirs()

    if not HISTORY_FILE.exists():
        return []

    try:
        with HISTORY_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)

        if not isinstance(data, list):
            console.print("[yellow]Warning:[/yellow] history file is invalid. Starting fresh.")
            return []

        cleaned: list[dict[str, Any]] = []
        for item in data:
            if (
                isinstance(item, dict)
                and isinstance(item.get("role"), str)
                and isinstance(item.get("content"), str)
            ):
                cleaned.append(
                    {
                        "role": item["role"],
                        "content": item["content"],
                        "timestamp": item.get("timestamp", utc_now_iso()),
                    }
                )

        return cleaned

    except Exception as exc:
        console.print(f"[red]Failed to load history:[/red] {exc}")
        return []


def save_history(history: list[dict[str, Any]]) -> None:
    ensure_dirs()

    try:
        with HISTORY_FILE.open("w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        console.print(f"[red]Failed to save history:[/red] {exc}")


def add_message(history: list[dict[str, Any]], role: str, content: str) -> None:
    history.append(
        {
            "role": role,
            "content": content,
            "timestamp": utc_now_iso(),
        }
    )


def build_input_messages(history: list[dict[str, Any]]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []

    for item in history:
        if item["role"] in {"user", "assistant"}:
            messages.append(
                {
                    "role": item["role"],
                    "content": item["content"],
                }
            )

    return messages


def show_banner() -> None:
    banner = Text("ChatGPT CLI", style="bold cyan")
    console.print(Panel(banner, subtitle=f"Model: {MODEL}", border_style="blue"))
    console.print("[bold green]Commands[/bold green]: /exit  /quit  /clear  /history  /help")
    console.print(f"[dim]History file:[/dim] {HISTORY_FILE}")
    console.print(f"[dim]Workspace root:[/dim] {WORKSPACE_DIR}")
    console.print(f"[dim]Base dir root:[/dim] {BASE_DIR}")
    console.print()


def show_help() -> None:
    console.print(
        Panel(
            "\n".join(
                [
                    "[bold]/exit[/bold] or [bold]/quit[/bold]  Quit the program",
                    "[bold]/clear[/bold]                 Clear saved conversation history",
                    "[bold]/history[/bold]               Show saved message count",
                    "[bold]/help[/bold]                  Show this help",
                    "",
                    "Allowed roots:",
                    f"- workspace: {WORKSPACE_DIR}",
                    f"- base_dir: {BASE_DIR}",
                ]
            ),
            title="Help",
            border_style="magenta",
        )
    )


def show_history_summary(history: list[dict[str, Any]]) -> None:
    user_count = sum(1 for x in history if x["role"] == "user")
    assistant_count = sum(1 for x in history if x["role"] == "assistant")
    console.print(
        Panel(
            f"Messages saved: [bold]{len(history)}[/bold]\n"
            f"User messages: [bold]{user_count}[/bold]\n"
            f"Assistant messages: [bold]{assistant_count}[/bold]",
            title="Conversation History",
            border_style="yellow",
        )
    )


def render_user_message(text: str) -> None:
    console.print(
        Panel(
            text,
            title="[bold cyan]You[/bold cyan]",
            border_style="cyan",
        )
    )


def render_assistant_markdown(text: str) -> None:
    console.print(
        Panel(
            Markdown(text),
            title="[bold green]Assistant[/bold green]",
            border_style="green",
        )
    )


def render_tool_call(name: str, args: dict[str, Any]) -> None:
    console.print(
        Panel(
            json.dumps(args, ensure_ascii=False, indent=2),
            title=f"[bold magenta]Tool Call[/bold magenta] {name}",
            border_style="magenta",
        )
    )


def render_tool_result(name: str, result: str) -> None:
    preview = result if len(result) <= 4000 else result[:4000] + "\n... [truncated]"
    console.print(
        Panel(
            preview,
            title=f"[bold yellow]Tool Result[/bold yellow] {name}",
            border_style="yellow",
        )
    )


def get_root_path(root: str) -> Path:
    if root not in ALLOWED_ROOTS:
        raise ValueError(f"Unsupported root: {root}")
    return ALLOWED_ROOTS[root].resolve()


def resolve_rooted_path(root: str, user_path: str) -> Path:
    root_path = get_root_path(root)

    if not user_path or not user_path.strip():
        raise ValueError("Path must not be empty.")

    raw = Path(user_path)

    if raw.is_absolute():
        candidate = raw.resolve()
    else:
        candidate = (root_path / raw).resolve()

    try:
        candidate.relative_to(root_path)
    except ValueError as exc:
        raise ValueError(f"Path escapes the selected root: {root}") from exc

    return candidate


def rel_rooted_path(root: str, path: Path) -> str:
    root_path = get_root_path(root)
    resolved = path.resolve()
    if resolved == root_path:
        return "."
    return resolved.relative_to(root_path).as_posix()


def json_result(**kwargs: Any) -> str:
    return json.dumps(kwargs, ensure_ascii=False, indent=2)


def truncate_text(text: str, limit: int = 12000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n... [truncated]"


# -----------------------------
# Filesystem tools
# -----------------------------

def fs_list_files(root: str, path: str = ".", recursive: bool = False, include_hidden: bool = False) -> str:
    target = resolve_rooted_path(root, path)

    if not target.exists():
        return json_result(ok=False, error="Path does not exist.", root=root, path=path)

    if target.is_file():
        stat = target.stat()
        return json_result(
            ok=True,
            kind="file",
            root=root,
            path=rel_rooted_path(root, target),
            size_bytes=stat.st_size,
        )

    entries: list[dict[str, Any]] = []
    count = 0
    iterator = target.rglob("*") if recursive else target.iterdir()

    for item in iterator:
        rel = rel_rooted_path(root, item)

        if not include_hidden and any(part.startswith(".") for part in Path(rel).parts if rel != "."):
            continue

        info: dict[str, Any] = {
            "path": rel,
            "type": "dir" if item.is_dir() else "file",
        }

        if item.is_file():
            try:
                info["size_bytes"] = item.stat().st_size
            except OSError:
                info["size_bytes"] = None

        entries.append(info)
        count += 1

        if count >= LIST_MAX_ENTRIES:
            break

    return json_result(
        ok=True,
        kind="directory",
        root=root,
        path=rel_rooted_path(root, target),
        recursive=recursive,
        include_hidden=include_hidden,
        truncated=(count >= LIST_MAX_ENTRIES),
        entries=entries,
    )


def fs_read_file(root: str, path: str, max_bytes: int = READ_MAX_BYTES) -> str:
    target = resolve_rooted_path(root, path)

    if not target.exists():
        return json_result(ok=False, error="File does not exist.", root=root, path=path)

    if not target.is_file():
        return json_result(ok=False, error="Path is not a file.", root=root, path=path)

    size = target.stat().st_size
    if size > max_bytes:
        return json_result(
            ok=False,
            error=f"File too large to read safely in one call ({size} bytes).",
            root=root,
            path=path,
            size_bytes=size,
            max_bytes=max_bytes,
        )

    try:
        content = target.read_text(encoding="utf-8")
        return json_result(
            ok=True,
            root=root,
            path=rel_rooted_path(root, target),
            size_bytes=size,
            content=content,
        )
    except UnicodeDecodeError:
        return json_result(
            ok=False,
            error="File is not valid UTF-8 text.",
            root=root,
            path=path,
            size_bytes=size,
        )


def fs_write_file(root: str, path: str, content: str, overwrite: bool = False) -> str:
    target = resolve_rooted_path(root, path)

    if target.exists() and target.is_dir():
        return json_result(ok=False, error="Target path is a directory.", root=root, path=path)

    existed_before = target.exists()

    if existed_before and not overwrite:
        return json_result(
            ok=False,
            error="File already exists. Set overwrite=true to replace it.",
            root=root,
            path=path,
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

    return json_result(
        ok=True,
        root=root,
        path=rel_rooted_path(root, target),
        bytes_written=len(content.encode("utf-8")),
        overwritten=existed_before,
    )


def fs_append_file(root: str, path: str, content: str, create_if_missing: bool = True) -> str:
    target = resolve_rooted_path(root, path)

    if target.exists() and target.is_dir():
        return json_result(ok=False, error="Target path is a directory.", root=root, path=path)

    existed_before = target.exists()

    if not existed_before and not create_if_missing:
        return json_result(
            ok=False,
            error="File does not exist and create_if_missing is false.",
            root=root,
            path=path,
        )

    target.parent.mkdir(parents=True, exist_ok=True)

    previous_size = target.stat().st_size if existed_before else 0
    with target.open("a", encoding="utf-8") as f:
        f.write(content)

    return json_result(
        ok=True,
        root=root,
        path=rel_rooted_path(root, target),
        bytes_appended=len(content.encode("utf-8")),
        previous_size_bytes=previous_size,
        new_size_bytes=target.stat().st_size,
        created=not existed_before,
    )


def fs_replace_in_file(root: str, path: str, find_text: str, replace_text: str, count: int = 0) -> str:
    target = resolve_rooted_path(root, path)

    if not target.exists():
        return json_result(ok=False, error="File does not exist.", root=root, path=path)

    if not target.is_file():
        return json_result(ok=False, error="Path is not a file.", root=root, path=path)

    if find_text == "":
        return json_result(ok=False, error="find_text must not be empty.", root=root, path=path)

    if count < 0:
        return json_result(ok=False, error="count must be >= 0.", root=root, path=path)

    try:
        original = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return json_result(ok=False, error="File is not valid UTF-8 text.", root=root, path=path)

    occurrences = original.count(find_text)
    if occurrences == 0:
        return json_result(ok=False, error="Text not found.", root=root, path=path)

    replacements_to_make = occurrences if count == 0 else min(occurrences, count)
    new_text = original.replace(find_text, replace_text, replacements_to_make)
    target.write_text(new_text, encoding="utf-8")

    return json_result(
        ok=True,
        root=root,
        path=rel_rooted_path(root, target),
        replacements_made=replacements_to_make,
    )


def fs_make_directory(root: str, path: str) -> str:
    target = resolve_rooted_path(root, path)
    target.mkdir(parents=True, exist_ok=True)

    return json_result(
        ok=True,
        root=root,
        path=rel_rooted_path(root, target),
        created=True,
    )


def fs_delete_path(root: str, path: str, recursive: bool = False) -> str:
    target = resolve_rooted_path(root, path)
    root_path = get_root_path(root)

    if not target.exists():
        return json_result(ok=False, error="Path does not exist.", root=root, path=path)

    if target == root_path:
        return json_result(ok=False, error="Refusing to delete the selected root itself.", root=root, path=path)

    rel_path = rel_rooted_path(root, target)

    if target.is_file() or target.is_symlink():
        target.unlink()
        return json_result(
            ok=True,
            root=root,
            path=rel_path,
            deleted_type="file",
        )

    if target.is_dir():
        if recursive:
            shutil.rmtree(target)
            return json_result(
                ok=True,
                root=root,
                path=rel_path,
                deleted_type="directory_recursive",
            )

        try:
            target.rmdir()
            return json_result(
                ok=True,
                root=root,
                path=rel_path,
                deleted_type="directory_empty",
            )
        except OSError:
            return json_result(
                ok=False,
                error="Directory is not empty. Set recursive=true to delete it.",
                root=root,
                path=path,
            )

    return json_result(ok=False, error="Unsupported path type.", root=root, path=path)


def _archive_kind(path: Path) -> str | None:
    name = path.name.lower()
    if name.endswith(".zip"):
        return "zip"
    if name.endswith((".tar.gz", ".tgz")):
        return "tar_gz"
    if name.endswith(".tar"):
        return "tar"
    return None


def _safe_extract_path(dest_root: Path, member_rel: str) -> Path | None:
    dest_root = dest_root.resolve()
    candidate = (dest_root / member_rel).resolve()
    try:
        candidate.relative_to(dest_root)
    except ValueError:
        return None
    return candidate


def archive_list(root: str, path: str) -> str:
    target = resolve_rooted_path(root, path)

    if not target.exists():
        return json_result(ok=False, error="Path does not exist.", root=root, path=path)

    if not target.is_file():
        return json_result(ok=False, error="Path is not a file.", root=root, path=path)

    kind = _archive_kind(target)
    if not kind:
        return json_result(
            ok=False,
            error="Unsupported archive type. Use .tar, .tar.gz, .tgz, or .zip.",
            root=root,
            path=path,
        )

    members: list[dict[str, Any]] = []
    truncated = False

    try:
        if kind == "zip":
            with zipfile.ZipFile(target, "r") as zf:
                for i, info in enumerate(zf.infolist()):
                    if i >= ARCHIVE_MAX_LIST_ENTRIES:
                        truncated = True
                        break
                    members.append(
                        {
                            "name": info.filename,
                            "size_bytes": info.file_size,
                            "is_dir": info.is_dir(),
                        }
                    )
        else:
            mode = "r:gz" if kind == "tar_gz" else "r"
            with tarfile.open(target, mode) as tf:
                for i, m in enumerate(tf.getmembers()):
                    if i >= ARCHIVE_MAX_LIST_ENTRIES:
                        truncated = True
                        break
                    members.append(
                        {
                            "name": m.name,
                            "size_bytes": m.size,
                            "is_dir": m.isdir(),
                        }
                    )
    except (OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
        return json_result(ok=False, error=str(exc), root=root, path=path)

    return json_result(
        ok=True,
        root=root,
        path=rel_rooted_path(root, target),
        archive_kind=kind,
        truncated=truncated,
        member_count=len(members),
        members=members,
    )


def archive_extract(root: str, archive_path: str, dest_dir: str) -> str:
    archive = resolve_rooted_path(root, archive_path)
    dest = resolve_rooted_path(root, dest_dir)

    if not archive.exists():
        return json_result(ok=False, error="Archive does not exist.", root=root, archive_path=archive_path)

    if not archive.is_file():
        return json_result(ok=False, error="archive_path is not a file.", root=root, archive_path=archive_path)

    kind = _archive_kind(archive)
    if not kind:
        return json_result(
            ok=False,
            error="Unsupported archive type. Use .tar, .tar.gz, .tgz, or .zip.",
            root=root,
            archive_path=archive_path,
        )

    dest.mkdir(parents=True, exist_ok=True)
    extracted = 0

    try:
        if kind == "zip":
            with zipfile.ZipFile(archive, "r") as zf:
                for info in zf.infolist():
                    safe = _safe_extract_path(dest, info.filename)
                    if safe is None:
                        return json_result(
                            ok=False,
                            error=f"Unsafe path in archive: {info.filename!r}",
                            root=root,
                            archive_path=archive_path,
                        )
                    zf.extract(info, path=dest)
                    extracted += 1
        else:
            mode = "r:gz" if kind == "tar_gz" else "r"
            with tarfile.open(archive, mode) as tf:
                for m in tf.getmembers():
                    safe = _safe_extract_path(dest, m.name)
                    if safe is None:
                        return json_result(
                            ok=False,
                            error=f"Unsafe path in archive: {m.name!r}",
                            root=root,
                            archive_path=archive_path,
                        )
                    try:
                        tf.extract(m, path=dest, filter="data")
                    except TypeError:
                        tf.extract(m, path=dest)
                    extracted += 1
    except (OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
        return json_result(ok=False, error=str(exc), root=root, archive_path=archive_path)

    return json_result(
        ok=True,
        root=root,
        archive_path=rel_rooted_path(root, archive),
        dest_dir=rel_rooted_path(root, dest),
        archive_kind=kind,
        members_extracted=extracted,
    )


def grep_files(
    root: str,
    base_path: str,
    pattern: str,
    ignore_case: bool,
    recursive: bool,
    glob_pattern: str,
    max_matches: int,
) -> str:
    if not pattern.strip():
        return json_result(ok=False, error="pattern must not be empty.", root=root)

    flags = re.IGNORECASE if ignore_case else 0
    try:
        regex = re.compile(pattern, flags)
    except re.error as exc:
        return json_result(ok=False, error=f"Invalid regex: {exc}", root=root)

    cap = min(max(max_matches, 1), GREP_MAX_MATCHES)
    start = resolve_rooted_path(root, base_path)

    if not start.exists():
        return json_result(ok=False, error="Path does not exist.", root=root, base_path=base_path)

    matches: list[dict[str, Any]] = []
    glob_pat = glob_pattern.strip()

    def consider_file(p: Path) -> bool:
        if not p.is_file():
            return False
        if not glob_pat:
            return True
        return fnmatch.fnmatch(p.name, glob_pat)

    if start.is_file():
        files = [start] if consider_file(start) else []
    elif recursive:
        files = [p for p in start.rglob("*") if consider_file(p)]
    else:
        files = [p for p in start.iterdir() if consider_file(p)]

    for file_path in files:
        rel = rel_rooted_path(root, file_path)
        try:
            with file_path.open("r", encoding="utf-8", errors="replace") as f:
                for line_num, line in enumerate(f, 1):
                    if regex.search(line):
                        matches.append(
                            {
                                "path": rel,
                                "line": line_num,
                                "text": line.rstrip("\n\r"),
                            }
                        )
                        if len(matches) >= cap:
                            return json_result(
                                ok=True,
                                root=root,
                                base_path=base_path,
                                pattern=pattern,
                                ignore_case=ignore_case,
                                recursive=recursive,
                                glob_pattern=glob_pat or None,
                                truncated=True,
                                match_count=len(matches),
                                matches=matches,
                            )
        except OSError:
            continue

    return json_result(
        ok=True,
        root=root,
        base_path=base_path,
        pattern=pattern,
        ignore_case=ignore_case,
        recursive=recursive,
        glob_pattern=glob_pat or None,
        truncated=False,
        match_count=len(matches),
        matches=matches,
    )


def fs_read_file_chunk(root: str, path: str, offset: int, max_bytes: int) -> str:
    target = resolve_rooted_path(root, path)

    if not target.exists():
        return json_result(ok=False, error="File does not exist.", root=root, path=path)

    if not target.is_file():
        return json_result(ok=False, error="Path is not a file.", root=root, path=path)

    if offset < 0:
        return json_result(ok=False, error="offset must be >= 0.", root=root, path=path)

    size = target.stat().st_size
    cap = min(max_bytes, CHUNK_MAX_BYTES)

    with target.open("rb") as f:
        f.seek(offset)
        data = f.read(cap)

    at_end = offset + len(data) >= size
    text = data.decode("utf-8", errors="replace")

    return json_result(
        ok=True,
        root=root,
        path=rel_rooted_path(root, target),
        offset=offset,
        bytes_read=len(data),
        size_bytes=size,
        at_eof=at_end,
        content=text,
    )


def fs_stat(root: str, path: str) -> str:
    target = resolve_rooted_path(root, path)

    if not target.exists():
        return json_result(ok=False, error="Path does not exist.", root=root, path=path)

    st = target.stat()
    kind = "symlink" if target.is_symlink() else ("dir" if target.is_dir() else "file")

    return json_result(
        ok=True,
        root=root,
        path=rel_rooted_path(root, target),
        type=kind,
        size_bytes=st.st_size,
        modified_iso=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
    )


# -----------------------------
# Git helpers
# -----------------------------

def ensure_git_available() -> None:
    try:
        subprocess.run(
            ["git", "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("git is not installed or not found in PATH.") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"git is not working correctly: {exc.stderr or exc.stdout}") from exc


def is_safe_repo_name(name: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9._/\-]+", name))


def resolve_repo_path(root: str, repo_path: str) -> Path:
    return resolve_rooted_path(root, repo_path)


def ensure_git_repo(root: str, repo_path: str) -> Path:
    repo_dir = resolve_repo_path(root, repo_path)

    if not repo_dir.exists():
        raise ValueError("Repository path does not exist.")

    git_dir = repo_dir / ".git"
    if not git_dir.exists():
        raise ValueError("Path is not a Git repository.")

    return repo_dir


def run_git_command(
    cwd: Path,
    args: list[str],
    timeout: int = GIT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    ensure_git_available()

    env = os.environ.copy()
    env.setdefault("GIT_TERMINAL_PROMPT", "0")

    completed = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )

    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "stdout": truncate_text(completed.stdout.strip()),
        "stderr": truncate_text(completed.stderr.strip()),
        "command": "git " + " ".join(args),
        "cwd": str(cwd),
    }


def infer_clone_target(repo_url: str) -> str:
    cleaned = repo_url.rstrip("/")
    last = cleaned.split("/")[-1]
    if ":" in last and "/" not in cleaned.split("/")[-1]:
        last = cleaned.split(":")[-1]
    if last.endswith(".git"):
        last = last[:-4]
    if not last:
        last = "repo"
    return re.sub(r"[^A-Za-z0-9._\-]", "-", last)


# -----------------------------
# Git tools
# -----------------------------

def git_clone_repo(root: str, repo_url: str, target_dir: str, branch: str = "", depth: int = 0) -> str:
    if not repo_url.strip():
        return json_result(ok=False, error="repo_url must not be empty.", root=root)

    root_path = get_root_path(root)

    if not target_dir.strip():
        target_dir = infer_clone_target(repo_url)

    if not is_safe_repo_name(target_dir):
        return json_result(ok=False, error="target_dir contains unsupported characters.", root=root, target_dir=target_dir)

    target = resolve_rooted_path(root, target_dir)

    if target.exists():
        return json_result(ok=False, error="Target directory already exists.", root=root, target_dir=target_dir)

    clone_args = ["clone"]

    if branch.strip():
        clone_args += ["--branch", branch.strip()]

    if depth > 0:
        clone_args += ["--depth", str(depth)]

    clone_args += [repo_url, target_dir]

    result = run_git_command(root_path, clone_args)

    return json_result(
        ok=result["ok"],
        root=root,
        target_dir=target_dir,
        repo_url=repo_url,
        branch=branch.strip() or None,
        depth=depth if depth > 0 else None,
        returncode=result["returncode"],
        stdout=result["stdout"],
        stderr=result["stderr"],
        command=result["command"],
    )


def git_pull_repo(root: str, repo_path: str, ff_only: bool = True) -> str:
    try:
        repo_dir = ensure_git_repo(root, repo_path)
    except Exception as exc:
        return json_result(ok=False, error=str(exc), root=root, repo_path=repo_path)

    args = ["pull"]
    if ff_only:
        args.append("--ff-only")

    result = run_git_command(repo_dir, args)

    return json_result(
        ok=result["ok"],
        root=root,
        repo_path=rel_rooted_path(root, repo_dir),
        ff_only=ff_only,
        returncode=result["returncode"],
        stdout=result["stdout"],
        stderr=result["stderr"],
        command=result["command"],
    )


def git_status_repo(root: str, repo_path: str) -> str:
    try:
        repo_dir = ensure_git_repo(root, repo_path)
    except Exception as exc:
        return json_result(ok=False, error=str(exc), root=root, repo_path=repo_path)

    result = run_git_command(repo_dir, ["status", "--short", "--branch"])

    return json_result(
        ok=result["ok"],
        root=root,
        repo_path=rel_rooted_path(root, repo_dir),
        returncode=result["returncode"],
        status=result["stdout"],
        stderr=result["stderr"],
        command=result["command"],
    )


def git_diff_repo(root: str, repo_path: str, staged: bool = False, pathspec: str = "") -> str:
    try:
        repo_dir = ensure_git_repo(root, repo_path)
    except Exception as exc:
        return json_result(ok=False, error=str(exc), root=root, repo_path=repo_path)

    args = ["diff"]
    if staged:
        args.append("--staged")
    if pathspec.strip():
        args += ["--", pathspec.strip()]

    result = run_git_command(repo_dir, args)

    return json_result(
        ok=result["ok"],
        root=root,
        repo_path=rel_rooted_path(root, repo_dir),
        staged=staged,
        pathspec=pathspec.strip() or None,
        returncode=result["returncode"],
        diff=result["stdout"],
        stderr=result["stderr"],
        command=result["command"],
    )


def git_list_branches(root: str, repo_path: str, all_branches: bool = True) -> str:
    try:
        repo_dir = ensure_git_repo(root, repo_path)
    except Exception as exc:
        return json_result(ok=False, error=str(exc), root=root, repo_path=repo_path)

    args = ["branch"]
    if all_branches:
        args.append("--all")

    result = run_git_command(repo_dir, args)

    return json_result(
        ok=result["ok"],
        root=root,
        repo_path=rel_rooted_path(root, repo_dir),
        all_branches=all_branches,
        branches=result["stdout"],
        stderr=result["stderr"],
        returncode=result["returncode"],
        command=result["command"],
    )


def git_checkout_branch(root: str, repo_path: str, branch_name: str, create: bool = False, start_point: str = "") -> str:
    if not branch_name.strip():
        return json_result(ok=False, error="branch_name must not be empty.", root=root, repo_path=repo_path)

    try:
        repo_dir = ensure_git_repo(root, repo_path)
    except Exception as exc:
        return json_result(ok=False, error=str(exc), root=root, repo_path=repo_path)

    args = ["checkout"]

    if create:
        args += ["-b", branch_name.strip()]
        if start_point.strip():
            args.append(start_point.strip())
    else:
        args.append(branch_name.strip())

    result = run_git_command(repo_dir, args)

    return json_result(
        ok=result["ok"],
        root=root,
        repo_path=rel_rooted_path(root, repo_dir),
        branch_name=branch_name.strip(),
        create=create,
        start_point=start_point.strip() or None,
        stdout=result["stdout"],
        stderr=result["stderr"],
        returncode=result["returncode"],
        command=result["command"],
    )


def git_commit_all(
    root: str,
    repo_path: str,
    message: str,
    author_name: str = "",
    author_email: str = "",
) -> str:
    if not message.strip():
        return json_result(ok=False, error="Commit message must not be empty.", root=root, repo_path=repo_path)

    try:
        repo_dir = ensure_git_repo(root, repo_path)
    except Exception as exc:
        return json_result(ok=False, error=str(exc), root=root, repo_path=repo_path)

    config_steps: list[dict[str, Any]] = []

    if author_name.strip():
        config_steps.append(run_git_command(repo_dir, ["config", "user.name", author_name.strip()]))

    if author_email.strip():
        config_steps.append(run_git_command(repo_dir, ["config", "user.email", author_email.strip()]))

    add_result = run_git_command(repo_dir, ["add", "-A"])
    if not add_result["ok"]:
        return json_result(
            ok=False,
            root=root,
            repo_path=rel_rooted_path(root, repo_dir),
            step="git add -A",
            stdout=add_result["stdout"],
            stderr=add_result["stderr"],
            returncode=add_result["returncode"],
        )

    commit_result = run_git_command(repo_dir, ["commit", "-m", message.strip()])

    return json_result(
        ok=commit_result["ok"],
        root=root,
        repo_path=rel_rooted_path(root, repo_dir),
        message=message.strip(),
        author_name=author_name.strip() or None,
        author_email=author_email.strip() or None,
        config_steps=config_steps,
        stdout=commit_result["stdout"],
        stderr=commit_result["stderr"],
        returncode=commit_result["returncode"],
        command=commit_result["command"],
    )


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "fs_list_files",
        "description": "List files and directories inside the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
                "recursive": {"type": "boolean"},
                "include_hidden": {"type": "boolean"},
            },
            "required": ["root", "path", "recursive", "include_hidden"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_read_file",
        "description": "Read a UTF-8 text file from the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
                "max_bytes": {"type": "integer"},
            },
            "required": ["root", "path", "max_bytes"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_write_file",
        "description": "Create a new UTF-8 text file or overwrite an existing one in the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
                "content": {"type": "string"},
                "overwrite": {"type": "boolean"},
            },
            "required": ["root", "path", "content", "overwrite"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_append_file",
        "description": "Append UTF-8 text to a file in the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
                "content": {"type": "string"},
                "create_if_missing": {"type": "boolean"},
            },
            "required": ["root", "path", "content", "create_if_missing"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_replace_in_file",
        "description": "Replace exact text inside a UTF-8 text file in the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
                "find_text": {"type": "string"},
                "replace_text": {"type": "string"},
                "count": {"type": "integer"},
            },
            "required": ["root", "path", "find_text", "replace_text", "count"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_make_directory",
        "description": "Create a directory inside the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
            },
            "required": ["root", "path"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_delete_path",
        "description": "Delete a file, or delete a directory. Non-empty directories require recursive=true.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
                "recursive": {"type": "boolean"},
            },
            "required": ["root", "path", "recursive"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "archive_list",
        "description": "List contents of a .tar, .tar.gz, .tgz, or .zip archive (paths relative to the selected root).",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
            },
            "required": ["root", "path"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "archive_extract",
        "description": "Extract a .tar, .tar.gz, .tgz, or .zip archive into a destination folder under the selected root. Refuses path-traversal members.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "archive_path": {"type": "string"},
                "dest_dir": {"type": "string"},
            },
            "required": ["root", "archive_path", "dest_dir"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "grep_files",
        "description": "Search text files with a regex under a path (recursive optional). Use for log scanning; results include line numbers. Empty glob_pattern matches all file names.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "base_path": {"type": "string"},
                "pattern": {"type": "string"},
                "ignore_case": {"type": "boolean"},
                "recursive": {"type": "boolean"},
                "glob_pattern": {"type": "string"},
                "max_matches": {"type": "integer"},
            },
            "required": [
                "root",
                "base_path",
                "pattern",
                "ignore_case",
                "recursive",
                "glob_pattern",
                "max_matches",
            ],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_read_file_chunk",
        "description": "Read a byte range from a file as UTF-8 (with replacement for invalid sequences). For large logs; use offset/max_bytes instead of loading the whole file.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
                "offset": {"type": "integer"},
                "max_bytes": {"type": "integer"},
            },
            "required": ["root", "path", "offset", "max_bytes"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "fs_stat",
        "description": "Return file or directory metadata: type, size in bytes, and last modified time (UTC ISO).",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "path": {"type": "string"},
            },
            "required": ["root", "path"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "git_clone_repo",
        "description": "Clone a public or private Git repository into the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "repo_url": {"type": "string"},
                "target_dir": {"type": "string"},
                "branch": {"type": "string"},
                "depth": {"type": "integer"},
            },
            "required": ["root", "repo_url", "target_dir", "branch", "depth"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "git_pull_repo",
        "description": "Pull changes for a Git repository inside the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "repo_path": {"type": "string"},
                "ff_only": {"type": "boolean"},
            },
            "required": ["root", "repo_path", "ff_only"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "git_status_repo",
        "description": "Show Git status for a repository inside the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "repo_path": {"type": "string"},
            },
            "required": ["root", "repo_path"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "git_diff_repo",
        "description": "Show Git diff for a repository inside the selected root.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "repo_path": {"type": "string"},
                "staged": {"type": "boolean"},
                "pathspec": {"type": "string"},
            },
            "required": ["root", "repo_path", "staged", "pathspec"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "git_list_branches",
        "description": "List local and optionally remote branches for a repository.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "repo_path": {"type": "string"},
                "all_branches": {"type": "boolean"},
            },
            "required": ["root", "repo_path", "all_branches"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "git_checkout_branch",
        "description": "Checkout a branch, or create and checkout a new branch, in a repository.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "repo_path": {"type": "string"},
                "branch_name": {"type": "string"},
                "create": {"type": "boolean"},
                "start_point": {"type": "string"},
            },
            "required": ["root", "repo_path", "branch_name", "create", "start_point"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "git_commit_all",
        "description": "Stage all changes in a repository and create a commit.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "root": {"type": "string", "enum": ["workspace", "base_dir"]},
                "repo_path": {"type": "string"},
                "message": {"type": "string"},
                "author_name": {"type": "string"},
                "author_email": {"type": "string"},
            },
            "required": ["root", "repo_path", "message", "author_name", "author_email"],
            "additionalProperties": False,
        },
    },
]


def call_function(name: str, args: dict[str, Any]) -> str:
    if name == "fs_list_files":
        return fs_list_files(**args)
    if name == "fs_read_file":
        return fs_read_file(**args)
    if name == "fs_write_file":
        return fs_write_file(**args)
    if name == "fs_append_file":
        return fs_append_file(**args)
    if name == "fs_replace_in_file":
        return fs_replace_in_file(**args)
    if name == "fs_make_directory":
        return fs_make_directory(**args)
    if name == "fs_delete_path":
        return fs_delete_path(**args)
    if name == "archive_list":
        return archive_list(**args)
    if name == "archive_extract":
        return archive_extract(**args)
    if name == "grep_files":
        return grep_files(**args)
    if name == "fs_read_file_chunk":
        return fs_read_file_chunk(**args)
    if name == "fs_stat":
        return fs_stat(**args)
    if name == "git_clone_repo":
        return git_clone_repo(**args)
    if name == "git_pull_repo":
        return git_pull_repo(**args)
    if name == "git_status_repo":
        return git_status_repo(**args)
    if name == "git_diff_repo":
        return git_diff_repo(**args)
    if name == "git_list_branches":
        return git_list_branches(**args)
    if name == "git_checkout_branch":
        return git_checkout_branch(**args)
    if name == "git_commit_all":
        return git_commit_all(**args)

    return json_result(ok=False, error=f"Unknown function: {name}")


def run_agent_turn(client: OpenAI, history: list[dict[str, Any]]) -> str:
    input_items: list[Any] = build_input_messages(history)

    for _ in range(MAX_TOOL_ROUNDS):
        response = client.responses.create(
            model=MODEL,
            instructions=SYSTEM_PROMPT,
            input=input_items,
            tools=TOOLS,
            tool_choice="auto",
            parallel_tool_calls=False,
        )

        response_items = getattr(response, "output", []) or []
        tool_calls = [item for item in response_items if getattr(item, "type", None) == "function_call"]

        if not tool_calls:
            text = (getattr(response, "output_text", "") or "").strip()
            return text if text else "_No text response returned._"

        input_items.extend(response_items)

        for tool_call in tool_calls:
            name = tool_call.name
            args = json.loads(tool_call.arguments)

            render_tool_call(name, args)

            try:
                result = call_function(name, args)
            except Exception as exc:
                result = json_result(ok=False, error=f"{type(exc).__name__}: {exc}")

            render_tool_result(name, result)

            input_items.append(
                {
                    "type": "function_call_output",
                    "call_id": tool_call.call_id,
                    "output": result,
                }
            )

    return "_Stopped after too many tool rounds._"


def main() -> int:
    ensure_dirs()

    if not os.getenv("OPENAI_API_KEY"):
        console.print('[red]Error:[/red] OPENAI_API_KEY is not set.')
        console.print('Run: [bold]export OPENAI_API_KEY="your_api_key_here"[/bold]')
        return 1

    client = OpenAI()
    history = load_history()

    show_banner()

    while True:
        try:
            user_input = Prompt.ask("[bold cyan]You[/bold cyan]").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[bold yellow]Bye.[/bold yellow]")
            return 0

        if not user_input:
            continue

        if user_input in {"/exit", "/quit"}:
            console.print("[bold yellow]Bye.[/bold yellow]")
            return 0

        if user_input == "/help":
            show_help()
            continue

        if user_input == "/history":
            show_history_summary(history)
            continue

        if user_input == "/clear":
            history.clear()
            save_history(history)
            console.print("[bold yellow]Conversation history cleared.[/bold yellow]")
            continue

        render_user_message(user_input)
        add_message(history, "user", user_input)
        save_history(history)

        try:
            with console.status("[bold green]Thinking...[/bold green]", spinner="dots"):
                answer = run_agent_turn(client, history)

            render_assistant_markdown(answer)
            add_message(history, "assistant", answer)
            save_history(history)

        except Exception as exc:
            console.print(Panel(str(exc), title="API Error", border_style="red"))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
    
