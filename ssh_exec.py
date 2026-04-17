from __future__ import annotations

from io import StringIO
from typing import Any

import paramiko


def _load_private_key(private_key: str, password: str | None) -> paramiko.PKey:
    text = private_key.strip()
    loaders = (
        paramiko.RSAKey.from_private_key,
        paramiko.Ed25519Key.from_private_key,
        paramiko.ECDSAKey.from_private_key,
        paramiko.DSSKey.from_private_key,
    )
    last_exc: Exception | None = None
    for loader in loaders:
        try:
            return loader(StringIO(text), password=password)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
    raise ValueError(f"Unsupported or invalid private key: {last_exc}")


def run_ssh_command(
    *,
    host: str,
    port: int,
    username: str,
    auth_mode: str,
    private_key: str | None,
    password: str | None,
    command: str,
    timeout_seconds: int = 60,
) -> dict[str, Any]:
    """Run a command over SSH with password and/or private key auth."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        mode = auth_mode.strip()
        timeout = max(1, int(timeout_seconds))
        pkey: paramiko.PKey | None = None
        pwd = (password or "").strip() or None

        if mode in {"private_key", "private_key_password"}:
            if not private_key or not private_key.strip():
                return {"ok": False, "stdout": "", "stderr": "Missing private key.", "returncode": None}
            # For encrypted keys, password acts as passphrase.
            pkey = _load_private_key(private_key, pwd)

        client.connect(
            hostname=host,
            port=int(port),
            username=username,
            password=pwd if mode in {"password", "private_key_password"} else None,
            pkey=pkey,
            timeout=min(timeout, 20),
            auth_timeout=min(timeout, 20),
            look_for_keys=False,
            allow_agent=False,
        )

        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return {
            "ok": code == 0,
            "stdout": out,
            "stderr": err,
            "returncode": code,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "stdout": "",
            "stderr": str(exc),
            "returncode": None,
        }
    finally:
        client.close()
