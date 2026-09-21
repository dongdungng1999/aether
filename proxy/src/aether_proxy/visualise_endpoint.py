"""Visualise-file serving HTTP endpoint + on-disk cleanup.

Mirrors image_endpoint.py: the visualise MCP writes SVG/HTML files inside the
container; this module serves them at GET /api/visualise/<filename> so any
client (Linux CLI, Windows extension via SSH tunnel) fetches by URL instead
of a bind-mounted path. Same token scheme as the image endpoint.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Iterable

from fastapi import FastAPI, HTTPException, Query, Response

logger = logging.getLogger(__name__)

VISUALISE_DIR = Path(os.path.expanduser(
    os.environ.get("VISUALISE_OUT_DIR", "/tmp/visualise")
))

TTL_HOURS = int(os.environ.get("AURA_VISUALISE_TTL_HOURS", "72"))
MAX_FILES = int(os.environ.get("AURA_VISUALISE_MAX_FILES", "500"))
MAX_BYTES = int(os.environ.get("AURA_VISUALISE_MAX_MB", "200")) * 1024 * 1024
SWEEP_SEC = 600

TOKEN_FILE = Path("/tmp/aura-visualise-token")

_token: str | None = None


def get_token() -> str:
    global _token
    if _token:
        return _token
    if TOKEN_FILE.exists():
        try:
            t = TOKEN_FILE.read_text().strip()
            if t:
                _token = t
                return _token
        except OSError:
            pass
    _token = secrets.token_hex(32)
    try:
        TOKEN_FILE.write_text(_token)
        TOKEN_FILE.chmod(0o644)
    except OSError as e:
        logger.warning("[visualise] could not persist token to %s: %s", TOKEN_FILE, e)
    return _token


def _safe_path(filename: str) -> Path:
    if not filename or "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="invalid filename")
    candidate = (VISUALISE_DIR / filename).resolve()
    try:
        candidate.relative_to(VISUALISE_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="filename outside visualise dir")
    return candidate


_EXT_MIME = {
    "html": "text/html; charset=utf-8",
    "svg":  "image/svg+xml",
}


def register_visualise_endpoint(app: FastAPI) -> None:
    @app.get("/api/visualise/{filename}")
    async def serve_visualise(filename: str, token: str = Query("")) -> Response:
        if not secrets.compare_digest(token, get_token()):
            raise HTTPException(status_code=403, detail="forbidden")
        path = _safe_path(filename)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        ext = path.suffix.lower().lstrip(".")
        media = _EXT_MIME.get(ext, "application/octet-stream")
        return Response(content=path.read_bytes(), media_type=media)


def _list_files() -> list[tuple[Path, os.stat_result]]:
    if not VISUALISE_DIR.exists():
        return []
    out = []
    for p in VISUALISE_DIR.iterdir():
        if not p.is_file():
            continue
        if p.suffix.lower().lstrip(".") not in _EXT_MIME:
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
            except OSError as e:
                logger.warning("[visualise] ttl delete %s: %s", p, e)
    return n


def _purge_lru(files: list[tuple[Path, os.stat_result]]) -> int:
    files.sort(key=lambda it: it[1].st_mtime)
    total = sum(st.st_size for _, st in files)
    n = 0
    while files and (len(files) > MAX_FILES or total > MAX_BYTES):
        p, st = files.pop(0)
        try:
            p.unlink(); total -= st.st_size; n += 1
        except OSError as e:
            logger.warning("[visualise] lru delete %s: %s", p, e)
    return n


def _sweep_once() -> None:
    files = _list_files()
    if not files:
        return
    n_ttl = _purge_ttl(files)
    files = [f for f in files if f[0].exists()]
    n_lru = _purge_lru(files)
    if n_ttl or n_lru:
        logger.info("[visualise] cleanup ttl=%d lru=%d", n_ttl, n_lru)


async def _sweep_loop() -> None:
    while True:
        try:
            _sweep_once()
        except Exception as e:
            logger.warning("[visualise] sweep error: %s", e)
        await asyncio.sleep(SWEEP_SEC)


def schedule_visualise_cleanup(app: FastAPI) -> None:
    VISUALISE_DIR.mkdir(parents=True, exist_ok=True)
    get_token()
    logger.info("[visualise] endpoint dir=%s ttl=%dh max=%d files / %d MB token=…%s",
                VISUALISE_DIR, TTL_HOURS, MAX_FILES, MAX_BYTES // (1024*1024),
                get_token()[-6:])
