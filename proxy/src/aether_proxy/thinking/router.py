"""
ThinkingRouter — Smart router (Strategy Pattern dispatcher).

Maps a resolved model name to the correct ThinkingStrategy and exposes a
single `apply(body, model, effort)` entry point used by the proxy handler.

Also provides `parse_effort_command()` — extracts and strips a leading
"/effort <level>" slash command from the last user message in an
Anthropic-format messages array.
"""

import logging
import re
from typing import Optional, Tuple

from .strategies import (
    ThinkingStrategy,
    AdaptiveThinkingStrategy,
    LegacyBudgetThinkingStrategy,
    NoThinkingStrategy,
)

logger = logging.getLogger(__name__)


# Slash command at the very start of a user message:
#   /effort high
#   /effort off
# Captured group is the effort level (lowercase).
EFFORT_PATTERN = re.compile(
    r"^\s*/effort\s+(off|low|medium|high|xhigh|max)\b\s*\n?",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# ThinkingRouter — one instance per proxy
# ---------------------------------------------------------------------------
class ThinkingRouter:
    """
    Selects the right ThinkingStrategy for a given model name.

    Registration uses substring matching against the resolved (Databricks)
    model name, so both `databricks-claude-opus-4-7` and
    `databricks-claude-opus-4-6` route to the AdaptiveThinkingStrategy
    via the shared "opus-4-" patterns.
    """

    def __init__(self, default_effort: str = "medium", default_enabled: bool = False):
        self.default_effort = default_effort
        self.default_enabled = default_enabled

        self._adaptive = AdaptiveThinkingStrategy()
        self._legacy   = LegacyBudgetThinkingStrategy()
        self._none     = NoThinkingStrategy()

        # Substring patterns → strategy.
        # Order doesn't matter here because patterns don't overlap, but if you
        # add a more-specific one later, put it before its more general sibling.
        self._patterns: list[tuple[str, ThinkingStrategy]] = [
            # Verified 2026-07-25 via curl against /openai/chat/completions:
            # opus-4-8 and sonnet-5 both accept the same adaptive schema
            # ({"thinking": {"type": "adaptive", ...}, "output_config": {...}})
            # as opus-4-7/4-6 and sonnet-4-6/4-5 — response content included
            # a "reasoning" block. They were missing from this list, which
            # is why thinking silently no-op'd (NoThinkingStrategy) for them.
            ("claude-opus-4-8",   self._adaptive),
            ("claude-opus-4-7",   self._adaptive),
            ("claude-opus-4-6",   self._adaptive),
            ("claude-sonnet-5",   self._adaptive),
            ("claude-sonnet-4-6", self._adaptive),
            ("claude-sonnet-4-5", self._adaptive),
            ("claude-opus-4-5",   self._legacy),
            ("claude-haiku-4-5",  self._legacy),
        ]

    def route(self, model: str) -> ThinkingStrategy:
        """Return the strategy responsible for `model`, or NoThinkingStrategy."""
        if not model:
            return self._none
        for pattern, strategy in self._patterns:
            if pattern in model:
                return strategy
        return self._none

    def apply(self, body: dict, model: str, effort: Optional[str]) -> tuple[dict, str]:
        """
        Apply the appropriate thinking strategy to `body`.

        Returns (modified_body, effort_used). `effort_used` is "off" when
        nothing was injected (caller can use it for logging).
        """
        # Resolve effort: explicit > default
        if effort is None:
            if self.default_enabled:
                effort = self.default_effort
            else:
                effort = "off"

        if effort == "off":
            return body, "off"

        strategy = self.route(model)
        if isinstance(strategy, NoThinkingStrategy):
            logger.warning(
                f"[THINKING] Model '{model}' has no thinking strategy registered — skipping"
            )
            return body, "off"

        if not strategy.supports_effort(effort):
            logger.warning(
                f"[THINKING] Strategy '{strategy.name}' does not support effort='{effort}' — skipping"
            )
            return body, "off"

        body = strategy.inject(body, effort)
        return body, effort


# ---------------------------------------------------------------------------
# Slash command parser
# ---------------------------------------------------------------------------
def parse_effort_command(messages: list) -> Tuple[Optional[str], list]:
    """
    Look for a leading "/effort <level>" in the LAST user message.

    Returns (effort_level_or_None, messages_with_command_stripped).

    The command must appear at the very start of the message (modulo
    whitespace) — anything else is treated as normal content.

    Both string-content and list-content (multimodal) messages are handled.
    The original messages list is not mutated; a shallow-copied list is
    returned with the modified message.
    """
    if not messages:
        return None, messages

    # Walk from the end to find the last user-role message.
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.get("role") != "user":
            continue

        content = msg.get("content")

        # Case 1: simple string content
        if isinstance(content, str):
            match = EFFORT_PATTERN.match(content)
            if not match:
                return None, messages
            effort = match.group(1).lower()
            cleaned = EFFORT_PATTERN.sub("", content, count=1).lstrip()

            new_messages = list(messages)
            new_msg = dict(msg)
            new_msg["content"] = cleaned
            new_messages[i] = new_msg
            return effort, new_messages

        # Case 2: list content — Anthropic multimodal format
        # Look at the FIRST text block; ignore image/tool blocks.
        if isinstance(content, list) and content:
            first = content[0]
            if not isinstance(first, dict) or first.get("type") != "text":
                return None, messages
            text = first.get("text", "")
            match = EFFORT_PATTERN.match(text)
            if not match:
                return None, messages
            effort = match.group(1).lower()
            cleaned = EFFORT_PATTERN.sub("", text, count=1).lstrip()

            new_messages = list(messages)
            new_msg = dict(msg)
            new_content = list(content)
            new_first = dict(first)
            new_first["text"] = cleaned
            new_content[0] = new_first
            new_msg["content"] = new_content
            new_messages[i] = new_msg
            return effort, new_messages

        # Other content types — no slash to extract.
        return None, messages

    return None, messages
