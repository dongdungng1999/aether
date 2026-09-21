#!/usr/bin/env python3
"""
MinerU MCP Server — dual mode:

  LOCAL  mode: gọi mineru CLI trực tiếp (máy có MinerU + models)
  REMOTE mode: gọi MinerU FastAPI qua HTTP (máy khác, chỉ cần mcp + httpx)

Chọn mode qua env var:
  MINERU_API_URL=http://<host>:8888   → REMOTE mode
  (không set)                          → LOCAL mode
"""

import asyncio
import base64
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

# ── Config ────────────────────────────────────────────────────────────────────
MINERU_API_URL = os.environ.get("MINERU_API_URL", "").rstrip("/")
IS_REMOTE = bool(MINERU_API_URL)

# LOCAL mode: path tới venv python của MinerU
VENV_PYTHON = os.environ.get(
    "MINERU_VENV_PYTHON",
    str(Path(__file__).parent.parent / ".venv" / "bin" / "python3")
)

app = Server("mineru")


# ── Tool definitions ──────────────────────────────────────────────────────────

@app.list_tools()
async def list_tools() -> list[types.Tool]:
    mode_note = (
        f"[REMOTE mode → {MINERU_API_URL}]" if IS_REMOTE
        else "[LOCAL mode]"
    )
    return [
        types.Tool(
            name="parse_document",
            description=(
                f"Parse a document (PDF, image, DOCX, PPTX, XLSX) using MinerU {mode_note}. "
                "Returns extracted Markdown text and structured content."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the document file to parse.",
                    },
                    "backend": {
                        "type": "string",
                        "description": "Parsing backend: 'hybrid-engine' (recommended, pipeline+VLM local GPU), 'pipeline' (fast, no VLM), 'vlm-engine' (pure VLM local), 'vlm-http-client' / 'hybrid-http-client' (remote OpenAI-compatible VLM).",
                        "default": "hybrid-engine",
                        "enum": ["hybrid-engine", "pipeline", "vlm-engine", "vlm-http-client", "hybrid-http-client"],
                    },
                    "effort": {
                        "type": "string",
                        "description": "Hybrid effort level (only for hybrid-engine / hybrid-http-client): 'medium' or 'high'. Default: 'medium'.",
                        "default": "medium",
                        "enum": ["medium", "high"],
                    },
                    "parse_method": {
                        "type": "string",
                        "description": "PDF parse method: 'auto', 'txt', 'ocr'. Default: 'auto'.",
                        "default": "auto",
                        "enum": ["auto", "txt", "ocr"],
                    },
                    "lang": {
                        "type": "string",
                        "description": "Language hint for OCR: 'en', 'ch', 'japan', etc. Default: 'ch'.",
                        "default": "ch",
                    },
                    "start_page": {
                        "type": "integer",
                        "description": "Start page (0-indexed). Default: 0.",
                        "default": 0,
                    },
                    "end_page": {
                        "type": "integer",
                        "description": "End page (0-indexed, inclusive). Default: 99999.",
                        "default": 99999,
                    },
                    "formula_enable": {
                        "type": "boolean",
                        "description": "Enable formula parsing. Default: true.",
                        "default": True,
                    },
                    "table_enable": {
                        "type": "boolean",
                        "description": "Enable table parsing. Default: true.",
                        "default": True,
                    },
                    "output_dir": {
                        "type": "string",
                        "description": "Directory to save output. If omitted, uses a temp dir (LOCAL) or discarded (REMOTE).",
                    },
                    "return_images": {
                        "type": "boolean",
                        "description": "Include extracted images (base64) in response. Default: false.",
                        "default": False,
                    },
                },
                "required": ["file_path"],
            },
        ),
        types.Tool(
            name="parse_document_url",
            description=(
                f"Download a document from URL then parse with MinerU {mode_note}. "
                "Supports PDF, images, DOCX, PPTX, XLSX."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "URL of the document to download and parse.",
                    },
                    "backend": {
                        "type": "string",
                        "description": "Parsing backend: 'hybrid-engine' (recommended), 'pipeline', 'vlm-engine', 'vlm-http-client', 'hybrid-http-client'.",
                        "default": "hybrid-engine",
                        "enum": ["hybrid-engine", "pipeline", "vlm-engine", "vlm-http-client", "hybrid-http-client"],
                    },
                    "parse_method": {
                        "type": "string",
                        "description": "PDF parse method: 'auto', 'txt', 'ocr'.",
                        "default": "auto",
                        "enum": ["auto", "txt", "ocr"],
                    },
                    "lang": {
                        "type": "string",
                        "description": "Language hint for OCR. Default: 'ch'.",
                        "default": "ch",
                    },
                },
                "required": ["url"],
            },
        ),
        types.Tool(
            name="mineru_info",
            description="Get MinerU version, mode (local/remote), and available backends.",
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="parse_document_submit",
            description=(
                f"Submit a document parse job to MinerU {mode_note} and return a task_id immediately. "
                "Use for hybrid-engine (15-30 min) — model polls status then fetches result. "
                "Use parse_document_status(task_id) to check progress, parse_document_fetch(task_id, output_dir) to retrieve result."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Absolute path to the document file."},
                    "backend": {
                        "type": "string",
                        "description": "Parsing backend. Default: 'hybrid-engine'.",
                        "default": "hybrid-engine",
                        "enum": ["hybrid-engine", "pipeline", "vlm-engine", "vlm-http-client", "hybrid-http-client"],
                    },
                    "output_dir": {"type": "string", "description": "Directory to save output when fetching. Required for parse_document_fetch."},
                    "lang": {"type": "string", "description": "Language hint for OCR. Default: 'ch'.", "default": "ch"},
                    "start_page": {"type": "integer", "description": "Start page (0-indexed). Default: 0.", "default": 0},
                    "end_page": {"type": "integer", "description": "End page (inclusive). Default: 99999.", "default": 99999},
                    "formula_enable": {"type": "boolean", "description": "Enable formula parsing. Default: false for hybrid (avoids tensor bug).", "default": False},
                    "table_enable": {"type": "boolean", "description": "Enable table parsing. Default: true.", "default": True},
                },
                "required": ["file_path"],
            },
        ),
        types.Tool(
            name="parse_document_status",
            description=(
                f"Check the status of a MinerU parse job {mode_note}. "
                "Returns status (pending/processing/completed/failed), elapsed time, and queue position."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "Task ID returned by parse_document_submit."},
                },
                "required": ["task_id"],
            },
        ),
        types.Tool(
            name="parse_document_fetch",
            description=(
                f"Fetch and save the result of a completed MinerU parse job {mode_note}. "
                "Downloads the ZIP result, extracts to output_dir, returns markdown file path and image count."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "Task ID from parse_document_submit."},
                    "output_dir": {"type": "string", "description": "Directory to extract output into."},
                },
                "required": ["task_id", "output_dir"],
            },
        ),
    ]


