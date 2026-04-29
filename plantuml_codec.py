# -*- coding: utf-8 -*-
"""PlantUML text encoding (deflate + 6-bit alphabet) for server-side render URLs."""

from __future__ import annotations

import zlib


def _encode6bit(b: int) -> str:
    if b < 10:
        return chr(48 + b)
    b -= 10
    if b < 26:
        return chr(65 + b)
    b -= 26
    if b < 26:
        return chr(97 + b)
    b -= 26
    if b == 0:
        return "-"
    if b == 1:
        return "_"
    return "?"


def _append3bytes(b1: int, b2: int, b3: int) -> str:
    c1 = b1 >> 2
    c2 = ((b1 & 0x3) << 4) | (b2 >> 4)
    c3 = ((b2 & 0xF) << 2) | (b3 >> 6)
    c4 = b3 & 0x3F
    return _encode6bit(c1) + _encode6bit(c2) + _encode6bit(c3) + _encode6bit(c4)


def plantuml_encode(text: str) -> str:
    """Encode diagram source for PlantUML server ``/svg/…`` or ``/png/…`` paths."""
    zlibbed = zlib.compress(text.encode("utf-8"))[2:-4]
    parts: list[str] = []
    for i in range(0, len(zlibbed), 3):
        b1 = zlibbed[i]
        if i + 2 < len(zlibbed):
            parts.append(_append3bytes(b1, zlibbed[i + 1], zlibbed[i + 2]))
        elif i + 1 < len(zlibbed):
            parts.append(_append3bytes(b1, zlibbed[i + 1], 0))
        else:
            parts.append(_append3bytes(b1, 0, 0))
    return "".join(parts)
