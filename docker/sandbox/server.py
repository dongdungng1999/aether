"""
Aether — sandbox HTTP API.

Endpoints
---------
POST /exec                          { "language":"python|bash|node",
                                      "code":"...",
                                      "cwd": "/abs/path",      # optional
                                      "timeout": 30,
                                      "env": {...} }
                                    -> { stdout, stderr, exit_code, duration_ms }

GET  /health                        -> { "ok": true }
GET  /info                          -> python/node versions + cwd

GET  /artifacts/<chat_id>           -> { "files": [{name, size, mtime}, ...] }
GET  /artifacts/<chat_id>/<name>    -> raw bytes of the file (Content-Type guessed)

The container's filesystem boundary IS the security boundary. The
artifact endpoints serve files from /home/aura-artifacts/<chat_id>/
exclusively — chat_id and name are validated to block path traversal.
Listing surfaces only basenames; symlinks aren't followed for the file
read so a model can't escape its own per-chat dir by symlinking.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_CWD     = Path(os.environ.get("AURA_DEFAULT_CWD",     "/tmp/aura-artifacts"))
DEFAULT_TIMEOUT = int(os.environ.get("AURA_DEFAULT_TIMEOUT", "30"))
MAX_TIMEOUT     = int(os.environ.get("AURA_MAX_TIMEOUT",    "300"))

# Per-chat scratch dir. Pinned to /tmp because /home is bind-mounted from
# the host's HOME (so the running user's chats can be reached from the
# host file picker etc.), and host-uid vs container-uid mismatch causes
# `mkdir /home/aura-artifacts/<chatId>` to EACCES (#F10b in 0.4.2).
# /tmp is always writable inside the container regardless of UID.
ARTIFACTS_ROOT  = Path(os.environ.get("AURA_ARTIFACTS_ROOT", "/tmp/aura-artifacts"))

# Quick mime guess for the artifact GET — the stdlib mimetypes table is
# fine for the file types Aether actually emits.
import mimetypes as _mimetypes
import re as _re

_CHAT_ID_RE  = _re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_FILENAME_RE = _re.compile(r"^[^/\\]+$")


def _exec(language: str, code: str, cwd: str | None, timeout: int, env: dict) -> dict:
    if language not in ("python", "bash", "node"):
        return {"stdout": "", "stderr": f"unsupported language: {language}",
                "exit_code": 2, "duration_ms": 0}

    work = Path(cwd) if cwd else DEFAULT_CWD
    try:
        work = work.resolve()
        work.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return {"stdout": "", "stderr": f"cwd unusable: {e}",
                "exit_code": 2, "duration_ms": 0}

    timeout = max(1, min(timeout or DEFAULT_TIMEOUT, MAX_TIMEOUT))

    full_env = os.environ.copy()
    full_env.update({k: str(v) for k, v in (env or {}).items()})
    full_env.setdefault("HOME", "/home")
    full_env.setdefault("PATH",
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")

    if language == "python":
        argv = [sys.executable, "-u", "-c", code]
    elif language == "node":
        argv = ["node", "-e", code]
    else:
        argv = ["bash", "-lc", code]

    t0 = time.monotonic()
    try:
        proc = subprocess.Popen(
            argv,
            cwd=str(work),
            env=full_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            exit_code = proc.returncode
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            stdout, stderr = proc.communicate()
            exit_code = 124
            stderr = (stderr or b"") + f"\n[sandbox] killed after {timeout}s\n".encode()
    except FileNotFoundError as e:
        return {"stdout": "", "stderr": f"interpreter missing: {e}",
                "exit_code": 127, "duration_ms": 0}
    duration_ms = int((time.monotonic() - t0) * 1000)

    return {
        "stdout":      stdout.decode("utf-8", "replace"),
        "stderr":      stderr.decode("utf-8", "replace"),
        "exit_code":   exit_code,
        "duration_ms": duration_ms,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[sandbox] " + (fmt % args) + "\n")

    def _send_json(self, code: int, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        # Same CORS as the file route — webview is on a different origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send_json(200, {"ok": True})
        if self.path == "/info":
            try:
                node_v = subprocess.check_output(["node", "-v"], timeout=2).decode().strip()
            except Exception:
                node_v = "missing"
            return self._send_json(200, {
                "python":    sys.version.split()[0],
                "node":      node_v,
                "cwd":       str(DEFAULT_CWD),
                "artifacts": str(ARTIFACTS_ROOT),
            })
        # /artifacts/<chat_id>           → JSON listing
        # /artifacts/<chat_id>/<name>    → raw bytes
        # Strip query string (?ts=… cache-busting from the webview).
        raw_path = self.path.split("?", 1)[0]
        if raw_path.startswith("/artifacts/"):
            return self._handle_artifact(raw_path)
        return self._send_json(404, {"error": "unknown route"})

    def _handle_artifact(self, raw_path: str):
        rest = raw_path[len("/artifacts/"):]
        parts = rest.split("/", 1)
        chat_id = parts[0]
        if not _CHAT_ID_RE.match(chat_id):
            return self._send_json(400, {"error": "invalid chat_id"})
        chat_dir = (ARTIFACTS_ROOT / chat_id).resolve()
        try:
            chat_dir.relative_to(ARTIFACTS_ROOT.resolve())
        except ValueError:
            return self._send_json(400, {"error": "invalid chat_id"})
        if not chat_dir.is_dir():
            # Empty listing rather than 404 — first-time chat with no
            # output yet shows no card; webview just polls again later.
            return self._send_json(200, {"files": [], "chat_id": chat_id})

        if len(parts) == 1 or parts[1] == "":
            # Listing route — newest first, basenames only.
            entries = []
            for p in sorted(chat_dir.iterdir(), key=lambda x: -x.stat().st_mtime):
                if not p.is_file():
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                entries.append({
                    "name":  p.name,
                    "size":  st.st_size,
                    "mtime": int(st.st_mtime * 1000),
                })
            return self._send_json(200, {"files": entries, "chat_id": chat_id})

        # File route.
        name = parts[1]
        if not _FILENAME_RE.match(name) or name in (".", ".."):
            return self._send_json(400, {"error": "invalid filename"})
        target = chat_dir / name
        if target.is_symlink() or not target.is_file():
            return self._send_json(404, {"error": "file not found"})
        try:
            target.resolve().relative_to(chat_dir)
        except ValueError:
            return self._send_json(400, {"error": "path traversal blocked"})

        ctype, _ = _mimetypes.guess_type(name)
        if not ctype:
            ctype = "application/octet-stream"
        try:
            data = target.read_bytes()
        except OSError as e:
            return self._send_json(500, {"error": f"read failed: {e}"})
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Force browser download for non-previewable types so the user
        # gets a real Save dialog from the webview.
        if not ctype.startswith(("image/", "text/", "application/json", "application/pdf")):
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        # CORS — the webview is served from a `vscode-webview://...` origin
        # while this endpoint is `127.0.0.1:8829`, so the fetch is
        # cross-origin. The webview uses simple GETs only; allowing * is
        # safe because the sandbox already binds to loopback (or whatever
        # the host port-maps).
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/exec":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            except json.JSONDecodeError:
                return self._send_json(400, {"error": "invalid JSON"})
            return self._send_json(200, _exec(
                language=payload.get("language", "python"),
                code=payload.get("code", ""),
                cwd=payload.get("cwd"),
                timeout=int(payload.get("timeout") or DEFAULT_TIMEOUT),
                env=payload.get("env") or {},
            ))
        return self._send_json(404, {"error": "unknown route"})


if __name__ == "__main__":
    port = int(os.environ.get("SANDBOX_PORT", "8765"))
    addr = ("0.0.0.0", port)
    print(f"[sandbox] listening on {addr[0]}:{addr[1]}, default-cwd={DEFAULT_CWD}",
          file=sys.stderr, flush=True)
    ThreadingHTTPServer(addr, Handler).serve_forever()