# ── Tool dispatcher ───────────────────────────────────────────────────────────

@app.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    if name == "mineru_info":
        return await _handle_info()
    if name == "parse_document":
        if IS_REMOTE:
            return await _remote_parse_file(arguments)
        return await _local_parse_document(arguments)
    if name == "parse_document_url":
        if IS_REMOTE:
            return await _remote_parse_url(arguments)
        return await _local_parse_url(arguments)
    if name == "parse_document_submit":
        if IS_REMOTE:
            return await _remote_submit(arguments)
        return [types.TextContent(type="text", text="❌ parse_document_submit only supported in REMOTE mode.")]
    if name == "parse_document_status":
        if IS_REMOTE:
            return await _remote_task_status(arguments)
        return [types.TextContent(type="text", text="❌ parse_document_status only supported in REMOTE mode.")]
    if name == "parse_document_fetch":
        if IS_REMOTE:
            return await _remote_task_fetch(arguments)
        return [types.TextContent(type="text", text="❌ parse_document_fetch only supported in REMOTE mode.")]
    raise ValueError(f"Unknown tool: {name}")


# ── Info ──────────────────────────────────────────────────────────────────────

async def _handle_info() -> list[types.TextContent]:
    info: dict[str, Any] = {
        "mode": "remote" if IS_REMOTE else "local",
        "supported_formats": ["pdf", "png", "jpg", "jpeg", "webp", "bmp",
                               "gif", "tiff", "docx", "pptx", "xlsx"],
        "backends": {
            "hybrid-engine": "Recommended — pipeline layout + VLM for tables/formulas/images (local GPU)",
            "pipeline": "Fast, CPU-friendly, multi-language, no VLM",
            "vlm-engine": "Pure local VLM (GPU required)",
            "vlm-http-client": "Remote VLM via OpenAI-compatible server",
            "hybrid-http-client": "pipeline layout + remote VLM via OpenAI-compatible server",
        },
    }

    if IS_REMOTE:
        info["api_url"] = MINERU_API_URL
        # Ping /health
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get(f"{MINERU_API_URL}/health")
                info["server_health"] = r.json()
        except Exception as e:
            info["server_health"] = f"unreachable: {e}"
    else:
        import subprocess
        r = subprocess.run(
            [VENV_PYTHON, "-c",
             "from mineru.version import __version__; print(__version__)"],
            capture_output=True, text=True
        )
        info["version"] = r.stdout.strip() or "unknown"
        info["venv_python"] = VENV_PYTHON

    return [types.TextContent(type="text", text=json.dumps(info, indent=2))]


