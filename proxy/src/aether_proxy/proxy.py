"""
proxy.py — Aether Proxy Server

Translates Claude Code's Anthropic API calls into OpenAI-compatible (or
native Anthropic) requests for whichever upstream provider is connected at
runtime via POST /admin/provider. There is no bundled default backend.

Architecture:
    Claude Code  →  POST /v1/messages (Anthropic format)
                 →  [this proxy]
                 →  POST /chat/completions or /messages (OpenAI/Anthropic format)
                 →  the connected provider
"""

import asyncio
import collections
from datetime import datetime, timezone
import json
import logging
import os
import random
import re
import threading
import time
import pathlib
import uuid
from contextlib import asynccontextmanager
import httpx
import yaml
from fastapi import FastAPI, Request, Response, UploadFile, File
import shutil

# v3: Strategy-based thinking-mode injection
from .thinking import ThinkingRouter, parse_effort_command

# v5: Responses API adapter for GPT-5.5 / GPT-5.4 reasoning models.
# Falls back to a no-op shim when the module isn't present so the proxy
# still works in pure-Claude mode.
try:
    from .responses_adapter import (
        anthropic_to_responses_request,
        responses_to_anthropic_response,
        stream_responses_to_anthropic,
    )
    RESPONSES_API_ENABLED = True
except ImportError:
    RESPONSES_API_ENABLED = False

# ---------------------------------------------------------------------------
# Config  (loaded before logging so log level can be read from config)
# ---------------------------------------------------------------------------

# Config lookup order:
#   1. AURA_CONFIG env var (absolute path)            — used by Docker/CI
#   2. <project_root>/configs/host.yaml              — installed/dev layout
#   3. <package_dir>/host.yaml                       — fallback for legacy
_PKG_DIR     = os.path.dirname(__file__)
_PROJECT_DIR = os.path.dirname(os.path.dirname(_PKG_DIR))   # …/src/aether_proxy → project root
CONFIG_FILE  = (
    os.environ.get("AURA_CONFIG")
    or (
        os.path.join(_PROJECT_DIR, "configs", "container.yaml")
        if os.path.exists(os.path.join(_PROJECT_DIR, "configs", "container.yaml"))
        else os.path.join(_PKG_DIR, "container.yaml")
    )
)
with open(CONFIG_FILE) as _f:
    CONFIG = yaml.safe_load(_f)

