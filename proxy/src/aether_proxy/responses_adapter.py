"""
responses_adapter.py — Anthropic ↔ OpenAI Responses API converter

The Renesas Playground exposes GPT-5.5 / GPT-5.4 (reasoning models) only via
the OpenAI **Responses API** at /openai/responses. The legacy Chat Completions
endpoint rejects function tools for these models because Databricks injects a
mandatory `reasoning_effort` parameter that is incompatible with `tools` on
that path.

This module performs three conversions:

  1. anthropic_to_responses_request()
       Anthropic /v1/messages body  →  Responses API request body

  2. responses_to_anthropic_response()
       Responses API JSON response  →  Anthropic /v1/messages response

  3. stream_responses_to_anthropic()
       Responses API SSE stream     →  Anthropic SSE stream

The key shape differences:

    Chat Completions (Path A)              Responses API (Path B)
    ─────────────────────────              ──────────────────────
    messages: [...]                        input: [...]
    max_tokens                             max_output_tokens
    reasoning_effort: "high"               reasoning: {effort, summary}
    tools: [{type, function:{...}}]        tools: [{type, name, params}]
    choices[].message.content              output[].content[].text
    choices[].message.tool_calls           output[]={type:function_call,...}
    SSE delta.content                      SSE response.output_text.delta

The Anthropic SSE protocol on the wire is unchanged — Claude Code on the
client side never knows it was a Responses API call.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, AsyncIterator, Iterable

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Request:  Anthropic  →  Responses API
# ---------------------------------------------------------------------------

def _anthropic_text_blocks_to_string(content: Any) -> str:
    """Flatten Anthropic content (string or list of blocks) into a single string.

    Used for the system prompt → `instructions` field which only accepts text.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return str(content)


def _anthropic_tools_to_responses(tools: list | None) -> list | None:
    """Convert Anthropic tool defs → Responses API tool defs.

    Anthropic functions: {name, description, input_schema: {...}}
    Responses functions: {type:"function", name, description, parameters: {...}}
                         (flat — NOT wrapped in "function": {...})

    Renesas/Databricks also supports native Responses web search as
    {type:"web_search"}. Pass that through instead of converting it into a
    function tool, otherwise the model emits a tool call and waits for the
    client to execute search.
    """
    if not tools:
        return None
    result = []
    for t in tools:
        if not isinstance(t, dict):
            continue

        tool_type = t.get("type")
        if tool_type in ("web_search", "web_search_preview", "web_search_20250305"):
            web_tool = {"type": "web_search"}
            for key in ("search_context_size", "user_location", "return_token_budget"):
                if key in t:
                    web_tool[key] = t[key]
            result.append(web_tool)
            continue

        name = t.get("name")
        if not name:
            continue
        result.append({
            "type":        "function",
            "name":        name,
            "description": t.get("description", ""),
            "parameters":  t.get("input_schema") or {"type": "object", "properties": {}},
        })
    return result if result else None


def _user_or_assistant_content_to_input_parts(content: Any) -> list[dict] | str:
    """Convert one Anthropic message content field → Responses API content parts.

    Returns either a plain string (when only text) or a list of typed parts.
    Image blocks are converted to input_image with data-URI / URL.
    """
    if isinstance(content, str):
        return content

    if not isinstance(content, list):
        return str(content)

    parts: list[dict] = []
    only_text = True

    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")

        if btype == "text":
            parts.append({"type": "input_text", "text": block.get("text", "")})

        elif btype == "image":
            only_text = False
            source = block.get("source", {}) or {}
            stype = source.get("type")
            if stype == "base64":
                media = source.get("media_type", "image/png")
                data  = source.get("data", "")
                parts.append({
                    "type": "input_image",
                    "image_url": f"data:{media};base64,{data}",
                })
            elif stype == "url":
                parts.append({
                    "type": "input_image",
                    "image_url": source.get("url", ""),
                })
            # Unknown source types are silently dropped

        # tool_use / tool_result are handled at message-level (see caller)

    if only_text and parts:
        # Collapse to plain string when there are no images — keeps payload small
        return "".join(p.get("text", "") for p in parts)
    return parts