# ══════════════════════════════════════════════════════════════════════════════
# LOCAL mode
# ══════════════════════════════════════════════════════════════════════════════

def _run_mineru_cli(args: list[str]) -> tuple[int, str, str]:
    import subprocess
    cmd = [VENV_PYTHON, "-m", "mineru.cli.client"] + args
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    return result.returncode, result.stdout, result.stderr


def _collect_output(output_dir: Path) -> dict[str, Any]:
    data: dict[str, Any] = {}
    md_files = list(output_dir.rglob("*.md"))
    if md_files:
        main_md = next((f for f in md_files if "middle" not in f.name), md_files[0])
        data["markdown"] = main_md.read_text(encoding="utf-8", errors="replace")
    cl_files = list(output_dir.rglob("*content_list*.json"))
    if cl_files:
        try:
            data["content_list"] = json.loads(cl_files[0].read_text())
        except Exception:
            pass
    img_dir = next(output_dir.rglob("images"), None) if True else None
    for d in output_dir.rglob("images"):
        if d.is_dir():
            imgs = [f for f in sorted(d.iterdir())
                    if f.suffix.lower() in {".png",".jpg",".jpeg",".webp"}]
            data["images_count"] = len(imgs)
            data["images"] = [
                {"name": f.name, "base64": base64.b64encode(f.read_bytes()).decode()}
                for f in imgs[:10]
            ]
            break
    return data


async def _local_parse_document(args: dict[str, Any]) -> list[types.TextContent]:
    file_path = Path(args["file_path"])
    if not file_path.exists():
        return [types.TextContent(type="text", text=f"❌ File not found: {file_path}")]

    backend       = args.get("backend", "hybrid-engine")
    parse_method  = args.get("parse_method", "auto")
    lang          = args.get("lang", "ch")
    start_page    = args.get("start_page", 0)
    end_page      = args.get("end_page", 99999)
    formula       = args.get("formula_enable", True)
    table         = args.get("table_enable", True)
    return_images = args.get("return_images", False)

    user_out = args.get("output_dir")
    tmp_dir  = None
    if user_out:
        out_dir = Path(user_out)
        out_dir.mkdir(parents=True, exist_ok=True)
    else:
        tmp_dir = tempfile.mkdtemp(prefix="mineru_mcp_")
        out_dir = Path(tmp_dir)

    try:
        cli_args = [
            "-p", str(file_path),
            "-o", str(out_dir),
            "-b", backend,
            "-m", parse_method,
            "-l", lang,
            "-s", str(start_page),
            "-e", str(end_page),
            "-f", str(formula).lower(),
            "-t", str(table).lower(),
        ]
        loop = asyncio.get_event_loop()
        rc, stdout, stderr = await loop.run_in_executor(
            None, lambda: _run_mineru_cli(cli_args)
        )
        if rc != 0:
            return [types.TextContent(
                type="text",
                text=f"❌ MinerU parse failed (exit {rc}):\n{stderr[-3000:]}"
            )]

        data = _collect_output(out_dir)
        resp: dict[str, Any] = {
            "status": "success",
            "mode": "local",
            "file": str(file_path),
            "output_dir": str(out_dir) if user_out else "(temp)",
        }
        if "markdown"     in data: resp["markdown"]     = data["markdown"]
        if "content_list" in data: resp["content_list"] = data["content_list"]
        if return_images and "images" in data:
            resp["images"]       = data["images"]
            resp["images_total"] = data.get("images_count", 0)

        return [types.TextContent(type="text",
                text=json.dumps(resp, ensure_ascii=False, indent=2))]
    finally:
        if tmp_dir:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)