# Endpoints + routing — host.yaml drives these via env vars, container.yaml
# is just a fallback. JSON shape mirrors the yaml section. Missing vars =
# silently use container.yaml. (#yaml-audit in 0.4.2)
def _json_env(name: str, fallback: dict | list | None) -> dict | list:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return fallback if fallback is not None else {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        import sys
        print(f"[WARN] {name} is not valid JSON ({e}) — falling back to container.yaml", file=sys.stderr)
        return fallback if fallback is not None else {}

_ENDPOINTS     = _json_env("AURA_ENDPOINTS",        CONFIG.get("endpoints", {}) or {})
_ROUTING       = _json_env("AURA_ROUTING",          CONFIG.get("routing",   {}) or {})
# No bundled default backend — these are only ever populated by host-driven
# config (AURA_ENDPOINTS / container.yaml `endpoints:`), and only matter for
# the (currently unreachable) "default" provider mode. See _ACTIVE_PROVIDER
# and the fail-closed check in proxy_messages() for the actual upstream
# resolution, which now always goes through POST /admin/provider.
TARGET_URL     = _ENDPOINTS.get("api_chat")
OPENAI_CHAT_URL = _ENDPOINTS.get("openai_chat")
# v6: Anthropic-native endpoint. Accepts the Anthropic /v1/messages shape
# and returns Anthropic SSE — no double conversion.
ANTHROPIC_URL  = _ENDPOINTS.get("native_messages")
# v5: GPT-5.5/5.4-style reasoning models only work via /openai/responses.
# Chat Completions rejects function tools for these models on backends that
# inject a mandatory `reasoning_effort` (observed on Databricks-backed hosts).
RESPONSES_URL  = _ENDPOINTS.get("responses_api")
DEFAULT_MODEL  = CONFIG.get("default_model") or "unset-model"
PROXY_HOST        = CONFIG["proxy"]["host"]
PROXY_PORT        = int(os.environ.get("PROXY_PORT") or CONFIG["proxy"]["port"])
PROXY_TIMEOUT     = CONFIG["proxy"]["timeout"]
PROXY_CONCURRENCY = int(CONFIG["proxy"].get("concurrency", 1))
# Local inference backend used by claude-mem's worker when claude_mem.local=1
# (see entrypoint.sh / host-linux.yaml). Same default as aura.sh's --lc flag.
LC_URL            = os.environ.get("LC_URL", "http://10.231.19.12:8900").rstrip("/")
# LLM backend map for /lc model-name routing: name → machine bridge URL
# (JSON via AURA_LLM_BACKENDS, set by run.sh from host yaml llm.backends).
# A request whose model name contains a backend key (e.g. "qwen3.8-27b"
# contains "qwen3.8") goes to that machine; longest key wins. The bridge
# ignores the model name itself (it resolves the loaded model from the
# dashboard), so a bare key like "qwen3.6" works as a routing tag.
LLM_BACKENDS      = _json_env("AURA_LLM_BACKENDS", {})

def _lc_backend_url(model: str) -> str:
    best_name, best_url = None, LC_URL
    if not LLM_BACKENDS or not model:
        return LC_URL
    ml = model.lower()
    for name, url in LLM_BACKENDS.items():
        if name and name.lower() in ml and (best_name is None or len(name) > len(best_name)):
            best_name, best_url = name, url
    return best_url
RETRY_BASE_DELAY = CONFIG["retry"]["base_delay"]
RETRY_MAX_DELAY  = CONFIG["retry"]["max_delay"]
RETRY_MAX_WAIT   = CONFIG["retry"]["max_wait"]
# Model map: AURA_MODEL_MAP env var (JSON) takes priority over container.yaml.
# This lets run.sh pass the host's host.yaml model section into the container
# without rebuilding the image.
_model_map_env = os.environ.get("AURA_MODEL_MAP", "").strip()
if _model_map_env:
    try:
        MODEL_MAP: dict[str, str] = json.loads(_model_map_env)
    except json.JSONDecodeError as _e:
        import sys
        print(f"[WARN] AURA_MODEL_MAP is not valid JSON ({_e}) — falling back to container.yaml", file=sys.stderr)
        MODEL_MAP = CONFIG.get("models", {})
else:
    MODEL_MAP: dict[str, str] = CONFIG.get("models", {})

# 0.4.177 — per-model max_tokens ceiling. Client-supplied max_tokens takes
# priority; this map is only the fallback when a request omits max_tokens
# (or a thinking strategy needs to derive a baseline). Falls back to
# `default` and then to a conservative 8192 if neither is set.
_MODEL_MAX_TOKENS: dict = _json_env("AURA_MODEL_MAX_TOKENS", CONFIG.get("model_max_tokens", {}) or {})

def fallback_max_tokens(model: str) -> int:
    if not model:
        return int(_MODEL_MAX_TOKENS.get("default", 8192))
    norm = model.replace("databricks-", "")
    if norm in _MODEL_MAX_TOKENS:
        return int(_MODEL_MAX_TOKENS[norm])
    if model in _MODEL_MAX_TOKENS:
        return int(_MODEL_MAX_TOKENS[model])
    return int(_MODEL_MAX_TOKENS.get("default", 8192))

# v5: Models that MUST use the Responses API (set by config or default).
# These are reasoning-only models on Databricks where /v1/chat/completions
# refuses function tools. We auto-detect by name prefix unless overridden.
_responses_cfg     = _json_env("AURA_RESPONSES_API", CONFIG.get("responses_api", {}) or {})
RESPONSES_MODELS   = set(_responses_cfg.get("models", []) or [])
# Sensible default if config doesn't list any:
if not RESPONSES_MODELS:
    RESPONSES_MODELS = {
        "databricks-gpt-5-5",
        "databricks-gpt-5-4",
    }
RESPONSES_DEFAULT_EFFORT = _responses_cfg.get("default_effort", "medium")

# Models where Playground Chat Completions can execute server-side web search
# via `features.web_search`. GPT-5.5/5.4 use native Responses API web_search
# on the separate /openai/responses path.
SERVER_WEB_SEARCH_MODELS = {
}
SERVER_WEB_SEARCH_TOOL_TYPES = {
    "web_search",
    "web_search_preview",
    "web_search_20250305",
}
SERVER_WEB_SEARCH_TOOL_NAMES = {
    "web_search",
    "web_search_preview",
    "web_search_20250305",
}
SERVER_WEB_SEARCH_SYSTEM_MARKERS = (
    "SERVER_WEB_SEARCH=1",
)

# v3: thinking-mode config (all optional with sane defaults so old configs still work)
_thinking_cfg = CONFIG.get("thinking", {}) or {}
THINKING_DEFAULT_EFFORT  = _thinking_cfg.get("default_effort", "medium")
THINKING_DEFAULT_ENABLED = bool(_thinking_cfg.get("default_enabled", False))

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_log_cfg = CONFIG.get("logging", {})
_log_level_str = _log_cfg.get("level", "INFO").upper()
_log_level = getattr(logging, _log_level_str, logging.INFO)

logging.basicConfig(
    level=_log_level,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# Per-category log flags (read from config, default True for all except show_tools)
LOG_REQUEST   = bool(_log_cfg.get("show_request",   True))
LOG_TOKENS    = bool(_log_cfg.get("show_tokens",    True))
LOG_TIMING    = bool(_log_cfg.get("show_timing",    True))
LOG_QUEUE     = bool(_log_cfg.get("show_queue",     True))
LOG_TOOLS     = bool(_log_cfg.get("show_tools",     False))
LOG_RETRY     = bool(_log_cfg.get("show_retry",     True))
LOG_THINKING  = bool(_log_cfg.get("show_thinking",  True))


# ---------------------------------------------------------------------------
# Thinking router (v3) — Strategy-Pattern dispatcher per Claude model family.
# ---------------------------------------------------------------------------

thinking_router = ThinkingRouter(
    default_effort=THINKING_DEFAULT_EFFORT,
    default_enabled=THINKING_DEFAULT_ENABLED,
)


# ---------------------------------------------------------------------------
# Token usage tracker — rolling window for TPM estimation
# ---------------------------------------------------------------------------

class TokenTracker:
    """
    Tracks token usage in a rolling 60s window to estimate TPM.
    Also keeps cumulative totals for the session.
    """

    def __init__(self):
        self._lock = threading.Lock()
        # (timestamp, input_tokens, output_tokens)
        self._window: collections.deque = collections.deque()
        self.total_input  = 0
        self.total_output = 0
        self.total_requests = 0

    def record(self, input_tokens: int, output_tokens: int):
        now = time.time()
        with self._lock:
            self._window.append((now, input_tokens, output_tokens))
            self.total_input  += input_tokens
            self.total_output += output_tokens
            self.total_requests += 1
            # Evict entries older than 60s
            while self._window and now - self._window[0][0] > 60:
                self._window.popleft()

    def tpm_snapshot(self) -> dict:
        now = time.time()
        with self._lock:
            while self._window and now - self._window[0][0] > 60:
                self._window.popleft()
            window_input  = sum(t[1] for t in self._window)
            window_output = sum(t[2] for t in self._window)
            window_secs   = (now - self._window[0][0]) if len(self._window) > 1 else 0
        return {
            "window_input_tokens":  window_input,
            "window_output_tokens": window_output,
            "window_total_tokens":  window_input + window_output,
            "window_seconds":       round(window_secs, 1),
            "estimated_tpm":        round((window_input + window_output) / 60),
            "session_input_tokens":  self.total_input,
            "session_output_tokens": self.total_output,
            "session_total_tokens":  self.total_input + self.total_output,
            "session_requests":      self.total_requests,
        }


token_tracker = TokenTracker()


# ---------------------------------------------------------------------------
# Model resolution
# ---------------------------------------------------------------------------

def resolve_model(requested: str | None) -> str:
    """
    Map an Anthropic-style model name to the connected provider's model ID.

    Resolution order:
        1. Exact match in MODEL_MAP
        2. Strip date suffix (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5) then exact match
        3. Case-insensitive exact match (so "GPT-5.5", "Sonnet-4-6" work)
        4. Fuzzy: any MODEL_MAP key that is a substring of the requested name
        5. Pass through as-is (backend may handle it)
    """
    if not requested:
        return DEFAULT_MODEL

    if requested in MODEL_MAP:
        return MODEL_MAP[requested]

    cleaned = re.sub(r"-\d{8}$", "", requested)
    if cleaned in MODEL_MAP:
        return MODEL_MAP[cleaned]

    # v5: case-insensitive exact match — accept GPT-5.5, Sonnet-4-6, etc.
    lc = requested.lower()
    if lc in MODEL_MAP:
        return MODEL_MAP[lc]
    cleaned_lc = cleaned.lower()
    if cleaned_lc in MODEL_MAP:
        return MODEL_MAP[cleaned_lc]

    for key, val in MODEL_MAP.items():
        if key in cleaned or key in requested:
            return val
        # case-insensitive substring fallback
        if key.lower() in cleaned_lc or key.lower() in lc:
            return val

    logger.warning(f"[MODEL] Unknown model '{requested}' — passing through as-is")
    return requested


def _route_priority(provider: str, default: list[str]) -> list[str]:
    configured = (_ROUTING.get(provider) or {}).get("priority")
    if not configured:
        return default
    if isinstance(configured, str):
        configured = [configured]
    routes = [route for route in configured if route in _ENDPOINTS]
    return routes or default


def _first_chat_route(priority: list[str], default_url: str) -> str:
    for route in priority:
        if route == "openai_chat":
            return OPENAI_CHAT_URL
        if route == "api_chat":
            return TARGET_URL
    return default_url


def _allows_native_fallback(priority: list[str]) -> bool:
    return "native_messages" in priority


def needs_responses_api(model: str) -> bool:
    """v5: True if this model must be routed through /openai/responses.

    Currently: GPT-5.5 and GPT-5.4 (reasoning-only models on Databricks).

    Important: must NOT match `databricks-gpt-5-4-mini` (non-reasoning, works
    on Chat Completions). We use a boundary-aware match: the configured model
    must equal the input exactly, or be followed only by a date suffix
    (e.g. `databricks-gpt-5-5-2026-04-23` → matches `databricks-gpt-5-5`).
    """
    if not RESPONSES_API_ENABLED:
        return False
    if model in RESPONSES_MODELS:
        return True
    # Boundary-aware fuzzy: only allow date suffix after a configured id.
    # Strip trailing -YYYYMMDD or -YYYY-MM-DD then re-check exact match.
    cleaned = re.sub(r"-\d{4}(-\d{2}-\d{2})?(-\d{2}-\d{2})?$", "", model)
    cleaned = re.sub(r"-\d{8}$", "", cleaned)
    return cleaned in RESPONSES_MODELS


# Map slash /effort levels → Responses API effort values.
# Anthropic style:  off | low | medium | high | max
# Responses style:  none | low | medium | high | xhigh
# Native CLI may already send a Responses-style value (xhigh) — pass it through.
_EFFORT_TO_RESPONSES = {
    None:     None,
    "off":    None,
    "none":   None,
    "low":    "low",
    "medium": "medium",
    "high":   "high",
    "max":    "xhigh",
    "xhigh":  "xhigh",  # already Responses-style — pass through
}


# ---------------------------------------------------------------------------
# Format converters  (Anthropic ↔ OpenAI)
# ---------------------------------------------------------------------------

def tool_requests_server_web_search(tool: dict) -> bool:
    """True when a Claude Code tool entry means "let backend search the web".

    Claude Code/MCP tools normally arrive as Anthropic function definitions
    and should be forwarded as normal functions. Native search pseudo-tools
    (OpenAI/Anthropic naming variants) should instead enable Playground's
    server-side search when the model supports it.
    """
    if not isinstance(tool, dict):
        return False
    tool_type = tool.get("type")
    tool_name = tool.get("name")
    return (
        tool_type in SERVER_WEB_SEARCH_TOOL_TYPES
        or tool_name in SERVER_WEB_SEARCH_TOOL_NAMES
    )


def tools_request_server_web_search(tools: list | None) -> bool:
    return any(tool_requests_server_web_search(tool) for tool in (tools or []))


def _server_web_search_system_text(system) -> str:
    if not system:
        return ""
    if isinstance(system, list):
        return "\n".join(
            block.get("text", "") for block in system
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return str(system)


def system_requests_server_web_search(system) -> bool:
    text = _server_web_search_system_text(system)
    return any(marker in text for marker in SERVER_WEB_SEARCH_SYSTEM_MARKERS)


def strip_server_web_search_markers_from_text(text: str) -> str:
    for marker in SERVER_WEB_SEARCH_SYSTEM_MARKERS:
        text = text.replace(marker, "")
    return text


def strip_server_web_search_markers_from_system(system):
    if isinstance(system, list):
        cleaned = []
        for block in system:
            if isinstance(block, dict) and block.get("type") == "text":
                block = dict(block)
                block["text"] = strip_server_web_search_markers_from_text(block.get("text", ""))
            cleaned.append(block)
        return cleaned
    if isinstance(system, str):
        return strip_server_web_search_markers_from_text(system)
    return system


def request_enables_server_web_search(body: dict) -> bool:
    return (
        tools_request_server_web_search(body.get("tools"))
        or system_requests_server_web_search(body.get("system"))
    )


_OPENAI_TOOLS_MAX = 128


def anthropic_tools_to_openai(
    tools: list | None,
    *,
    skip_server_web_search: bool = False,
) -> list | None:
    if not tools:
        return None
    result = []
    for tool in tools:
        if skip_server_web_search and tool_requests_server_web_search(tool):
            continue
        schema = (
            tool.get("input_schema")
            or tool.get("parameters")
            or {"type": "object", "properties": {}}
        )
        result.append({
            "type": "function",
            "function": {
                "name": tool.get("name", "unknown"),
                "description": tool.get("description", ""),
                "parameters": schema,
            },
        })
    if len(result) > _OPENAI_TOOLS_MAX:
        logger.warning(
            f"[TOOLS] truncating {len(result)} → {_OPENAI_TOOLS_MAX} (OpenAI chat-completions limit)"
        )
        result = result[:_OPENAI_TOOLS_MAX]
    return result if result else None


def _anthropic_image_to_openai_url(source: dict) -> str | None:
    """Convert Anthropic image source → OpenAI data-URI string.

    Anthropic:  {"type": "base64", "media_type": "image/png", "data": "<b64>"}
                {"type": "url",    "url": "https://..."}
    OpenAI:     "data:image/png;base64,<b64>"   /  "https://..."
    """
    src_type = source.get("type")
    if src_type == "base64":
        media = source.get("media_type", "image/png")
        data  = source.get("data", "")
        return f"data:{media};base64,{data}"
    elif src_type == "url":
        return source.get("url")
    return None


def anthropic_messages_to_openai(messages: list) -> list:
    result = []
    for msg in messages:
        role    = msg.get("role")
        content = msg.get("content")

        if not isinstance(content, list):
            result.append({"role": role, "content": content})
            continue

        # For user/assistant messages we build a mixed-content list so images
        # are preserved. tool_use / tool_result are handled separately.
        content_parts: list[dict] = []
        tool_calls:    list[dict] = []

        for block in content:
            btype = block.get("type")

            if btype == "text":
                content_parts.append({"type": "text", "text": block.get("text", "")})

            elif btype == "image":
                # v4: convert Anthropic image → OpenAI image_url format.
                # The upstream (OpenAI-compat) backend requires this in user messages.
                source  = block.get("source", {})
                img_url = _anthropic_image_to_openai_url(source)
                if img_url:
                    content_parts.append({
                        "type": "image_url",
                        "image_url": {"url": img_url},
                    })
                # silently drop if source is unrecognised (best-effort)

            elif btype == "tool_use":
                tool_calls.append({
                    "id": block["id"],
                    "type": "function",
                    "function": {
                        "name": block["name"],
                        "arguments": json.dumps(block["input"]),
                    },
                })

            elif btype == "tool_result":
                # v4: some upstream backends (observed on Bedrock-backed hosts)
                # accept tool_result content as a *list* of Anthropic-style blocks including image
                # blocks with {"type":"image","source":{...}} — tested & confirmed.
                # Previously we serialised non-text blocks to a JSON string,
                # which lost image data entirely.  Now we pass a proper list so
                # the model can actually see screenshots / image file reads.
                raw = block.get("content", "")
                if isinstance(raw, list):
                    tool_content: list[dict] | str = []
                    has_image = False
                    for sub in raw:
                        if isinstance(sub, dict):
                            sub_type = sub.get("type")
                            if sub_type == "text":
                                tool_content.append({"type": "text", "text": sub.get("text", "")})
                            elif sub_type == "image":
                                # Pass Anthropic image block as-is — the upstream accepts this.
                                tool_content.append(sub)
                                has_image = True
                            else:
                                # Unknown block: serialise to text so nothing is silently lost
                                tool_content.append({"type": "text", "text": json.dumps(sub, ensure_ascii=False)})
                        else:
                            tool_content.append({"type": "text", "text": str(sub)})
                    # If no images present, collapse to plain string for max compat.
                    if not has_image:
                        tool_content = "\n".join(
                            p["text"] for p in tool_content
                            if isinstance(p, dict) and p.get("type") == "text"
                        )
                elif isinstance(raw, str):
                    tool_content = raw
                else:
                    tool_content = json.dumps(raw, ensure_ascii=False)
                result.append({
                    "role": "tool",
                    "tool_call_id": block["tool_use_id"],
                    "content": tool_content,
                })

        # Flush accumulated content_parts + tool_calls for this message.
        if content_parts or tool_calls:
            # Collapse to plain string when there's only text and no images
            # (keeps payloads small for the common case).
            only_text = all(p.get("type") == "text" for p in content_parts)
            if only_text and not tool_calls:
                flat = " ".join(p["text"] for p in content_parts)
                result.append({"role": role, "content": flat})
            else:
                m: dict = {"role": role, "content": content_parts if content_parts else ""}
                if tool_calls:
                    m["tool_calls"] = tool_calls
                result.append(m)

    return result


def openai_response_to_anthropic(openai_resp: dict, model: str = DEFAULT_MODEL) -> dict:
    choice     = openai_resp.get("choices", [{}])[0]
    message    = choice.get("message", {})
    raw_content = message.get("content", "")
    tool_calls = message.get("tool_calls") or []

    content_blocks: list[dict] = []

    # v3: when thinking is enabled, some upstreams (observed on Bedrock-backed
    # hosts) return `content` as a list of blocks like
    # [{"type":"reasoning","summary":[...]}, {"type":"text",...}]
    # instead of a plain string. Translate reasoning blocks into Anthropic-style
    # `thinking` blocks so Claude Code renders them as a collapsible dropdown.
    if isinstance(raw_content, list):
        for block in raw_content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")

            if btype == "reasoning":
                # Bedrock-style: summary[] each with text + signature.
                # Anthropic-style: a single `thinking` block with thinking text + signature.
                thinking_text = ""
                signature     = ""
                for s in block.get("summary", []) or []:
                    if isinstance(s, dict) and s.get("type") == "summary_text":
                        thinking_text += s.get("text", "") or ""
                        # Last signature wins (there's normally only one).
                        signature = s.get("signature", "") or signature
                content_blocks.append({
                    "type":      "thinking",
                    "thinking":  thinking_text,
                    "signature": signature,
                })

            elif btype == "text":
                content_blocks.append({
                    "type": "text",
                    "text": block.get("text", "") or "",
                })

            # Other block types are ignored (forward compat).
    elif isinstance(raw_content, str) and raw_content:
        content_blocks.append({"type": "text", "text": raw_content})

    for tc in tool_calls:
        fn = tc.get("function", {})
        tool_name = fn.get("name", "unknown")
        try:
            input_data = json.loads(fn.get("arguments", "{}"))
        except (json.JSONDecodeError, TypeError):
            input_data = {}
        content_blocks.append({
            "type":  "tool_use",
            "id":    tc.get("id"),
            "name":  tool_name,
            "input": input_data,
        })
        if LOG_TOOLS:
            logger.info(f"[TOOLS] Convert tool_call to tool_use: {tool_name} (id={tc.get('id')})")

    finish = choice.get("finish_reason")
    usage  = openai_resp.get("usage", {})

    return {
        "id":            openai_resp.get("id", str(uuid.uuid4())),
        "type":          "message",
        "role":          "assistant",
        "model":         openai_resp.get("model", model),
        "content":       content_blocks,
        "stop_reason":   "tool_use" if tool_calls else ("end_turn" if finish == "stop" else finish),
        "stop_sequence": None,
        "usage": {
            "input_tokens":  usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


# ---------------------------------------------------------------------------
# Streaming converter — OpenAI SSE → Anthropic SSE
# ---------------------------------------------------------------------------
#
# OpenAI streams `data: {"choices":[{"delta":{...}}]}` chunks ending with
# `data: [DONE]`. Anthropic uses a richer event protocol:
#
#   message_start            { message: { id, model, ... } }
#   content_block_start      { index, content_block: {type, text/...} }
#   content_block_delta      { index, delta: {type, text/partial_json} }
#   content_block_stop       { index }
#   message_delta            { delta: {stop_reason}, usage }
#   message_stop
#
# Claude Code consumes the Anthropic format only.

def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


async def stream_openai_to_anthropic(openai_stream, model: str, msg_id: str):
    """
    Consume an OpenAI-format streaming response (httpx async iterator over
    SSE lines) and yield Anthropic-format SSE bytes for Claude Code.
    """
    text_block_open = False
    text_index = 0
    # Tool calls are streamed as deltas keyed by index. We must open a
    # content_block per tool call and accumulate partial JSON args.
    tool_blocks: dict[int, dict] = {}  # openai_idx -> {anthropic_idx, name, id, args_buf}
    # v3: thinking ("reasoning") block tracking — emitted before any text/tool
    # chunks. Some upstreams (observed on Bedrock-backed hosts) send a single reasoning block per turn
    # with empty text + a signature blob (raw thinking is hidden upstream).
    thinking_block_open  = False
    thinking_index       = 0
    thinking_text_buf    = ""
    thinking_signature   = ""
    next_anthropic_idx = 0
    finish_reason = None
    usage = {"input_tokens": 0, "output_tokens": 0}

    # message_start
    yield _sse("message_start", {
        "type": "message_start",
        "message": {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        },
    })

    # ping every chunk batch keeps connection alive (Anthropic does this)
    yield _sse("ping", {"type": "ping"})

    async for raw_line in openai_stream.aiter_lines():
        if not raw_line:
            continue
        if not raw_line.startswith("data:"):
            continue
        payload = raw_line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue

        # Usage is sent by some backends in the final chunk
        if chunk.get("usage"):
            u = chunk["usage"]
            usage["input_tokens"] = u.get("prompt_tokens", usage["input_tokens"])
            usage["output_tokens"] = u.get("completion_tokens", usage["output_tokens"])

        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get("delta") or {}

        # v3: --- Thinking (reasoning) streaming ---
        # Upstream stream chunks have `delta.content` as either:
        #   - a string  → normal text token
        #   - a list    → reasoning block at start of turn:
        #                 [{"type":"reasoning","summary":[{"type":"summary_text","text":"","signature":"..."}]}]
        # We translate the list form into Anthropic-style thinking events.
        raw_content = delta.get("content")
        if isinstance(raw_content, list):
            for block in raw_content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "reasoning":
                    continue

                # Open the thinking content_block on first reasoning chunk.
                if not thinking_block_open:
                    thinking_index = next_anthropic_idx
                    next_anthropic_idx += 1
                    thinking_block_open = True
                    yield _sse("content_block_start", {
                        "type": "content_block_start",
                        "index": thinking_index,
                        "content_block": {"type": "thinking", "thinking": ""},
                    })

                for s in block.get("summary", []) or []:
                    if not isinstance(s, dict) or s.get("type") != "summary_text":
                        continue
                    t = s.get("text", "") or ""
                    sig = s.get("signature", "") or ""
                    if t:
                        thinking_text_buf += t
                        yield _sse("content_block_delta", {
                            "type": "content_block_delta",
                            "index": thinking_index,
                            "delta": {"type": "thinking_delta", "thinking": t},
                        })
                    if sig:
                        thinking_signature = sig

            # When stream transitions from list-content to string-content (or
            # tool_calls / finish_reason), the close happens below — keep the
            # block "open" for now in case more reasoning chunks arrive.
            text_piece = None
        else:
            text_piece = raw_content if isinstance(raw_content, str) else None

        # --- Text streaming ---
        if text_piece:
            # The first text chunk implies thinking is done — close it cleanly
            # with the signature delta required by Anthropic's protocol.
            if thinking_block_open:
                if thinking_signature:
                    yield _sse("content_block_delta", {
                        "type": "content_block_delta",
                        "index": thinking_index,
                        "delta": {"type": "signature_delta", "signature": thinking_signature},
                    })
                yield _sse("content_block_stop", {
                    "type": "content_block_stop", "index": thinking_index,
                })
                thinking_block_open = False

            if not text_block_open:
                text_index = next_anthropic_idx
                next_anthropic_idx += 1
                yield _sse("content_block_start", {
                    "type": "content_block_start",
                    "index": text_index,
                    "content_block": {"type": "text", "text": ""},
                })
                text_block_open = True
            yield _sse("content_block_delta", {
                "type": "content_block_delta",
                "index": text_index,
                "delta": {"type": "text_delta", "text": text_piece},
            })

        # --- Tool call streaming ---
        for tc in delta.get("tool_calls") or []:
            oi = tc.get("index", 0)
            fn = tc.get("function") or {}
            if oi not in tool_blocks:
                # v3: Close thinking block (if open) before tool block starts
                if thinking_block_open:
                    if thinking_signature:
                        yield _sse("content_block_delta", {
                            "type": "content_block_delta",
                            "index": thinking_index,
                            "delta": {"type": "signature_delta", "signature": thinking_signature},
                        })
                    yield _sse("content_block_stop", {
                        "type": "content_block_stop", "index": thinking_index,
                    })
                    thinking_block_open = False
                # Close text block if open before starting tool block
                if text_block_open:
                    yield _sse("content_block_stop", {
                        "type": "content_block_stop", "index": text_index,
                    })
                    text_block_open = False

                a_idx = next_anthropic_idx
                next_anthropic_idx += 1
                tool_blocks[oi] = {
                    "anthropic_idx": a_idx,
                    "id": tc.get("id") or f"toolu_{uuid.uuid4().hex[:24]}",
                    "name": fn.get("name") or "",
                    "args_buf": "",
                }
                yield _sse("content_block_start", {
                    "type": "content_block_start",
                    "index": a_idx,
                    "content_block": {
                        "type": "tool_use",
                        "id": tool_blocks[oi]["id"],
                        "name": tool_blocks[oi]["name"],
                        "input": {},
                    },
                })

            tb = tool_blocks[oi]
            # Late name arrival
            if fn.get("name") and not tb["name"]:
                tb["name"] = fn["name"]

            args_piece = fn.get("arguments")
            if args_piece:
                tb["args_buf"] += args_piece
                yield _sse("content_block_delta", {
                    "type": "content_block_delta",
                    "index": tb["anthropic_idx"],
                    "delta": {"type": "input_json_delta", "partial_json": args_piece},
                })

        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]

    # Close any open blocks
    # v3: thinking block — close with signature if we never transitioned to text
    if thinking_block_open:
        if thinking_signature:
            yield _sse("content_block_delta", {
                "type": "content_block_delta",
                "index": thinking_index,
                "delta": {"type": "signature_delta", "signature": thinking_signature},
            })
        yield _sse("content_block_stop", {"type": "content_block_stop", "index": thinking_index})
        thinking_block_open = False
    if text_block_open:
        yield _sse("content_block_stop", {"type": "content_block_stop", "index": text_index})
    for tb in tool_blocks.values():
        yield _sse("content_block_stop", {"type": "content_block_stop", "index": tb["anthropic_idx"]})

    # Map finish reason
    if tool_blocks:
        stop_reason = "tool_use"
    elif finish_reason == "stop":
        stop_reason = "end_turn"
    elif finish_reason == "length":
        stop_reason = "max_tokens"
    elif finish_reason == "content_filter":
        stop_reason = "stop_sequence"
    else:
        stop_reason = finish_reason or "end_turn"

    yield _sse("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": stop_reason, "stop_sequence": None},
        "usage": usage,
    })
    yield _sse("message_stop", {"type": "message_stop"})

    # Record usage for tracker
    token_tracker.record(usage["input_tokens"], usage["output_tokens"])


# ---------------------------------------------------------------------------
# FastAPI app — global httpx client via lifespan
# ---------------------------------------------------------------------------

http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(
        timeout=PROXY_TIMEOUT,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
    )
    logger.info("[SERVER] HTTP client pool initialized")

    # Visualise/obscura sweep loops need the event loop FastAPI provides via
    # lifespan; on_event("startup") is silently dropped when an explicit
    # lifespan is set, so we kick them here.
    vis_sweep_task = None
    try:
        from aether_proxy.visualise_endpoint import _sweep_loop as _vis_sweep
        vis_sweep_task = asyncio.create_task(_vis_sweep())
    except Exception as _e:
        logger.warning("[visualise] sweep loop launch failed: %s", _e)
    obscura_sweep_task = None
    try:
        from aether_proxy.obscura_endpoint import _sweep_loop as _obs_sweep
        obscura_sweep_task = asyncio.create_task(_obs_sweep())
    except Exception as _e:
        logger.warning("[obscura] sweep loop launch failed: %s", _e)

    yield
    if vis_sweep_task:
        vis_sweep_task.cancel()
    if obscura_sweep_task:
        obscura_sweep_task.cancel()
    await http_client.aclose()
    logger.info("[SERVER] HTTP client pool closed")


app = FastAPI(title="Aether Proxy", lifespan=lifespan)

# ---------------------------------------------------------------------------
# Mount ALL MCP servers as streamable-HTTP sub-apps
# ---------------------------------------------------------------------------
try:
    from aether_proxy._mcp_mount import mount_all as _mount_all
    _mount_all(app)
except Exception as _e:
    logger.warning("[MCP] mount_all failed: %s", _e)

# Visualise file endpoint — clients fetch /api/visualise/<file>?token=…
# instead of relying on a shared bind-mount. Cleanup loop bounds disk usage
# by TTL + LRU. (image_endpoint.py is unused — it served files written by the
# now-removed Renesas image-generation MCP; nothing produces those files
# anymore, so it's left in the tree but not registered here.)
try:
    from aether_proxy.visualise_endpoint import (
        register_visualise_endpoint, schedule_visualise_cleanup,
    )
    register_visualise_endpoint(app)
    schedule_visualise_cleanup(app)
except Exception as _e:
    logger.warning("[visualise] endpoint setup failed: %s", _e)

# Obscura (headless browser) file-serving endpoint + cleanup.
try:
    from aether_proxy.obscura_endpoint import (
        register_obscura_endpoint, schedule_obscura_cleanup,
    )
    register_obscura_endpoint(app)
    schedule_obscura_cleanup(app)
except Exception as _e:
    logger.warning("[obscura] endpoint setup failed: %s", _e)

# Limit concurrent requests to Databricks to avoid 429 spikes.
# concurrency=1: fully serialize (safe but slow when multiple terminals open)
# concurrency=2: allow 2 parallel requests (good balance for 2 terminals)
_backend_semaphore = asyncio.Semaphore(PROXY_CONCURRENCY)
# GPT/Responses-API models use a separate semaphore so they are never blocked
# by in-flight Claude requests (or their 429 retry back-off loops).
_responses_semaphore = asyncio.Semaphore(PROXY_CONCURRENCY)


_UPLOAD_DIR = pathlib.Path("/tmp/aura-uploads")

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Receive a file from the client, save to /tmp/aura-uploads/, return container path.
    Usage: curl -F file=@/path/to/file.pdf http://localhost:<PORT>/upload
    """
    dest_dir = _UPLOAD_DIR / uuid.uuid4().hex
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / (pathlib.Path(file.filename).name or "upload")
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    size_kb = dest.stat().st_size // 1024
    logger.info("[upload] saved %s (%d KB) → %s", file.filename, size_kb, dest)
    return {"status": "ok", "container_path": str(dest), "filename": dest.name, "size_kb": size_kb}


@app.get("/")
@app.get("/health")
@app.head("/")
@app.head("/health")
async def health():
    snap = token_tracker.tpm_snapshot()
    return {"status": "ok", "usage": snap}


@app.post("/v1/messages/count_tokens")
async def count_tokens(request: Request):
    """Stub endpoint — Claude Code calls this to estimate context size.
    Returns a dummy count so Claude Code doesn't spam 404s in the log."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    # Rough estimate: sum of message content lengths / 4 (chars-per-token heuristic)
    messages = body.get("messages") or []
    system   = body.get("system") or ""
    text     = system if isinstance(system, str) else ""
    for m in messages:
        c = m.get("content") or ""
        text += c if isinstance(c, str) else ""
    estimate = max(1, len(text) // 4)
    return {"input_tokens": estimate}


# ---------------------------------------------------------------------------
# Runtime provider switch (POST /admin/provider)
# ---------------------------------------------------------------------------
# Single-user, in-process upstream override. There is no bundled default
# backend — /v1/messages only works once a provider has been connected here,
# keeping every proxy feature (image/visualise/mcp/upload/thinking) in the path.
#   openai    → force api_chat route, POST <base_url>/chat/completions (OpenAI native,
#               e.g. llama.cpp) via the existing Anthropic→OpenAI converter.
#   anthropic → force native pass-through, POST <base_url>/messages (Anthropic shape).
# mode == "default" means "no provider configured" — /v1/messages fails closed
# with a friendly error instead of trying to reach a hardcoded upstream.
_ACTIVE_PROVIDER: dict = {"mode": "default", "base_url": None, "api_key": None,
                          "api_root": None, "models": []}


def _upstream_bearer() -> str:
    """Bearer token for the active custom provider (empty string for keyless
    local servers like llama.cpp)."""
    return _ACTIVE_PROVIDER.get("api_key") or ""


@app.get("/v1/models")
async def list_models():
    """Return all models the proxy supports.

    Claude CLI calls this endpoint before starting a session to validate
    the --model flag. Without it, any model not in Anthropic's cloud list
    (including GPT-5.5/5.4 and all databricks-* names) gets rejected with
    'Model not found' before a single token is sent.
    """
    now = int(time.time())
    model_ids = list(MODEL_MAP.keys()) + [v for v in MODEL_MAP.values()
                                          if v not in MODEL_MAP]
    # Deduplicate while preserving order
    seen: set[str] = set()
    data = []
    for mid in model_ids:
        if mid not in seen:
            seen.add(mid)
            data.append({"id": mid, "object": "model", "created": now,
                         "owned_by": "aether"})
    return {"object": "list", "data": data}


_LC_HOP_HEADERS = {"host", "content-length", "connection", "transfer-encoding"}


@app.api_route("/lc/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def lc_proxy(path: str, request: Request):
    """Reverse-proxy for claude-mem worker traffic when claude_mem.local=1.

    Forwards /lc/<path> -> {LC_URL}/<path>, streaming the response back
    unchanged. Kept separate from /admin/provider's _ACTIVE_PROVIDER switch,
    which changes the upstream for every request — this is a fixed side
    channel so the worker can go local without affecting the interactive
    coding session's own routing.
    """
    body = await request.body()
    # Route by model name (AURA_LLM_BACKENDS): qwen3.8* → qwen3.8 machine,
    # qwen3.6* → qwen3.6 machine, ... No body / unknown model → LC_URL default.
    target = LC_URL
    if body:
        try:
            _m = (json.loads(body) or {}).get("model")
        except Exception:
            _m = None
        if _m:
            target = _lc_backend_url(_m)
            if target != LC_URL:
                logger.info(f"[LC] model={_m} → {target}")
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in _LC_HOP_HEADERS}
    req = http_client.build_request(
        request.method, f"{target}/{path}",
        params=request.query_params, headers=headers, content=body or None,
    )

    upstream = await http_client.send(req, stream=True)

    async def relay(_upstream=upstream):
        cancelled = asyncio.Event()

        async def _watch():
            while not cancelled.is_set():
                if await request.is_disconnected():
                    cancelled.set()
                    try:
                        await _upstream.aclose()
                    except Exception:
                        pass
                    return
                await asyncio.sleep(0.5)

        watcher = asyncio.ensure_future(_watch())
        try:
            async for chunk in _upstream.aiter_raw():
                if cancelled.is_set():
                    break
                if chunk:
                    yield chunk
        finally:
            cancelled.set()
            watcher.cancel()
            await _upstream.aclose()

    resp_headers = {k: v for k, v in upstream.headers.items()
                     if k.lower() not in _LC_HOP_HEADERS}
    from fastapi.responses import StreamingResponse
    return StreamingResponse(relay(), status_code=upstream.status_code,
                              headers=resp_headers)


@app.get("/admin/provider")
async def get_provider():
    """Report the active upstream provider (never exposes the api_key itself)."""
    p = _ACTIVE_PROVIDER
    return {
        "mode":     p.get("mode", "default"),
        "base_url": p.get("base_url"),
        "has_key":  bool(p.get("api_key")),
        "models":   p.get("models", []),
    }


@app.post("/admin/provider")
async def set_provider(request: Request):
    """Switch this proxy's UPSTREAM at runtime (single-user, in-process).

    Body: {"mode": "default"|"openai"|"anthropic", "base_url": str, "api_key": str}
    - openai:    requests go to <api_root>/chat/completions via the existing
                 Anthropic→OpenAI converter (e.g. llama.cpp native).
    - anthropic: requests pass through to <api_root>/messages (native Anthropic SSE).
    - default:   clear the active provider (back to unconfigured — /v1/messages
                 fails closed until a provider is connected again).
    base_url may be given with or without the /v1 suffix — the model probe tries
    both <base>/models and <base>/v1/models and remembers whichever answers as
    <api_root>, so chat/messages hang off the same root. Never logs api_key.
    """
    try:
        payload = await request.json()
    except Exception:
        return Response(json.dumps({"error": "invalid JSON body"}),
                        status_code=400, media_type="application/json")

    mode = str(payload.get("mode") or "default").strip().lower()
    if mode not in ("default", "openai", "anthropic"):
        return Response(json.dumps({"error": "mode must be default|openai|anthropic"}),
                        status_code=400, media_type="application/json")

    if mode == "default":
        _ACTIVE_PROVIDER.update({"mode": "default", "base_url": None,
                                 "api_key": None, "api_root": None, "models": []})
        logger.info("[PROVIDER] cleared active provider — no upstream configured")
        default_ids = [m["id"] for m in (await list_models())["data"]]
        return {"ok": True, "mode": "default", "base_url": None, "models": default_ids}

    base_url = str(payload.get("base_url") or "").strip().rstrip("/")
    if not base_url:
        return Response(json.dumps({"error": "base_url required for openai/anthropic"}),
                        status_code=400, media_type="application/json")
    api_key = str(payload.get("api_key") or "").strip()

    # Probe the provider's model list. Servers mount their API either at <base>
    # or at <base>/v1, so try both and remember which root answered — the
    # chat/messages endpoint hangs off that same root. api_root defaults to the
    # first root that returns HTTP 200 (even if the model list is empty).
    hdrs = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    candidates = [base_url]
    if not base_url.endswith("/v1"):
        candidates.append(base_url + "/v1")
    models: list[str] = []
    api_root = base_url
    first_ok_root: str | None = None
    for root in candidates:
        try:
            r = await http_client.get(f"{root}/models", headers=hdrs, timeout=10.0)
        except Exception as exc:
            logger.warning(f"[PROVIDER] model probe failed for {root}: {exc}")
            continue
        if r.status_code != 200:
            logger.warning(f"[PROVIDER] {root}/models → HTTP {r.status_code}")
            continue
        if first_ok_root is None:
            first_ok_root = root
        try:
            ids = [m.get("id") for m in r.json().get("data", [])
                   if isinstance(m, dict) and m.get("id")]
        except Exception:
            ids = []
        if ids:
            models, api_root = ids, root
            break
    if not models and first_ok_root is not None:
        api_root = first_ok_root

    _ACTIVE_PROVIDER.update({"mode": mode, "base_url": base_url, "api_key": api_key,
                             "api_root": api_root, "models": models})
    # Seed MODEL_MAP so resolve_model() passes these ids through unchanged.
    for mid in models:
        MODEL_MAP.setdefault(mid, mid)
    logger.info(f"[PROVIDER] switched → {mode} @ {api_root} ({len(models)} models)")
    return {"ok": True, "mode": mode, "base_url": base_url,
            "api_root": api_root, "models": models}


# ---------------------------------------------------------------------------
# v6: Anthropic-native handler — pass-through /api/v1/messages
# ---------------------------------------------------------------------------
#
# Strategy C: per-model support cache seeded by name heuristic.
# - Cache empty → guess by name (claude→try, gpt→skip, unknown→try).
# - Real evidence (200 / 4xx schema-error) overrides the guess and persists
#   for the process lifetime. Idempotent across concurrent terminals.
# - Sticky-fallback statuses (400/404/405) → cache False.
# - Transient errors (5xx, network) → fallback once but DO NOT cache.

_native_cache: dict[str, bool] = {}

# Statuses where the model genuinely doesn't support the native endpoint.
# 400 only counts when the body says model-not-found / not-supported.
_NATIVE_STICKY_STATUSES = {404, 405}


class NativeFallback(Exception):
    """Raised when the native /api/v1/messages call should fall back to chat.

    `sticky` flips the cache to False; transient errors leave the cache alone
    so a second request can re-probe.
    """
    def __init__(self, status: int, body: str, *, sticky: bool):
        super().__init__(f"native fallback status={status} sticky={sticky}")
        self.status = status
        self.body = body
        self.sticky = sticky


def _native_guess(model: str) -> bool:
    """Seed the cache when there's no evidence yet."""
    m = model.lower()
    if "claude" in m:
        return True
    if "gpt" in m or "llama" in m:
        return False
    return True  # unknown → try once and learn


def _native_supported(model: str) -> bool:
    cached = _native_cache.get(model)
    if cached is not None:
        return cached
    return _native_guess(model)


def _is_native_unsupported_400(body: str) -> bool:
    """Detect 400s that mean 'this model can't use native', vs. transient
    payload errors. Heuristic on the response body."""
    low = body.lower()
    return any(k in low for k in (
        "model not found",
        "not supported",
        "unsupported",
        "unknown field",
        "unsupported api type",
    ))


async def _handle_anthropic_native(
    *,
    request: Request,
    rid: str,
    anthropic_body: dict,
    resolved_model: str,
    error_response,
    upstream_url: str | None = None,
):
    """Pass-through handler for /api/v1/messages.

    Raises NativeFallback when the caller should retry on /chat/completions.
    Returns a Response (or StreamingResponse) on success / non-fallback errors.
    upstream_url overrides the target (runtime provider switch); defaults to ANTHROPIC_URL.
    """
    native_target = upstream_url or ANTHROPIC_URL
    headers = {
        "Content-Type":      "application/json",
        "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
        "x-request-id":      rid,
    }
    # Bearer if the connected provider has an api_key. Keyless upstreams
    # (local llama.cpp / gemma) get no auth header — an empty "Bearer " is illegal.
    _bearer = _upstream_bearer()
    if _bearer:
        headers["Authorization"] = f"Bearer {_bearer}"

    # Build the upstream body: forward the client's Anthropic shape verbatim,
    # but pin the resolved model id and strip any web_search markers we may
    # have leaked into system text.
    body_to_send = dict(anthropic_body)
    body_to_send["model"] = resolved_model
    if "system" in body_to_send:
        body_to_send["system"] = strip_server_web_search_markers_from_system(
            body_to_send["system"]
        )

    native_thinking = body_to_send.get("thinking")
    if "claude" in resolved_model.lower() and isinstance(native_thinking, dict) and native_thinking.get("type"):
        strategy = thinking_router.route(resolved_model)
        if strategy.name == "adaptive":
            output_config = body_to_send.get("output_config") or {}
            effort = output_config.get("effort") if isinstance(output_config, dict) else None
            body_to_send["thinking"] = {"type": "adaptive", "display": "summarized"}
            body_to_send["output_config"] = {"effort": effort or THINKING_DEFAULT_EFFORT}
        elif strategy.name == "none":
            body_to_send.pop("thinking", None)

    wants_stream = bool(body_to_send.get("stream"))
    t_send = time.time()

    if wants_stream:
        req = http_client.build_request(
            "POST", native_target, json=body_to_send, headers=headers,
        )

        # Poll for disconnect while waiting for upstream headers (prefill phase).
        # Uses ensure_future + wait_for loop so ESC during a 200s prefill cancels
        # the request. A dedicated one-shot client avoids corrupting the shared pool.
        _dc_client = httpx.AsyncClient(timeout=None)
        _send_fut = asyncio.ensure_future(
            _dc_client.send(_dc_client.build_request(
                "POST", native_target, json=body_to_send, headers=headers,
            ), stream=True)
        )
        try:
            while True:
                done, _ = await asyncio.wait({_send_fut}, timeout=0.5)
                if done:
                    upstream = _send_fut.result()
                    break
                if await request.is_disconnected():
                    logger.info(f"[CANCEL {rid}] client disconnected during prefill — aborting")
                    _send_fut.cancel()
                    await _dc_client.aclose()
                    return StreamingResponse(iter([]), media_type="text/event-stream",
                                            headers={"x-request-id": rid})
        except Exception:
            await _dc_client.aclose()
            raise

        if upstream.status_code != 200:
            err = (await upstream.aread()).decode("utf-8", errors="replace")
            await upstream.aclose()
            await _dc_client.aclose()
            sticky = (
                upstream.status_code in _NATIVE_STICKY_STATUSES
                or (upstream.status_code == 400 and _is_native_unsupported_400(err))
            )
            transient = upstream.status_code >= 500
            if sticky or transient:
                raise NativeFallback(upstream.status_code, err[:500], sticky=sticky)
            logger.error(f"[ERROR {rid}] native stream {upstream.status_code}: {err[:500]}")
            return error_response(upstream.status_code, "api_error", err[:500])

        # Success — learn and pass-through
        _native_cache[resolved_model] = True
        backend_first_byte_ms = round((time.time() - t_send) * 1000)
        if LOG_TIMING:
            logger.info(
                f"[TIMING {rid}] native_first_byte={backend_first_byte_ms}ms"
            )

        async def relay(_upstream=upstream, _rid=rid, _cli=_dc_client):
            cancelled = asyncio.Event()

            async def _watch():
                while not cancelled.is_set():
                    if await request.is_disconnected():
                        logger.info(f"[CANCEL {_rid}] client disconnected — aborting upstream")
                        cancelled.set()
                        try:
                            await _upstream.aclose()
                        except Exception:
                            pass
                        return
                    await asyncio.sleep(0.5)

            watcher = asyncio.ensure_future(_watch())
            try:
                async for chunk in _upstream.aiter_raw():
                    if cancelled.is_set():
                        break
                    if not chunk:
                        continue
                    yield chunk
            finally:
                cancelled.set()
                watcher.cancel()
                await _upstream.aclose()
                await _cli.aclose()

        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            relay(),
            media_type="text/event-stream",
            headers={
                "x-request-id":     rid,
                "Cache-Control":    "no-cache, no-transform",
                "Connection":       "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-stream
    resp = await http_client.post(native_target, json=body_to_send, headers=headers)
    t_resp = time.time()

    if resp.status_code != 200:
        sticky = (
            resp.status_code in _NATIVE_STICKY_STATUSES
            or (resp.status_code == 400 and _is_native_unsupported_400(resp.text))
        )
        transient = resp.status_code >= 500
        if sticky or transient:
            raise NativeFallback(resp.status_code, resp.text[:500], sticky=sticky)
        return error_response(resp.status_code, "api_error", resp.text[:500])

    _native_cache[resolved_model] = True

    # Record token usage from the native usage shape.
    try:
        usage = resp.json().get("usage", {}) or {}
        in_tok  = usage.get("input_tokens", 0)
        out_tok = usage.get("output_tokens", 0)
        token_tracker.record(in_tok, out_tok)
        if LOG_TOKENS:
            snap = token_tracker.tpm_snapshot()
            logger.info(
                f"[TOKENS {rid}] in={in_tok} out={out_tok} total={in_tok+out_tok} | "
                f"est_tpm={snap['estimated_tpm']} "
                f"session={snap['session_total_tokens']} ({snap['session_requests']} reqs) [native]"
            )
    except Exception:
        pass
    if LOG_TIMING:
        backend_ms = round((t_resp - t_send) * 1000)
        logger.info(f"[TIMING {rid}] native_backend={backend_ms}ms")

    return Response(
        content=resp.text,
        status_code=200,
        media_type=resp.headers.get("content-type", "application/json"),
        headers={"x-request-id": rid},
    )


# ---------------------------------------------------------------------------
# v5: Responses API handler (Path B) — GPT-5.5 / GPT-5.4
# ---------------------------------------------------------------------------

async def _handle_responses_api(
    *,
    request: Request,
    rid: str,
    anthropic_body: dict,
    resolved_model: str,
    requested_model: str | None = None,
    slash_effort: str | None,
    error_response,
):
    """Handle a /v1/messages request that must be routed through /openai/responses.

    Mirrors the structure of the main Chat-Completions branch:
      - resolves effort from slash command / native thinking field / config
      - applies concurrency semaphore + 429 backoff
      - supports streaming and non-streaming
      - converts both directions through responses_adapter.*
    """
    # Determine effort. Priority: slash > native CLI thinking > config default.
    # NOTE: native_cli thinking (output_config.effort) is a Claude-Code artefact —
    # it reflects the user's global effortLevel setting (e.g. "medium") and is
    # emitted for every request regardless of model.  For GPT/Responses-API models
    # we must NOT blindly inherit it: effort=medium triggers extended reasoning which
    # adds a silent multi-second gap before the first SSE byte, causing Claude Code
    # to time-out / disconnect before any text arrives.  Only honour it when the
    # user explicitly overrides effort via a /effort slash command.
    effort_src = "config"
    effort_anthropic = None  # off | low | medium | high | max
    if slash_effort is not None:
        effort_anthropic = slash_effort
        effort_src = "slash"
    elif THINKING_DEFAULT_ENABLED:
        effort_anthropic = THINKING_DEFAULT_EFFORT
    else:
        effort_anthropic = RESPONSES_DEFAULT_EFFORT

    effort_responses = _EFFORT_TO_RESPONSES.get(effort_anthropic, "medium")

    # Enable GPT native Responses API web_search when the request contains a
    # native web_search pseudo-tool or the mode prompt's SERVER_WEB_SEARCH=1 marker asks for it.
    if request_enables_server_web_search(anthropic_body):
        if not tools_request_server_web_search(anthropic_body.get("tools")):
            anthropic_body = dict(anthropic_body)
            anthropic_body["tools"] = list(anthropic_body.get("tools") or []) + [{"type": "web_search"}]

    clean_system = strip_server_web_search_markers_from_system(anthropic_body.get("system"))
    if clean_system != anthropic_body.get("system"):
        anthropic_body = dict(anthropic_body)
        anthropic_body["system"] = clean_system

    # Build the Responses API body
    responses_body = anthropic_to_responses_request(
        anthropic_body,
        resolved_model=resolved_model,
        reasoning_effort=effort_responses,
        reasoning_summary="auto" if effort_responses else None,
    )

    wants_stream = bool(anthropic_body.get("stream"))
    n_messages   = len(anthropic_body.get("messages") or [])
    n_tools      = len(anthropic_body.get("tools") or [])

    if LOG_THINKING and effort_responses:
        logger.info(
            f"[THINKING {rid}] model={resolved_model} effort={effort_anthropic}→{effort_responses} "
            f"strategy=responses_api source={effort_src}"
        )

    t_recv = time.time()
    if LOG_REQUEST:
        logger.info(
            f"[REQUEST {rid}] model={resolved_model} messages={n_messages} "
            f"max_output_tokens={responses_body.get('max_output_tokens')} tools={n_tools} "
            f"stream={wants_stream} api=responses"
        )

    if LOG_QUEUE and _responses_semaphore._value == 0:
        logger.info(f"[QUEUE {rid}] Waiting for slot (model={resolved_model})")

    async with _responses_semaphore:
        t_queued = time.time()
        queue_wait = t_queued - t_recv
        if LOG_QUEUE and queue_wait > 0.1:
            logger.info(f"[QUEUE] Waited {queue_wait:.1f}s in queue")

        deadline = t_queued + RETRY_MAX_WAIT
        attempt  = 0

        while True:
            if await request.is_disconnected():
                logger.info(f"[CANCEL {rid}] Client disconnected before dispatch — aborting")
                return error_response(499, "client_disconnected", "Client closed request")

            headers = {
                "Content-Type":  "application/json",
                "x-request-id":  rid,
            }
            _bearer = _upstream_bearer()
            if _bearer:
                headers["Authorization"] = f"Bearer {_bearer}"

            try:
                t_send = time.time()

                # ---- STREAMING PATH (fake-stream via non-streaming backend call) ----
                # The Responses-API streaming endpoint is unreliable in proxy context:
                # httpx delivers the entire chunked body as one aiter_bytes() chunk
                # inside a FastAPI StreamingResponse generator, regardless of client
                # type.  Workaround: fetch non-streaming, convert to Anthropic format,
                # then emit the SSE chunks synchronously — Claude Code gets a proper
                # streaming response with identical semantics.
                if wants_stream:
                    non_stream_body = dict(responses_body)
                    non_stream_body.pop("stream", None)
                    resp = await http_client.post(
                        RESPONSES_URL, json=non_stream_body, headers=headers,
                    )
                    t_resp = time.time()

                    if resp.status_code != 200 and resp.status_code != 429:
                        return error_response(resp.status_code, "api_error", resp.text[:500])

                    if resp.status_code == 200:
                        data = resp.json()
                        usage = data.get("usage") or {}
                        in_tok  = usage.get("input_tokens", 0)
                        out_tok = usage.get("output_tokens", 0)
                        token_tracker.record(in_tok, out_tok)
                        snap = token_tracker.tpm_snapshot()
                        backend_ms = round((t_resp - t_send) * 1000)
                        total_ms   = round((t_resp - t_recv) * 1000)
                        if LOG_TOKENS:
                            logger.info(
                                f"[TOKENS {rid}] in={in_tok} out={out_tok} total={in_tok+out_tok} | "
                                f"est_tpm={snap['estimated_tpm']} "
                                f"session={snap['session_total_tokens']} ({snap['session_requests']} reqs)"
                            )
                        if LOG_TIMING:
                            logger.info(
                                f"[TIMING {rid}] backend={backend_ms}ms total={total_ms}ms "
                                f"queue_wait={queue_wait:.1f}s api=responses"
                            )
                        msg_id  = f"msg_{uuid.uuid4().hex[:24]}"
                        _model  = requested_model or resolved_model
                        anthropic_resp = responses_to_anthropic_response(data, resolved_model=_model)

                        def fake_stream(_r=anthropic_resp, _mid=msg_id, _m=_model, _it=in_tok, _ot=out_tok):
                            yield _sse("message_start", {"type": "message_start", "message": {
                                "id": _mid, "type": "message", "role": "assistant", "model": _m,
                                "content": [], "stop_reason": None, "stop_sequence": None,
                                "usage": {"input_tokens": _it, "output_tokens": 0},
                            }})
                            for i, block in enumerate(_r.get("content") or []):
                                # For tool_use, content_block_start must have empty input — Claude Code accumulates via input_json_delta
                                start_block = {**block, "input": {}} if block.get("type") == "tool_use" else block
                                yield _sse("content_block_start", {"type": "content_block_start", "index": i, "content_block": start_block})
                                if block.get("type") == "text":
                                    yield _sse("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": block.get("text", "")}})
                                elif block.get("type") == "thinking":
                                    yield _sse("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "thinking_delta", "thinking": block.get("thinking", "")}})
                                elif block.get("type") == "tool_use":
                                    yield _sse("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(block.get("input", {}))}})
                                yield _sse("content_block_stop", {"type": "content_block_stop", "index": i})
                            yield _sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": _r.get("stop_reason", "end_turn"), "stop_sequence": None}, "usage": {"input_tokens": _it, "output_tokens": _ot}})
                            yield _sse("message_stop", {"type": "message_stop"})

                        from fastapi.responses import StreamingResponse
                        return StreamingResponse(
                            fake_stream(),
                            media_type="text/event-stream",
                            headers={"x-request-id": rid, "Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                        )
                else:
                    # ---- NON-STREAMING PATH ----
                    resp = await http_client.post(
                        RESPONSES_URL, json=responses_body, headers=headers,
                    )
                    t_resp = time.time()

                    if resp.status_code == 200:
                        data = resp.json()
                        usage = data.get("usage") or {}
                        in_tok  = usage.get("input_tokens", 0)
                        out_tok = usage.get("output_tokens", 0)
                        token_tracker.record(in_tok, out_tok)
                        snap = token_tracker.tpm_snapshot()
                        backend_ms = round((t_resp - t_send) * 1000)
                        total_ms   = round((t_resp - t_recv) * 1000)
                        if LOG_TOKENS:
                            logger.info(
                                f"[TOKENS {rid}] in={in_tok} out={out_tok} total={in_tok+out_tok} | "
                                f"est_tpm={snap['estimated_tpm']} "
                                f"session={snap['session_total_tokens']} ({snap['session_requests']} reqs)"
                            )
                        if LOG_TIMING:
                            logger.info(
                                f"[TIMING {rid}] backend={backend_ms}ms total={total_ms}ms "
                                f"queue_wait={queue_wait:.1f}s api=responses"
                            )

                        anthropic_resp = responses_to_anthropic_response(
                            data, resolved_model=requested_model or resolved_model,
                        )
                        return Response(
                            content=json.dumps(anthropic_resp, ensure_ascii=False),
                            media_type="application/json",
                            headers={"x-request-id": rid},
                        )

                # ---- 429 retry (shared with chat/completions logic) ----
                if resp.status_code == 429:
                    attempt += 1
                    if LOG_RETRY and attempt == 1:
                        logger.warning(f"[429] Responses-API rate-limited on {resolved_model}")

                    retry_after = resp.headers.get("Retry-After") or resp.headers.get("x-ratelimit-reset-after")
                    if retry_after:
                        try:
                            wait = float(retry_after)
                            if LOG_RETRY:
                                logger.warning(f"[429] Retry-After={wait:.1f}s (attempt {attempt})")
                        except ValueError:
                            retry_after = None

                    if not retry_after:
                        backoff = min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), RETRY_MAX_DELAY)
                        wait = backoff * random.uniform(0.7, 1.3)
                        if LOG_RETRY:
                            logger.warning(f"[429] Backoff {wait:.1f}s (attempt {attempt})")

                    if time.time() + wait > deadline:
                        logger.error(
                            f"[429] Giving up — {RETRY_MAX_WAIT}s budget exhausted after {attempt} attempts"
                        )
                        return error_response(
                            429,
                            "rate_limit_error",
                            f"Rate limit exceeded for '{resolved_model}' — "
                            f"quota did not recover within {RETRY_MAX_WAIT}s.",
                        )

                    await asyncio.sleep(wait)
                    continue

                # ---- Other backend errors ----
                logger.error(f"[ERROR {rid}] Responses-API backend returned {resp.status_code}")
                logger.error(f"[ERROR {rid}] Body: {resp.text[:2000]}")
                try:
                    err = resp.json()
                    msg = (
                        err.get("message")
                        or err.get("error", {}).get("message")
                        or resp.text[:500]
                    )
                except Exception:
                    msg = resp.text[:500]
                return error_response(resp.status_code, "api_error", msg)

            except Exception as exc:
                attempt += 1
                if time.time() + RETRY_BASE_DELAY < deadline:
                    logger.warning(f"[EXCEPTION {rid}] {exc} — retrying in {RETRY_BASE_DELAY}s ...")
                    await asyncio.sleep(RETRY_BASE_DELAY)
                else:
                    logger.error(f"[EXCEPTION {rid}] {exc}")
                    return error_response(500, "api_error", str(exc))


# --- strip locally-generated (unsigned) thinking blocks --------------------
# The local llama bridge stamps its dumped reasoning as a "thinking" block with
# signature "local-unsigned". If such a session is resumed against this real
# Claude backend, the foreign/unverifiable signature would 400. Drop only those
# sentinel-signed blocks; a genuine Claude thinking block (real signature) is
# left untouched.
_LOCAL_THINK_SIG = os.environ.get("LOCAL_THINK_SIG", "local-unsigned")
def _strip_local_thinking(body: dict) -> None:
    msgs = body.get("messages")
    if not isinstance(msgs, list):
        return
    for m in msgs:
        c = m.get("content")
        if isinstance(c, list):
            m["content"] = [b for b in c if not (
                isinstance(b, dict) and b.get("type") == "thinking"
                and b.get("signature") == _LOCAL_THINK_SIG)]


@app.post("/v1/messages")
async def proxy_messages(request: Request):
    # Per-request trace ID for log correlation
    rid = request.headers.get("x-request-id") or f"req_{uuid.uuid4().hex[:12]}"

    def error_response(status: int, error_type: str, message: str) -> Response:
        body = json.dumps({"type": "error", "error": {"type": error_type, "message": message}})
        return Response(
            content=body, status_code=status, media_type="application/json",
            headers={"x-request-id": rid},
        )

    try:
        body = await request.json()
    except Exception:
        return error_response(400, "invalid_request_error", "Invalid JSON body")

    _strip_local_thinking(body)
    requested_model = body.get("model")
    resolved_model  = resolve_model(requested_model)

    # DEBUG: Log tools from Claude Code
    raw_tools = body.get("tools")
    if raw_tools and LOG_TOOLS:
        logger.info(f"[DEBUG] Claude Code sent {len(raw_tools)} tools:")
        for tool in raw_tools:
            logger.info(f"  - {json.dumps(tool, indent=4)}")

    # v3: parse "/effort <level>" slash command from the LAST user message
    # BEFORE converting to OpenAI format. The slash is stripped so Claude
    # never sees it in its context.
    raw_messages = body.get("messages", [])
    slash_effort, raw_messages = parse_effort_command(raw_messages)

    is_claude = "claude" in resolved_model.lower()
    _prov_mode = _ACTIVE_PROVIDER.get("mode", "default")
    # No bundled default backend — "default" mode means nothing has been
    # connected via POST /admin/provider yet. Fail closed instead of trying
    # any hardcoded upstream.
    if _prov_mode == "default":
        return error_response(
            400, "no_provider_configured",
            "No model provider configured yet. Open Settings and connect one.",
        )
    # Custom providers never use the Responses API — that path only applied
    # to the (now-removed) default backend's reasoning-only models, so this
    # is always False given the check above; kept for shape-compatibility.
    is_gpt_reasoning = needs_responses_api(resolved_model) and _prov_mode == "default"
    if is_gpt_reasoning:
        route_priority = _route_priority("gpt_reasoning", ["responses_api"])
    else:
        provider = "claude" if is_claude else "gpt"
        route_priority = _route_priority(
            provider,
            ["openai_chat", "native_messages"] if is_claude else ["api_chat"],
        )

    # ---------------------------------------------------------------------
    # v5: ROUTER — GPT-5.5/5.4 always use the OpenAI Responses API (Path B).
    # ---------------------------------------------------------------------
    if is_gpt_reasoning:
        # Replace messages on the body with the slash-stripped version, then
        # delegate to the dedicated handler. The handler builds its own
        # request body, calls /openai/responses, and converts the result
        # back into Anthropic format (or SSE stream) for Claude Code.
        body["messages"] = raw_messages
        return await _handle_responses_api(
            request=request,
            rid=rid,
            anthropic_body=body,
            resolved_model=resolved_model,
            requested_model=requested_model,
            slash_effort=slash_effort,
            error_response=error_response,
        )

    native_first = bool(route_priority and route_priority[0] == "native_messages")
    native_fallback_enabled = _allows_native_fallback(route_priority)
    chat_target_url = _first_chat_route(
        route_priority,
        OPENAI_CHAT_URL if is_claude else TARGET_URL,
    )

    # Runtime provider override (POST /admin/provider). Default path untouched.
    # api_root is the base that answered the model probe (with or without /v1),
    # so chat/messages hit the correct path regardless of how the user typed it.
    _native_url_override = None
    _api_root = _ACTIVE_PROVIDER.get("api_root") or _ACTIVE_PROVIDER.get("base_url") or ""
    if _prov_mode == "openai":
        native_first = False
        native_fallback_enabled = False
        chat_target_url = _api_root + "/chat/completions"
    elif _prov_mode == "anthropic":
        native_first = True
        native_fallback_enabled = False
        _native_url_override = _api_root + "/messages"

    async def try_native_after_chat_failure(reason: str):
        if not native_fallback_enabled or not _native_supported(resolved_model):
            return None

        native_body = dict(body)
        native_body["messages"] = raw_messages
        try:
            logger.warning(
                f"[NATIVE {rid}] chat/completions failed ({reason}) — "
                f"trying native fallback"
            )
            return await _handle_anthropic_native(
                request=request,
                rid=rid,
                anthropic_body=native_body,
                resolved_model=resolved_model,
                error_response=error_response,
            )
        except NativeFallback as nf:
            if nf.sticky:
                _native_cache[resolved_model] = False
                logger.warning(
                    f"[NATIVE {rid}] {resolved_model} unsupported "
                    f"(status={nf.status}) — caching False"
                )
            else:
                logger.warning(
                    f"[NATIVE {rid}] native fallback transient failure "
                    f"status={nf.status}"
                )
            return None

    # ---------------------------------------------------------------------
    # v6: ANTHROPIC-NATIVE PATH — YAML can put native_messages first for any
    # provider. Otherwise chat routes run first and native_messages is only a
    # fallback when it appears later in routing.<provider>.priority.
    # ---------------------------------------------------------------------
    if native_first and (_prov_mode == "anthropic" or _native_supported(resolved_model)):
        native_body = dict(body)
        native_body["messages"] = raw_messages
        try:
            async with _backend_semaphore:
                return await _handle_anthropic_native(
                    request=request,
                    rid=rid,
                    anthropic_body=native_body,
                    resolved_model=resolved_model,
                    error_response=error_response,
                    upstream_url=_native_url_override,
                )
        except NativeFallback as nf:
            if nf.sticky:
                _native_cache[resolved_model] = False
                logger.warning(
                    f"[NATIVE {rid}] {resolved_model} unsupported "
                    f"(status={nf.status}) — caching False, falling back"
                )
            else:
                logger.warning(
                    f"[NATIVE {rid}] transient failure status={nf.status} — "
                    f"falling back to chat/completions"
                )

    openai_messages = anthropic_messages_to_openai(raw_messages)

    system_prompt = strip_server_web_search_markers_from_system(body.get("system"))
    if system_prompt:
        if isinstance(system_prompt, list):
            system_text = " ".join(
                b.get("text", "") for b in system_prompt if b.get("type") == "text"
            )
        else:
            system_text = str(system_prompt)
        if system_text:
            openai_messages.insert(0, {"role": "system", "content": system_text})

    openai_body: dict = {
        "model":       resolved_model,
        "messages":    openai_messages,
        "max_tokens":  body.get("max_tokens", fallback_max_tokens(resolved_model)),
        "temperature": body.get("temperature", 1.0),
    }

    # Forward stop_sequences (Anthropic) → stop (OpenAI)
    stop_seq = body.get("stop_sequences")
    if stop_seq:
        openai_body["stop"] = stop_seq

    # Forward optional sampling params if present
    if "top_p" in body:
        openai_body["top_p"] = body["top_p"]

    requested_tools = body.get("tools")
    server_web_search = (
        resolved_model in SERVER_WEB_SEARCH_MODELS
        and request_enables_server_web_search(body)
    )
    if server_web_search:
        openai_body.setdefault("features", {})["web_search"] = True
        logger.info(f"[WEB_SEARCH] enabled model={resolved_model} reason={'tool' if tools_request_server_web_search(body.get('tools')) else 'system_marker'}")

    openai_tools = anthropic_tools_to_openai(
        requested_tools,
        skip_server_web_search=server_web_search,
    )
    if openai_tools:
        openai_body["tools"]       = openai_tools
        openai_body["tool_choice"] = "auto"

    # GPT-5.6 via gateway.* id: portal injects reasoning_effort automatically,
    # which conflicts with function tools. Force reasoning_effort=none so tools work.
    if resolved_model.startswith("gateway.ai-prod-aipg-gpt-5-6-"):
        openai_body["reasoning_effort"] = "none"

    # Streaming pass-through: if client requests streaming, propagate it
    wants_stream = bool(body.get("stream"))
    if wants_stream:
        openai_body["stream"] = True
        openai_body["stream_options"] = {"include_usage": True}

    # v3: --- Thinking-mode injection ---
    # Priority order:
    #   1. Native CLI sent `thinking` field → forward + ensure correct schema per model
    #   2. Explicit slash command: /effort {off|low|medium|high|max}
    #   3. config.thinking.default_enabled → use config.thinking.default_effort
    #   4. Otherwise: thinking off
    native_thinking    = body.get("thinking")
    native_outputcfg   = body.get("output_config")

    if isinstance(native_thinking, dict) and native_thinking.get("type"):
        # Claude Code v2.1+ sends thinking natively. Forward it and let the
        # router patch the schema if the resolved model needs the legacy form.
        effort_used = "native"
        # Determine effort: prefer CLI's output_config.effort, then config default
        cli_effort = None
        if isinstance(native_outputcfg, dict):
            cli_effort = native_outputcfg.get("effort")
        cli_effort = cli_effort or THINKING_DEFAULT_EFFORT

        # Route through strategy so legacy models get the right shape
        strategy = thinking_router.route(resolved_model)
        if strategy.name == "adaptive":
            openai_body["thinking"] = {"type": "adaptive", "display": "summarized"}
            openai_body["output_config"] = {"effort": cli_effort}
            effort_used = cli_effort
        elif strategy.name == "legacy":
            openai_body, effort_used = thinking_router.apply(
                openai_body, resolved_model, cli_effort,
            )
        # else NoThinking → drop the field silently (otherwise the upstream 400s)

    elif slash_effort is not None:
        # User typed /effort in the message text
        openai_body, effort_used = thinking_router.apply(
            openai_body, resolved_model, slash_effort,
        )

    else:
        # Honor config.thinking.default_enabled / default_effort
        openai_body, effort_used = thinking_router.apply(
            openai_body, resolved_model, None,
        )

    if LOG_THINKING and effort_used != "off":
        logger.info(
            f"[THINKING {rid}] model={resolved_model} effort={effort_used} "
            f"strategy={thinking_router.route(resolved_model).name} "
            f"source={'native_cli' if isinstance(native_thinking, dict) else ('slash' if slash_effort else 'config')}"
        )

    t_recv = time.time()
    if LOG_REQUEST:
        logger.info(
            f"[REQUEST {rid}] model={resolved_model} messages={len(openai_messages)} "
            f"max_tokens={openai_body['max_tokens']} tools={len(openai_tools) if openai_tools else 0} "
            f"stream={wants_stream}"
        )

    if LOG_QUEUE and _backend_semaphore._value == 0:
        logger.info(f"[QUEUE {rid}] Waiting for slot (model={resolved_model})")

    async with _backend_semaphore:
        t_queued = time.time()
        queue_wait = t_queued - t_recv
        if LOG_QUEUE and queue_wait > 0.1:
            logger.info(f"[QUEUE] Waited {queue_wait:.1f}s in queue")

        deadline = t_queued + RETRY_MAX_WAIT
        attempt  = 0

        while True:
            # Cancel propagation: if client disconnected before we even sent
            # the upstream request, abort early to save quota.
            if await request.is_disconnected():
                logger.info(f"[CANCEL {rid}] Client disconnected before dispatch — aborting")
                return error_response(499, "client_disconnected", "Client closed request")

            headers = {
                "Content-Type":  "application/json",
                "x-request-id":  rid,
            }
            # Bearer if the connected provider has an api_key; keyless upstreams
            # get no auth header ("Bearer " with an empty token is illegal).
            _bearer = _upstream_bearer()
            if _bearer:
                headers["Authorization"] = f"Bearer {_bearer}"
            try:
                t_send = time.time()

                # ---- STREAMING PATH ----
                if wants_stream:
                    # Open streaming request; we'll convert SSE on the fly.
                    req = http_client.build_request(
                        "POST", chat_target_url, json=openai_body, headers=headers,
                    )
                    upstream = await http_client.send(req, stream=True)

                    if upstream.status_code == 429:
                        # Drain & close so the connection is reusable, then handle 429
                        await upstream.aclose()
                        resp = type("R", (), {
                            "status_code": 429,
                            "headers": upstream.headers,
                            "json": lambda: {},
                            "text": "rate_limited",
                        })()
                    elif upstream.status_code != 200:
                        body_text = (await upstream.aread()).decode("utf-8", errors="replace")
                        await upstream.aclose()
                        logger.error(f"[ERROR {rid}] Backend stream returned {upstream.status_code}: {body_text[:500]}")
                        native_fallback = await try_native_after_chat_failure(f"stream status={upstream.status_code}")
                        if native_fallback is not None:
                            return native_fallback
                        return error_response(upstream.status_code, "api_error", body_text[:500])
                    else:
                        # Success — wrap and stream back to client
                        msg_id = f"msg_{uuid.uuid4().hex[:24]}"
                        backend_first_byte_ms = round((time.time() - t_send) * 1000)
                        if LOG_TIMING:
                            logger.info(f"[TIMING {rid}] stream_first_byte={backend_first_byte_ms}ms queue_wait={queue_wait:.1f}s")

                        # Freeze loop variables via default args to avoid closure capture bug
                        # (async def inside while-loop captures by reference in Python)
                        async def relay(
                            _upstream=upstream,
                            _model=resolved_model,
                            _msg_id=msg_id,
                            _rid=rid,
                        ):
                            try:
                                async for chunk in stream_openai_to_anthropic(_upstream, _model, _msg_id):
                                    if await request.is_disconnected():
                                        logger.info(f"[CANCEL {_rid}] Client disconnected mid-stream")
                                        break
                                    yield chunk
                            finally:
                                await _upstream.aclose()

                        from fastapi.responses import StreamingResponse
                        return StreamingResponse(
                            relay(),
                            media_type="text/event-stream",
                            headers={
                                "x-request-id": rid,
                                "Cache-Control": "no-cache",
                                "Connection": "keep-alive",
                                "X-Accel-Buffering": "no",
                            },
                        )

                # ---- NON-STREAMING PATH ----
                resp = await http_client.post(chat_target_url, json=openai_body, headers=headers)
                t_resp = time.time()

                if resp.status_code == 200:
                    data = resp.json()

                    usage = data.get("usage", {})
                    in_tok = usage.get("prompt_tokens", 0)
                    out_tok = usage.get("completion_tokens", 0)
                    token_tracker.record(in_tok, out_tok)
                    snap = token_tracker.tpm_snapshot()
                    backend_ms = round((t_resp - t_send) * 1000)
                    total_ms = round((t_resp - t_recv) * 1000)
                    if LOG_TOKENS:
                        logger.info(
                            f"[TOKENS {rid}] in={in_tok} out={out_tok} total={in_tok+out_tok} | "
                            f"est_tpm={snap['estimated_tpm']} "
                            f"session={snap['session_total_tokens']} ({snap['session_requests']} reqs)"
                        )
                    if LOG_TIMING:
                        logger.info(f"[TIMING {rid}] backend={backend_ms}ms  total={total_ms}ms  queue_wait={queue_wait:.1f}s")

                    anthropic_resp = openai_response_to_anthropic(data, resolved_model)
                    return Response(
                        content=json.dumps(anthropic_resp, ensure_ascii=False),
                        media_type="application/json",
                        headers={"x-request-id": rid},
                    )

                if resp.status_code == 429:
                    attempt += 1

                    if LOG_RETRY and attempt == 1:
                        rl_headers = {k: v for k, v in resp.headers.items()
                                      if any(x in k.lower() for x in ("ratelimit", "retry", "quota", "limit", "reset", "remaining", "x-request"))}
                        if rl_headers:
                            logger.warning(f"[429] Headers: {rl_headers}")
                        else:
                            logger.warning("[429] No rate-limit headers returned by backend")
                        try:
                            body_preview = resp.json()
                            logger.warning(f"[429] Body: {body_preview}")
                        except Exception:
                            logger.warning(f"[429] Body (raw): {resp.text[:300]}")

                    retry_after = resp.headers.get("Retry-After") or resp.headers.get("x-ratelimit-reset-after")
                    if retry_after:
                        try:
                            wait = float(retry_after)
                            if LOG_RETRY:
                                logger.warning(f"[429] Retry-After={wait:.1f}s (attempt {attempt})")
                        except ValueError:
                            retry_after = None

                    if not retry_after:
                        backoff = min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), RETRY_MAX_DELAY)
                        wait = backoff * random.uniform(0.7, 1.3)
                        if LOG_RETRY:
                            logger.warning(f"[429] Rate limit — backoff {wait:.1f}s (attempt {attempt})")

                    if time.time() + wait > deadline:
                        logger.error(f"[429] Giving up — {RETRY_MAX_WAIT}s budget exhausted after {attempt} attempts")
                        return error_response(
                            429,
                            "rate_limit_error",
                            f"Rate limit exceeded for '{resolved_model}' — quota did not recover within {RETRY_MAX_WAIT}s.",
                        )

                    await asyncio.sleep(wait)
                    continue

                logger.error(f"[ERROR] Backend returned {resp.status_code}")
                logger.error(f"[ERROR] Response body: {resp.text[:2000]}")
                try:
                    err = resp.json()
                    msg = (
                        err.get("message")
                        or err.get("error", {}).get("message")
                        or resp.text[:500]
                    )
                except Exception:
                    msg = resp.text[:500]
                native_fallback = await try_native_after_chat_failure(f"status={resp.status_code}")
                if native_fallback is not None:
                    return native_fallback
                return error_response(resp.status_code, "api_error", msg)

            except Exception as exc:
                attempt += 1
                if time.time() + RETRY_BASE_DELAY < deadline:
                    logger.warning(f"[EXCEPTION] {exc} — retrying in {RETRY_BASE_DELAY}s ...")
                    await asyncio.sleep(RETRY_BASE_DELAY)
                else:
                    logger.error(f"[EXCEPTION] {exc}")
                    native_fallback = await try_native_after_chat_failure(f"exception={exc}")
                    if native_fallback is not None:
                        return native_fallback
                    return error_response(500, "api_error", str(exc))