def anthropic_to_responses_request(
    anthropic_body: dict,
    *,
    resolved_model: str,
    reasoning_effort: str | None = None,
    reasoning_summary: str | None = "auto",
) -> dict:
    """Build a Responses-API request body from an Anthropic /v1/messages body.

    Parameters
    ----------
    anthropic_body : dict
        The original Anthropic-format request received from Claude Code.
    resolved_model : str
        Already-resolved Renesas model id (e.g. "databricks-gpt-5-5").
    reasoning_effort : str | None
        One of "none", "low", "medium", "high", "xhigh".
        If None → omit the `reasoning` field (backend default = medium).
    reasoning_summary : str | None
        "auto" | "concise" | "detailed" | None — controls reasoning summary
        verbosity. Defaults to "auto" which lets the model decide.

    Returns
    -------
    dict
        Body suitable for POST /openai/responses.
    """
    # --- Build "input" array ----------------------------------------------
    input_items: list[dict] = []

    raw_messages = anthropic_body.get("messages") or []
    for msg in raw_messages:
        if not isinstance(msg, dict):
            continue
        role    = msg.get("role")
        content = msg.get("content", "")

        # Tool calls live on assistant messages; tool results live on user messages.
        if isinstance(content, list):
            # Split into chunks: text/image parts vs tool_use vs tool_result
            text_image_parts: list[dict] = []
            tool_use_blocks:   list[dict] = []
            tool_result_blocks: list[dict] = []

            for block in content:
                if not isinstance(block, dict):
                    continue
                bt = block.get("type")
                if bt == "tool_use":
                    tool_use_blocks.append(block)
                elif bt == "tool_result":
                    tool_result_blocks.append(block)
                else:
                    text_image_parts.append(block)

            # Emit text/image content first (preserve user/assistant role)
            if text_image_parts:
                converted = _user_or_assistant_content_to_input_parts(text_image_parts)
                input_items.append({"role": role, "content": converted})

            # Emit each tool_use as a function_call item
            for tu in tool_use_blocks:
                args = tu.get("input", {}) or {}
                if not isinstance(args, str):
                    args = json.dumps(args, ensure_ascii=False)
                input_items.append({
                    "type":      "function_call",
                    "call_id":   tu.get("id", f"call_{uuid.uuid4().hex[:8]}"),
                    "name":      tu.get("name", ""),
                    "arguments": args,
                })

            # Emit each tool_result as a function_call_output item
            for tr in tool_result_blocks:
                raw = tr.get("content", "")
                if isinstance(raw, list):
                    # Flatten to text — Responses API tool output must be a string.
                    # (Image-in-tool-output isn't supported on this path; would need
                    #  a follow-up user message with the image.)
                    pieces = []
                    for sub in raw:
                        if isinstance(sub, dict):
                            if sub.get("type") == "text":
                                pieces.append(sub.get("text", ""))
                            else:
                                pieces.append(json.dumps(sub, ensure_ascii=False))
                        else:
                            pieces.append(str(sub))
                    output_str = "\n".join(p for p in pieces if p)
                else:
                    output_str = str(raw)
                input_items.append({
                    "type":    "function_call_output",
                    "call_id": tr.get("tool_use_id", ""),
                    "output":  output_str,
                })
        else:
            # Plain string content
            input_items.append({"role": role, "content": str(content)})

    # --- Build request body ----------------------------------------------
    out: dict[str, Any] = {
        "model": resolved_model,
        "input": input_items,
    }

    # max_output_tokens (Responses API name)
    if "max_tokens" in anthropic_body:
        out["max_output_tokens"] = anthropic_body["max_tokens"]

    # System prompt → instructions
    system = anthropic_body.get("system")
    if system:
        out["instructions"] = _anthropic_text_blocks_to_string(system)

    # Sampling
    if "temperature" in anthropic_body:
        out["temperature"] = anthropic_body["temperature"]
    if "top_p" in anthropic_body:
        out["top_p"] = anthropic_body["top_p"]

    # Tools (Responses API uses flat shape, not nested)
    tools = _anthropic_tools_to_responses(anthropic_body.get("tools"))
    if tools:
        out["tools"]       = tools
        out["tool_choice"] = "auto"

    # Reasoning effort
    if reasoning_effort and reasoning_effort != "off":
        reasoning: dict[str, Any] = {"effort": reasoning_effort}
        if reasoning_summary:
            reasoning["summary"] = reasoning_summary
        out["reasoning"] = reasoning

    # Streaming
    if anthropic_body.get("stream"):
        out["stream"] = True

    return out