async def _local_parse_url(args: dict[str, Any]) -> list[types.TextContent]:
    import urllib.request, urllib.parse
    url = args["url"]
    parsed = urllib.parse.urlparse(url)
    filename = Path(parsed.path).name or "document"
    if not Path(filename).suffix:
        filename += ".pdf"

    tmp = tempfile.mkdtemp(prefix="mineru_url_")
    try:
        local = Path(tmp) / filename
        try:
            urllib.request.urlretrieve(url, str(local))
        except Exception as e:
            return [types.TextContent(type="text", text=f"❌ Download failed: {e}")]
        new_args = {**args, "file_path": str(local)}
        new_args.pop("url", None)
        result = await _local_parse_document(new_args)
        # tag source_url
        try:
            d = json.loads(result[0].text)
            d["source_url"] = url
            return [types.TextContent(type="text",
                    text=json.dumps(d, ensure_ascii=False, indent=2))]
        except Exception:
            return result
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════════
# REMOTE mode  —  gọi MinerU FastAPI server qua HTTP
# ══════════════════════════════════════════════════════════════════════════════

async def _remote_parse_bytes(
    file_bytes: bytes,
    filename: str,
    args: dict[str, Any],
) -> list[types.TextContent]:
    """Submit tới /tasks, poll đến khi xong, extract zip ra output_dir."""
    import httpx
    import zipfile
    import io

    backend      = args.get("backend", "hybrid-engine")
    parse_method = args.get("parse_method", "auto")
    lang         = args.get("lang", "ch")
    start_page   = args.get("start_page", 0)
    end_page     = args.get("end_page", 99999)
    formula      = args.get("formula_enable", True)
    table        = args.get("table_enable", True)
    output_dir   = args.get("output_dir")

    stem = Path(filename).stem

    # output_dir bắt buộc — không có thì dùng temp
    if output_dir:
        out_path = Path(output_dir)
    else:
        out_path = Path(tempfile.mkdtemp(prefix="mineru_mcp_")) / stem

    out_path.mkdir(parents=True, exist_ok=True)

    form = {
        "backend":        backend,
        "parse_method":   parse_method,
        "lang_list":      lang,
        "start_page_id":  str(start_page),
        "end_page_id":    str(end_page),
        "formula_enable": str(formula).lower(),
        "table_enable":   str(table).lower(),
        "return_md":      "true",
        "return_images":  "true",
        "response_format_zip": "true",
    }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            # Submit task
            r = await client.post(
                f"{MINERU_API_URL}/tasks",
                data=form,
                files={"files": (filename, file_bytes)},
            )
            if r.status_code not in (200, 202):
                return [types.TextContent(type="text",
                    text=f"❌ Submit failed {r.status_code}:\n{r.text[:2000]}")]
            task_id = r.json()["task_id"]

        # Poll until done (no client timeout — file lớn có thể mất hàng chục phút)
        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                await asyncio.sleep(10)
                st = await client.get(f"{MINERU_API_URL}/tasks/{task_id}")
                info = st.json()
                status = info.get("status")
                if status == "failed":
                    return [types.TextContent(type="text",
                        text=f"❌ Parse failed: {info.get('error', 'unknown')}")]
                if status == "completed":
                    break

        # Download zip result
        async with httpx.AsyncClient(timeout=300) as client:
            dl = await client.get(
                f"{MINERU_API_URL}/tasks/{task_id}/result",
                headers={"Accept": "application/zip"},
            )

        # Extract zip vào output_dir
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            zf.extractall(out_path)

        # Tìm markdown file — prefer the main md (skip MinerU's "*middle*.md"
        # intermediate dump), matching _collect_output()'s selection.
        md_files = list(out_path.rglob("*.md"))
        img_files = list(out_path.rglob("*.jpg")) + list(out_path.rglob("*.png"))
        main_md = None
        if md_files:
            main_md = next((f for f in md_files if "middle" not in f.name), md_files[0])

        resp: dict[str, Any] = {
            "status":       "success",
            "mode":         "remote",
            "server":       MINERU_API_URL,
            "file":         filename,
            "output_dir":   str(out_path),
            "markdown_file": str(main_md) if main_md else None,
            # The extension's AttachmentParser unwraps `markdown` (or `result`)
            # and feeds it to the model. Returning only the path left it with
            # no content to attach (parse succeeded but nothing was sent).
            "markdown":     main_md.read_text(encoding="utf-8", errors="replace") if main_md else "",
            "images_count": len(img_files),
        }
        return [types.TextContent(type="text",
                text=json.dumps(resp, ensure_ascii=False, indent=2))]

    except Exception as e:
        return [types.TextContent(type="text", text=f"❌ Request failed: {e}")]


