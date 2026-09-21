"""Image-serving HTTP endpoint + on-disk cleanup.

The proxy can deliver MCP-generated images two ways:

  • mount  — host bind-mounts RENESAS_IMAGE_OUTPUT_DIR; consumer reads
             the file path the MCP returned. Linux/CLI default.
  • http   — proxy serves the file at GET /api/images/<id>; the MCP
             returns that URL. Cross-platform (works for the Windows
             extension over a remote tunnel where bind-mount has no meaning).

This module owns the http side:
  - register_image_endpoint(app):  FastAPI route /api/images/<filename>
  - schedule_image_cleanup(app):   periodic TTL + LRU pruning task
  - get_token():                   per-container random token, persisted
                                    to /tmp/aura-image-token so the
                                    extension can fetch it via `docker exec`.

Security: token-protected via ?token=... query param. The proxy listens on
loopback only, but the same Linux box may host multiple users — a token
keeps cross-user reads off the table without forcing the client to learn
docker bind paths. Consistent with how RENESAS_API_KEY is bearer-only.
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

# Where renesas_image MCP saves files. Same env var the MCP itself reads,
# so a single host.yaml setting drives both producer and server.
IMAGE_DIR = Path(os.path.expanduser(
    os.environ.get("RENESAS_IMAGE_OUTPUT_DIR", "/tmp/renesas-images")
))

# Cleanup knobs — defaults err on the safe side; host.yaml overrides via
# AURA_IMAGE_TTL_HOURS / AURA_IMAGE_MAX_FILES / AURA_IMAGE_MAX_MB.
TTL_HOURS  = int(os.environ.get("AURA_IMAGE_TTL_HOURS",  "24"))
MAX_FILES  = int(os.environ.get("AURA_IMAGE_MAX_FILES",  "200"))
MAX_BYTES  = int(os.environ.get("AURA_IMAGE_MAX_MB",     "500")) * 1024 * 1024
SWEEP_SEC  = 300   # run every 5 min

TOKEN_FILE = Path("/tmp/aura-image-token")

_token: str | None = None


def get_token() -> str:
    """Return the per-container token, generating + persisting on first call."""
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
        TOKEN_FILE.chmod(0o644)   # readable by `docker exec` from any UID
    except OSError as e:
        logger.warning("[image] could not persist token to %s: %s", TOKEN_FILE, e)
    return _token


def _safe_image_path(filename: str) -> Path:
    """Resolve filename inside IMAGE_DIR, refusing path traversal (../, abs)."""
    if not filename or "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="invalid filename")
    candidate = (IMAGE_DIR / filename).resolve()
    try:
        candidate.relative_to(IMAGE_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="filename outside image dir")
    return candidate


_EXT_MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "png": "image/png",  "webp": "image/webp", "gif": "image/gif",
}


def register_image_endpoint(app: FastAPI) -> None:
    """Mount GET /api/images/{filename}. Token verified via ?token=… query."""

    @app.get("/api/images/{filename}")
    async def serve_image(filename: str, token: str = Query("")) -> Response:
        if not secrets.compare_digest(token, get_token()):
            raise HTTPException(status_code=403, detail="forbidden")
        path = _safe_image_path(filename)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        ext = path.suffix.lower().lstrip(".")
        media = _EXT_MIME.get(ext, "application/octet-stream")
        return Response(content=path.read_bytes(), media_type=media)


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

def _list_image_files() -> list[tuple[Path, os.stat_result]]:
    if not IMAGE_DIR.exists():
        return []
    out = []
    for p in IMAGE_DIR.iterdir():
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
    """Delete files older than TTL_HOURS. Returns count removed."""
    cutoff = time.time() - TTL_HOURS * 3600
    removed = 0
    for p, st in files:
        if st.st_mtime < cutoff:
            try:
                p.unlink()
                removed += 1
            except OSError as e:
                logger.warning("[image] ttl delete %s: %s", p, e)
    return removed


def _purge_lru(files: list[tuple[Path, os.stat_result]]) -> int:
    """Enforce MAX_FILES + MAX_BYTES. Drops oldest first. Returns count."""
    files.sort(key=lambda it: it[1].st_mtime)   # oldest first
    total_bytes = sum(st.st_size for _, st in files)
    removed = 0
    while files and (len(files) > MAX_FILES or total_bytes > MAX_BYTES):
        p, st = files.pop(0)
        try:
            p.unlink()
            total_bytes -= st.st_size
            removed += 1
        except OSError as e:
            logger.warning("[image] lru delete %s: %s", p, e)
    return removed


def _sweep_once() -> None:
    files = _list_image_files()
    if not files:
        return
    n_ttl = _purge_ttl(files)
    files = [f for f in files if f[0].exists()]
    n_lru = _purge_lru(files)
    if n_ttl or n_lru:
        logger.info("[image] cleanup removed ttl=%d lru=%d (cap=%d files / %d MB)",
                    n_ttl, n_lru, MAX_FILES, MAX_BYTES // (1024*1024))


def _purge_all() -> int:
    """Per-session purge — wipe everything that survived a previous run."""
    files = _list_image_files()
    n = 0
    for p, _ in files:
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    if n:
        logger.info("[image] per-session purge removed %d image(s) at startup", n)
    return n


async def _sweep_loop() -> None:
    while True:
        try:
            _sweep_once()
        except Exception as e:
            logger.warning("[image] sweep error: %s", e)
        await asyncio.sleep(SWEEP_SEC)


def schedule_image_cleanup(app: FastAPI) -> None:
    """Synchronous startup work — directory, per-session purge, token mint.

    Called once from proxy.py at module import time so the token file is
    on disk before the extension's first `docker exec cat` lands. The
    periodic sweep loop is launched by proxy.py's lifespan handler (this
    app uses `lifespan=…`, which silently disables `on_event("startup")`).
    """
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    _purge_all()
    get_token()
    logger.info("[image] endpoint dir=%s ttl=%dh max=%d files / %d MB token=…%s",
                IMAGE_DIR, TTL_HOURS, MAX_FILES, MAX_BYTES // (1024*1024),
                get_token()[-6:])