# ---------------------------------------------------------------------------
# Response (non-streaming):  Responses API  →  Anthropic
# ---------------------------------------------------------------------------

def responses_to_anthropic_response(
    responses_body: dict,
    *,
    resolved_model: str,
) -> dict:
    """Convert a non-streaming Responses-API JSON body → Anthropic format.

    Anthropic content blocks emitted, in this order:
      - thinking (from `reasoning` items, if any)
      - text     (from `message` items)
      - tool_use (from `function_call` items)
    """
    output_items = responses_body.get("output", []) or []
    content_blocks: list[dict] = []
    has_tool_call = False

    for item in output_items:
        if not isinstance(item, dict):
            continue
        itype = item.get("type")

        if itype == "reasoning":
            # Aggregate summary[] entries into a single thinking block
            summary = item.get("summary") or []
            text_parts = []
            for s in summary:
                if isinstance(s, dict) and s.get("type") == "summary_text":
                    text_parts.append(s.get("text", ""))
            if text_parts:
                content_blocks.append({
                    "type":      "thinking",
                    "thinking":  "".join(text_parts),
                    "signature": item.get("id", ""),  # opaque signature placeholder
                })

        elif itype == "message":
            # message.content is a list of {type:output_text, text}
            for c in item.get("content", []) or []:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    txt = c.get("text", "")
                    if txt:
                        content_blocks.append({"type": "text", "text": txt})

        elif itype == "function_call":
            has_tool_call = True
            args_raw = item.get("arguments", "{}")
            try:
                args = json.loads(args_raw) if isinstance(args_raw, str) else (args_raw or {})
            except (json.JSONDecodeError, TypeError):
                args = {}
            content_blocks.append({
                "type":  "tool_use",
                "id":    item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                "name":  item.get("name", "unknown"),
                "input": args,
            })
        # Unknown item types are dropped (forward-compat)

    # Determine stop_reason
    if has_tool_call:
        stop_reason = "tool_use"
    else:
        status = responses_body.get("status")
        incomplete = (responses_body.get("incomplete_details") or {}).get("reason")
        if incomplete in ("max_output_tokens", "max_tokens"):
            stop_reason = "max_tokens"
        elif status == "completed":
            stop_reason = "end_turn"
        else:
            stop_reason = status or "end_turn"

    # Usage mapping
    usage_in = responses_body.get("usage") or {}
    out_usage = {
        "input_tokens":  usage_in.get("input_tokens", 0),
        "output_tokens": usage_in.get("output_tokens", 0),
    }

    return {
        "id":            responses_body.get("id") or f"msg_{uuid.uuid4().hex[:24]}",
        "type":          "message",
        "role":          "assistant",
        "model":         responses_body.get("model", resolved_model),
        "content":       content_blocks,
        "stop_reason":   stop_reason,
        "stop_sequence": None,
        "usage":         out_usage,
    }


# ---------------------------------------------------------------------------
# Streaming:  Responses API SSE  →  Anthropic SSE
# ---------------------------------------------------------------------------
#
# The Responses-API stream emits events like:
#   event: response.created
#   event: response.in_progress
#   event: response.output_item.added       { item: {type:reasoning|message|function_call, ...} }
#   event: response.reasoning_summary_text.delta   { delta: "..." }
#   event: response.reasoning_summary_text.done    { text: "..." }
#   event: response.content_part.added      { part: {type:output_text, text:""} }
#   event: response.output_text.delta       { delta: "..." }
#   event: response.output_text.done        { text: "..." }
#   event: response.function_call_arguments.delta  { delta: "..." }
#   event: response.function_call_arguments.done   { arguments: "..." }
#   event: response.output_item.done        { item: {...} }
#   event: response.completed               { response: {...full body...} }
#
# We translate these into the Anthropic event sequence:
#   message_start
#   content_block_start (thinking | text | tool_use)
#   content_block_delta (thinking_delta | text_delta | input_json_delta)
#   content_block_stop
#   ...repeated per block...
#   message_delta (with stop_reason + usage)
#   message_stop