async def _remote_parse_file(args: dict[str, Any]) -> list[types.TextContent]:
    file_path = Path(args["file_path"])
    if not file_path.exists():
        return [types.TextContent(type="text", text=f"❌ File not found: {file_path}")]
    file_bytes = file_path.read_bytes()
    return await _remote_parse_bytes(file_bytes, file_path.name, args)


async def _remote_parse_url(args: dict[str, Any]) -> list[types.TextContent]:
    import urllib.request, urllib.parse
    url = args["url"]
    parsed   = urllib.parse.urlparse(url)
    filename = Path(parsed.path).name or "document"
    if not Path(filename).suffix:
        filename += ".pdf"
    try:
        import urllib.request as ur
        with ur.urlopen(url, timeout=60) as resp:
            file_bytes = resp.read()
    except Exception as e:
        return [types.TextContent(type="text", text=f"❌ Download failed: {e}")]

    result = await _remote_parse_bytes(file_bytes, filename, args)
    try:
        d = json.loads(result[0].text)
        d["source_url"] = url
        return [types.TextContent(type="text",
                text=json.dumps(d, ensure_ascii=False, indent=2))]
    except Exception:
        return result


async def _remote_submit(args: dict[str, Any]) -> list[types.TextContent]:
    """Submit parse job, return task_id immediately without waiting."""
    import httpx
    from datetime import datetime, timezone

    file_path = Path(args["file_path"])
    if not file_path.exists():
        return [types.TextContent(type="text", text=f"❌ File not found: {file_path}")]

    form = {
        "backend":        args.get("backend", "hybrid-engine"),
        "parse_method":   args.get("parse_method", "auto"),
        "lang_list":      args.get("lang", "ch"),
        "start_page_id":  str(args.get("start_page", 0)),
        "end_page_id":    str(args.get("end_page", 99999)),
        "formula_enable": str(args.get("formula_enable", False)).lower(),
        "table_enable":   str(args.get("table_enable", True)).lower(),
        "return_md":      "true",
        "return_images":  "true",
        "response_format_zip": "true",
    }
    try:
        file_bytes = file_path.read_bytes()
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{MINERU_API_URL}/tasks",
                data=form,
                files={"files": (file_path.name, file_bytes)},
            )
        if r.status_code not in (200, 202):
            return [types.TextContent(type="text",
                text=f"❌ Submit failed {r.status_code}:\n{r.text[:2000]}")]
        info = r.json()
        resp = {
            "task_id":      info["task_id"],
            "file":         file_path.name,
            "backend":      args.get("backend", "hybrid-engine"),
            "output_dir":   args.get("output_dir"),
            "submitted_at": datetime.now(timezone.utc).isoformat(),
            "status_hint":  "Use parse_document_status(task_id) to poll, parse_document_fetch(task_id, output_dir) when completed.",
        }
        return [types.TextContent(type="text", text=json.dumps(resp, ensure_ascii=False, indent=2))]
    except Exception as e:
        return [types.TextContent(type="text", text=f"❌ Submit failed: {e}")]


