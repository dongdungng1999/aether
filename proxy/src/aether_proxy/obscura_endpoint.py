"""Obscura (headless browser) file-serving endpoint + cleanup.

Mirrors visualise_endpoint.py: the obscura MCP writes PNG/PDF files inside the
container; this module serves them at GET /api/obscura/<filename> so any client
(Linux CLI, Windows extension via SSH tunnel) can fetch by URL.
No token auth — files are identified by UUID name, treated as secret enough.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Iterable

from fastapi import FastAPI, HTTPException, Response

logger = logging.getLogger(__name__)

OBSCURA_DIR = Path(os.environ.get("OBSCURA_OUT_DIR", "/tmp/obscura-out"))

TTL_HOURS = int(os.environ.get("AURA_OBSCURA_TTL_HOURS", "24"))
MAX_FILES = int(os.environ.get("AURA_OBSCURA_MAX_FILES", "200"))
MAX_BYTES = int(os.environ.get("AURA_OBSCURA_MAX_MB", "500")) * 1024 * 1024
SWEEP_SEC = 600

_EXT_MIME = {
    "png": "image/png",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
}


def _safe_path(filename: str) -> Path:
    if not filename or "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="invalid filename")
    candidate = (OBSCURA_DIR / filename).resolve()
    try:
        candidate.relative_to(OBSCURA_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="filename outside obscura dir")
    return candidate


def register_obscura_endpoint(app: FastAPI) -> None:
    @app.get("/api/obscura/{filename}")
    async def serve_obscura(filename: str) -> Response:
        path = _safe_path(filename)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        ext = path.suffix.lower().lstrip(".")
        media = _EXT_MIME.get(ext, "application/octet-stream")
        return Response(content=path.read_bytes(), media_type=media)


def _list_files() -> list[tuple[Path, os.stat_result]]:
    if not OBSCURA_DIR.exists():
        return []
    out = []
    for p in OBSCURA_DIR.iterdir():
        if not p.is_file():
            continue
        try:
            out.append((p, p.stat()))
        except OSError:
            pass
    return out


def _purge_ttl(files: Iterable[tuple[Path, os.stat_result]]) -> int:
    cutoff = time.time() - TTL_HOURS * 3600
    n = 0
    for p, st in files:
        if st.st_mtime < cutoff:
            try:
                p.unlink(); n += 1
            except OSError:
                pass
    return n


def _purge_lru(files: list[tuple[Path, os.stat_result]]) -> int:
    files.sort(key=lambda it: it[1].st_mtime)
    total = sum(st.st_size for _, st in files)
    n = 0
    while files and (len(files) > MAX_FILES or total > MAX_BYTES):
        p, st = files.pop(0)
        try:
            p.unlink(); total -= st.st_size; n += 1
        except OSError:
            pass
    return n


def _sweep_once() -> None:
    files = _list_files()
    if not files:
        return
    n_ttl = _purge_ttl(files)
    files = [f for f in files if f[0].exists()]
    n_lru = _purge_lru(files)
    if n_ttl or n_lru:
        logger.info("[obscura] cleanup ttl=%d lru=%d", n_ttl, n_lru)


async def _sweep_loop() -> None:
    while True:
        try:
            _sweep_once()
        except Exception as e:
            logger.warning("[obscura] sweep error: %s", e)
        await asyncio.sleep(SWEEP_SEC)


def schedule_obscura_cleanup(app: FastAPI) -> None:
    OBSCURA_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("[obscura] endpoint dir=%s ttl=%dh max=%d files / %d MB",
                OBSCURA_DIR, TTL_HOURS, MAX_FILES, MAX_BYTES // (1024 * 1024))