def _sse(event: str, data: dict) -> bytes:
    """Format an SSE event with both `event:` and `data:` lines."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


async def stream_responses_to_anthropic(
    upstream_response,
    *,
    resolved_model: str,
    msg_id: str,
) -> AsyncIterator[bytes]:
    """Convert an httpx streaming Responses-API response into Anthropic SSE chunks.

    Parameters
    ----------
    upstream_response : httpx.Response (with stream=True)
        The open streaming response from the Responses API.
    resolved_model : str
        Renesas model id (passed through into message_start).
    msg_id : str
        Anthropic message id (msg_xxx) to emit in message_start.
    """
    # Per-item state. Responses API uses output_index to identify each item;
    # we map that to an Anthropic content_block index.
    item_state: dict[int, dict] = {}
    next_anthropic_idx = 0

    # Final usage / stop info from the last `response.completed` event.
    final_usage = {"input_tokens": 0, "output_tokens": 0}
    final_stop_reason = "end_turn"

    started = False

    async def open_block(output_index: int, block_kind: str, **extras) -> bytes | None:
        """Open an Anthropic content_block and remember it for later deltas."""
        nonlocal next_anthropic_idx
        if output_index in item_state:
            return None  # already opened
        a_idx = next_anthropic_idx
        next_anthropic_idx += 1

        if block_kind == "thinking":
            content_block = {"type": "thinking", "thinking": ""}
        elif block_kind == "text":
            content_block = {"type": "text", "text": ""}
        elif block_kind == "tool_use":
            content_block = {
                "type":  "tool_use",
                "id":    extras.get("tool_id", ""),
                "name":  extras.get("tool_name", ""),
                "input": {},
            }
        else:
            return None

        item_state[output_index] = {
            "anthropic_idx": a_idx,
            "kind":          block_kind,
            "open":          True,
            "args_buf":      "",   # for tool_use
            "signature":     "",   # for thinking
        }
        return _sse("content_block_start", {
            "type":          "content_block_start",
            "index":         a_idx,
            "content_block": content_block,
        })

    async def close_block(output_index: int) -> bytes | None:
        st = item_state.get(output_index)
        if not st or not st.get("open"):
            return None
        st["open"] = False
        return _sse("content_block_stop", {
            "type":  "content_block_stop",
            "index": st["anthropic_idx"],
        })

    # ---- Emit message_start immediately so Claude Code can paint UI ----
    yield _sse("message_start", {
        "type": "message_start",
        "message": {
            "id":            msg_id,
            "type":          "message",
            "role":          "assistant",
            "model":         resolved_model,
            "content":       [],
            "stop_reason":   None,
            "stop_sequence": None,
            "usage":         {"input_tokens": 0, "output_tokens": 0},
        },
    })
    started = True

    # ---- Pump the Responses API SSE stream ------------------------------
    # Use aiter_bytes + manual split instead of aiter_lines() because httpx's
    # aiter_lines() can return the entire response body as a single "line" when
    # the connection is reused from a pool (keep-alive), causing all SSE events
    # to be missed.
    pending_event: str | None = None
    _dbg_line_count = 0
    _buf = b""

    async def _iter_sse_lines():
        nonlocal _buf
        _n_bytes_chunks = 0
        async for chunk in upstream_response.aiter_bytes():
            _n_bytes_chunks += 1
            _buf += chunk
            while b"\n" in _buf:
                line, _buf = _buf.split(b"\n", 1)
                yield line.rstrip(b"\r").decode("utf-8", errors="replace")
        # flush remainder
        logger.info(f"[ADAPTER] aiter_bytes done: {_n_bytes_chunks} byte-chunks, buf_rem={len(_buf)}")
        if _buf:
            yield _buf.rstrip(b"\r").decode("utf-8", errors="replace")
            _buf = b""

    async for raw_line in _iter_sse_lines():
        _dbg_line_count += 1
        if not raw_line:
            pending_event = None
            continue

        if raw_line.startswith("event: "):
            pending_event = raw_line[len("event: "):].strip()
            continue

        if not raw_line.startswith("data: "):
            continue

        payload = raw_line[len("data: "):].strip()
        if not payload or payload == "[DONE]":
            continue

        try:
            evt = json.loads(payload)
        except json.JSONDecodeError:
            continue

        ev_type = evt.get("type") or pending_event or ""

        # ---- output_item.added: open the matching anthropic block --------
        if ev_type == "response.output_item.added":
            item = evt.get("item") or {}
            idx  = evt.get("output_index", 0)
            it   = item.get("type")
            if it == "reasoning":
                chunk = await open_block(idx, "thinking")
                if chunk: yield chunk
            elif it == "message":
                chunk = await open_block(idx, "text")
                if chunk: yield chunk
            elif it == "function_call":
                chunk = await open_block(
                    idx, "tool_use",
                    tool_id=item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                    tool_name=item.get("name", "unknown"),
                )
                if chunk: yield chunk

        # ---- text deltas -------------------------------------------------
        elif ev_type == "response.output_text.delta":
            idx   = evt.get("output_index", 0)
            delta = evt.get("delta", "") or ""
            st    = item_state.get(idx)
            if st and st.get("open") and st.get("kind") == "text" and delta:
                yield _sse("content_block_delta", {
                    "type":  "content_block_delta",
                    "index": st["anthropic_idx"],
                    "delta": {"type": "text_delta", "text": delta},
                })

        # ---- reasoning summary deltas (thinking) ------------------------
        elif ev_type in (
            "response.reasoning_summary_text.delta",
            "response.reasoning.delta",          # alt name some backends emit
        ):
            idx   = evt.get("output_index", 0)
            delta = evt.get("delta", "") or ""
            st    = item_state.get(idx)
            if st and st.get("open") and st.get("kind") == "thinking" and delta:
                yield _sse("content_block_delta", {
                    "type":  "content_block_delta",
                    "index": st["anthropic_idx"],
                    "delta": {"type": "thinking_delta", "thinking": delta},
                })

        # ---- tool_call argument deltas ----------------------------------
        elif ev_type == "response.function_call_arguments.delta":
            idx   = evt.get("output_index", 0)
            delta = evt.get("delta", "") or ""
            st    = item_state.get(idx)
            if st and st.get("open") and st.get("kind") == "tool_use" and delta:
                st["args_buf"] += delta
                yield _sse("content_block_delta", {
                    "type":  "content_block_delta",
                    "index": st["anthropic_idx"],
                    "delta": {"type": "input_json_delta", "partial_json": delta},
                })

        # ---- output_item.done: close the matching anthropic block -------
        elif ev_type == "response.output_item.done":
            idx = evt.get("output_index", 0)
            st  = item_state.get(idx)
            # Optionally emit a signature_delta for thinking blocks before close
            if st and st.get("kind") == "thinking" and st.get("open"):
                item = evt.get("item") or {}
                sig = item.get("id") or ""
                if sig:
                    yield _sse("content_block_delta", {
                        "type":  "content_block_delta",
                        "index": st["anthropic_idx"],
                        "delta": {"type": "signature_delta", "signature": sig},
                    })
            chunk = await close_block(idx)
            if chunk: yield chunk

        # ---- response.completed: capture final usage --------------------
        elif ev_type == "response.completed":
            resp_body = evt.get("response") or {}
            usage = resp_body.get("usage") or {}
            final_usage = {
                "input_tokens":  usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
            }
            # Determine stop_reason
            output_items = resp_body.get("output") or []
            had_tool_call = any(
                isinstance(o, dict) and o.get("type") == "function_call"
                for o in output_items
            )
            if had_tool_call:
                final_stop_reason = "tool_use"
            else:
                incomplete = (resp_body.get("incomplete_details") or {}).get("reason")
                if incomplete in ("max_output_tokens", "max_tokens"):
                    final_stop_reason = "max_tokens"
                else:
                    final_stop_reason = "end_turn"

        elif ev_type == "response.failed" or ev_type == "response.incomplete":
            resp_body = evt.get("response") or {}
            err = resp_body.get("error") or {}
            logger.error(
                f"[RESPONSES] Stream ended with {ev_type}: {err.get('message', err)}"
            )
            final_stop_reason = "error"

        # All other event types (deltas of intermediate types, content_part.added,
        # response.created/in_progress, etc.) are intentionally ignored — Anthropic
        # protocol only needs block-level start/delta/stop events.

    logger.info(f"[ADAPTER] stream done: {_dbg_line_count} raw lines, {len(item_state)} items, stop={final_stop_reason}, buf_remainder={len(_buf)}")

    # ---- Close any blocks the backend forgot to .done -------------------
    for idx, st in item_state.items():
        if st.get("open"):
            chunk = await close_block(idx)
            if chunk: yield chunk

    # ---- Emit message_delta + message_stop ------------------------------
    yield _sse("message_delta", {
        "type":  "message_delta",
        "delta": {"stop_reason": final_stop_reason, "stop_sequence": None},
        "usage": final_usage,
    })
    yield _sse("message_stop", {"type": "message_stop"})
