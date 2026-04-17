"""Encrypt OpenAI API keys at rest using SECRET_KEY-derived Fernet key."""

from __future__ import annotations

import base64
import hashlib
import os


def _fernet_key() -> bytes:
    secret = os.environ.get("SECRET_KEY", "").encode("utf-8")
    if len(secret) < 16:
        raise RuntimeError("SECRET_KEY must be set (at least 16 characters) for encrypting API keys.")
    digest = hashlib.sha256(secret).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt_api_key(plain: str) -> str:
    from cryptography.fernet import Fernet

    f = Fernet(_fernet_key())
    return f.encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_api_key(token: str) -> str:
    from cryptography.fernet import Fernet

    f = Fernet(_fernet_key())
    return f.decrypt(token.encode("ascii")).decode("utf-8")
