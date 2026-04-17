from __future__ import annotations

import os
import stat
import subprocess
import tempfile
from typing import Any


def run_ssh_command(
    *,
    host: str,
    port: int,
    username: str,
    private_key: str,
    command: str,
    timeout_seconds: int = 60,
) -> dict[str, Any]:
    """Run a command over SSH using an in-memory provided private key."""
    key_path = ""
    try:
        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as tf:
            tf.write(private_key.strip() + "\n")
            key_path = tf.name
        os.chmod(key_path, stat.S_IRUSR | stat.S_IWUSR)

        cmd = [
            "ssh",
            "-i",
            key_path,
            "-p",
            str(int(port)),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=10",
            f"{username}@{host}",
            command,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=max(1, int(timeout_seconds)))
        return {
            "ok": proc.returncode == 0,
            "command": cmd,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "returncode": proc.returncode,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "stdout": exc.stdout or "",
            "stderr": (exc.stderr or "") + "\nSSH command timed out.",
            "returncode": None,
        }
    finally:
        if key_path:
            try:
                os.remove(key_path)
            except OSError:
                pass