async def _remote_task_status(args: dict[str, Any]) -> list[types.TextContent]:
    """Check status of a submitted parse task."""
    import httpx
    from datetime import datetime, timezone

    task_id = args.get("task_id", "").strip()
    if not task_id:
        return [types.TextContent(type="text", text="❌ task_id is required.")]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{MINERU_API_URL}/tasks/{task_id}")
        if r.status_code == 404:
            return [types.TextContent(type="text",
                text=json.dumps({"task_id": task_id, "status": "not_found",
                    "hint": "Task may have expired (24h retention) or ID is wrong."}))]
        if r.status_code != 200:
            return [types.TextContent(type="text",
                text=f"❌ Status check failed {r.status_code}:\n{r.text[:1000]}")]
        info = r.json()
        # Compute elapsed seconds if started
        elapsed = None
        started = info.get("started_at")
        if started:
            try:
                from datetime import datetime, timezone
                start_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
                completed = info.get("completed_at")
                end_dt = datetime.fromisoformat(completed.replace("Z", "+00:00")) if completed else datetime.now(timezone.utc)
                elapsed = int((end_dt - start_dt).total_seconds())
            except Exception:
                pass
        resp = {
            "task_id":       task_id,
            "status":        info.get("status"),
            "queued_ahead":  info.get("queued_ahead", 0),
            "elapsed_seconds": elapsed,
            "error":         info.get("error"),
        }
        if info.get("status") == "completed":
            resp["hint"] = "Call parse_document_fetch(task_id, output_dir) to retrieve result."
        elif info.get("status") == "processing":
            resp["hint"] = "Still processing. Poll again in 15-30 seconds."
        elif info.get("status") == "pending":
            resp["hint"] = f"Queued ({info.get('queued_ahead', 0)} ahead). Poll again in 10 seconds."
        return [types.TextContent(type="text", text=json.dumps(resp, ensure_ascii=False, indent=2))]
    except Exception as e:
        return [types.TextContent(type="text", text=f"❌ Status check failed: {e}")]


async def _remote_task_fetch(args: dict[str, Any]) -> list[types.TextContent]:
    """Fetch completed task result: download ZIP, extract to output_dir."""
    import httpx
    import zipfile
    import io

    task_id = args.get("task_id", "").strip()
    output_dir = args.get("output_dir", "")
    if not task_id:
        return [types.TextContent(type="text", text="❌ task_id is required.")]
    if not output_dir:
        return [types.TextContent(type="text", text="❌ output_dir is required.")]

    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    try:
        # Verify task is completed first
        async with httpx.AsyncClient(timeout=15) as client:
            st = await client.get(f"{MINERU_API_URL}/tasks/{task_id}")
        if st.status_code == 404:
            return [types.TextContent(type="text",
                text=json.dumps({"status": "error", "error": "Task not found or expired."}))]
        info = st.json()
        if info.get("status") != "completed":
            return [types.TextContent(type="text",
                text=json.dumps({"status": "not_ready", "task_status": info.get("status"),
                    "hint": "Task not completed yet. Check parse_document_status first."}))]

        # Download ZIP
        async with httpx.AsyncClient(timeout=300) as client:
            dl = await client.get(
                f"{MINERU_API_URL}/tasks/{task_id}/result",
                headers={"Accept": "application/zip"},
            )
        if dl.status_code != 200:
            return [types.TextContent(type="text",
                text=f"❌ Download failed {dl.status_code}:\n{dl.text[:1000]}")]

        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            zf.extractall(out_path)

        md_files  = list(out_path.rglob("*.md"))
        img_files = list(out_path.rglob("*.jpg")) + list(out_path.rglob("*.png"))

        resp = {
            "status":        "success",
            "task_id":       task_id,
            "output_dir":    str(out_path),
            "markdown_file": str(md_files[0]) if md_files else None,
            "images_count":  len(img_files),
        }
        return [types.TextContent(type="text", text=json.dumps(resp, ensure_ascii=False, indent=2))]
    except Exception as e:
        return [types.TextContent(type="text", text=f"❌ Fetch failed: {e}")]


# ── Entry point ───────────────────────────────────────────────────────────────

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
