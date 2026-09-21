#!/usr/bin/env python3
"""MCP server wrapping Obscura (headless browser) for AURA.

Exposes three tools:
  browser_fetch(url, wait_for, timeout)      — render JS page → markdown/text
  browser_screenshot(url, wait_for, timeout) — screenshot → proxy URL
  browser_pdf(url, wait_for, timeout)        — export PDF → proxy URL

Obscura binary path: OBSCURA_BIN env var (default: obscura on PATH).
Output dir: OBSCURA_OUT_DIR env var (default: /tmp/obscura-out).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import uuid
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP

log = logging.getLogger(__name__)
mcp = FastMCP("obscura")

_BIN = os.environ.get("OBSCURA_BIN", "obscura")
_OUT_DIR = Path(os.environ.get("OBSCURA_OUT_DIR", "/tmp/obscura-out"))
_PROXY_BASE = os.environ.get("AURA_PROXY_INTERNAL_URL", "http://127.0.0.1:8000")


def _proxy_base(ctx: Context | None) -> str:
    if ctx is not None:
        try:
            req = ctx.request_context.request
            host = req.headers.get("host") if req is not None else None
            scheme = (req.url.scheme if req is not None else "http") or "http"
            if host:
                return f"{scheme}://{host}"
        except Exception:
            pass
    return _PROXY_BASE


async def _run(cmd: list[str], timeout: int = 30) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return -1, "", f"timeout after {timeout}s"
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


def _check_bin() -> str | None:
    """Return None if binary available, else error string."""
    if shutil.which(_BIN) is None:
        return (
            f"Obscura binary '{_BIN}' not found. "
            "Install from https://github.com/yousafgill/obscura or set OBSCURA_BIN."
        )
    return None


def _out_dir() -> Path:
    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    return _OUT_DIR


@mcp.tool(description=(
    "Fetch a URL using a headless browser that executes JavaScript. "
    "Use when a page is JS-gated, dynamically rendered (React/Vue/Angular SPA), "
    "or returns empty HTML with a plain HTTP fetch. "
    "Returns the page's text content."
))
async def browser_fetch(
    url: str,
    wait_for: str = "networkidle",
    timeout: int = 30,
) -> str:
    err = _check_bin()
    if err:
        return f"[browser_fetch] Error: {err}"

    outfile = _out_dir() / f"{uuid.uuid4().hex}.txt"
    rc, stdout, stderr = await _run(
        [_BIN, "fetch", "--wait", wait_for, "--output", str(outfile), url],
        timeout=timeout + 5,
    )
    if rc != 0:
        return f"[browser_fetch] Failed (exit {rc}): {stderr.strip() or stdout.strip()}"

    if outfile.exists():
        text = outfile.read_text(errors="replace")
        outfile.unlink(missing_ok=True)
    else:
        text = stdout

    if not text.strip():
        return f"[browser_fetch] Empty response from {url}"

    # Trim to reasonable context size
    if len(text) > 40000:
        text = text[:40000] + "\n\n[truncated]"
    return text


@mcp.tool(description=(
    "Take a full-page screenshot of a URL using a headless browser. "
    "Returns a proxy URL to view the PNG screenshot. "
    "Use for visual inspection, UI verification, or capturing rendered content."
))
async def browser_screenshot(
    url: str,
    wait_for: str = "networkidle",
    timeout: int = 30,
    ctx: Context = None,
) -> str:
    err = _check_bin()
    if err:
        return f"[browser_screenshot] Error: {err}"

    name = uuid.uuid4().hex
    outfile = _out_dir() / f"{name}.png"
    rc, stdout, stderr = await _run(
        [_BIN, "screenshot", "--wait", wait_for, "--output", str(outfile), url],
        timeout=timeout + 5,
    )
    if rc != 0:
        return f"[browser_screenshot] Failed (exit {rc}): {stderr.strip() or stdout.strip()}"
    if not outfile.exists():
        return f"[browser_screenshot] No output file produced"

    base = _proxy_base(ctx)
    return f"Screenshot saved: {outfile}\nProxy URL: {base}/api/obscura/{name}.png"


@mcp.tool(description=(
    "Export a URL as a PDF using a headless browser. "
    "Returns a proxy URL to download the PDF. "
    "Use for archiving, printing, or sharing web pages as documents."
))
async def browser_pdf(
    url: str,
    wait_for: str = "networkidle",
    timeout: int = 30,
    ctx: Context = None,
) -> str:
    err = _check_bin()
    if err:
        return f"[browser_pdf] Error: {err}"

    name = uuid.uuid4().hex
    outfile = _out_dir() / f"{name}.pdf"
    rc, stdout, stderr = await _run(
        [_BIN, "pdf", "--wait", wait_for, "--output", str(outfile), url],
        timeout=timeout + 5,
    )
    if rc != 0:
        return f"[browser_pdf] Failed (exit {rc}): {stderr.strip() or stdout.strip()}"
    if not outfile.exists():
        return f"[browser_pdf] No output file produced"

    base = _proxy_base(ctx)
    return f"PDF saved: {outfile}\nProxy URL: {base}/api/obscura/{name}.pdf"
