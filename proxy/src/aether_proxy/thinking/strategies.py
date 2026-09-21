"""
Thinking injection strategies — one per Claude model schema family.

Each strategy knows how to inject the correct fields into an OpenAI-format
request body to enable extended thinking on Renesas Playground.

Verified schemas (2026-05-27, opus-4-8/sonnet-5 added 2026-07-25):
- AdaptiveThinkingStrategy   → opus-4-6/4-7/4-8, sonnet-4-5/4-6/5
- LegacyBudgetThinkingStrategy → opus-4-5, haiku-4-5
- NoThinkingStrategy         → fallback for unknown models
"""

import json
import os
from abc import ABC, abstractmethod
from typing import Optional


# 0.4.177 — same per-model max_tokens map as proxy.fallback_max_tokens.
# Duplicated here (small) instead of importing from proxy to avoid a
# circular dependency (proxy imports .thinking on module load).
def _fallback_max_tokens(model: str) -> int:
    try:
        raw = (os.environ.get("AURA_MODEL_MAX_TOKENS") or "").strip()
        cfg = json.loads(raw) if raw else {}
    except Exception:
        cfg = {}
    if not model:
        return int(cfg.get("default", 8192))
    norm = model.replace("databricks-", "")
    if norm in cfg:
        return int(cfg[norm])
    if model in cfg:
        return int(cfg[model])
    return int(cfg.get("default", 8192))


# Effort levels accepted by adaptive thinking models.
# These map to a continuum of thinking depth.
VALID_EFFORTS = {"off", "low", "medium", "high", "xhigh", "max"}

# For legacy models, effort levels translate to explicit token budgets.
# These values follow Anthropic's recommended ranges from their docs.
EFFORT_TO_BUDGET = {
    "low":    1024,
    "medium": 4096,
    "high":   16000,
    "max":    32000,
}


class ThinkingStrategy(ABC):
    """Abstract base — one concrete impl per schema family."""

    name: str = "abstract"

    @abstractmethod
    def inject(self, body: dict, effort: str) -> dict:
        """Mutate `body` in-place to enable thinking at given effort level."""
        ...

    @abstractmethod
    def supports_effort(self, effort: str) -> bool:
        """Return True if this strategy accepts the given effort string."""
        ...


# ---------------------------------------------------------------------------
# Strategy 1: Adaptive thinking (opus-4-6/4-7, sonnet-4-5/4-6)
# ---------------------------------------------------------------------------
class AdaptiveThinkingStrategy(ThinkingStrategy):
    """
    For models that accept Anthropic's new adaptive thinking API.

    Schema (verified on Renesas Playground):
        {
            "thinking": {"type": "adaptive", "display": "summarized"},
            "output_config": {"effort": "low|medium|high|max"}
        }

    The model itself decides whether to spend thinking tokens — `effort`
    is an upper bound, not a fixed budget.
    """

    name = "adaptive"

    def inject(self, body: dict, effort: str) -> dict:
        body["thinking"] = {"type": "adaptive", "display": "summarized"}
        body["output_config"] = {"effort": effort}
        return body

    def supports_effort(self, effort: str) -> bool:
        return effort in {"low", "medium", "high", "xhigh", "max"}


# ---------------------------------------------------------------------------
# Strategy 2: Legacy budget thinking (opus-4-5, haiku-4-5)
# ---------------------------------------------------------------------------
class LegacyBudgetThinkingStrategy(ThinkingStrategy):
    """
    For models that still use the older "enabled + budget_tokens" schema.

    Schema (verified on Renesas Playground):
        {
            "thinking": {"type": "enabled", "budget_tokens": <int>}
        }

    `max_tokens` must be larger than `budget_tokens` (we add a 4K buffer).
    """

    name = "legacy"

    def inject(self, body: dict, effort: str) -> dict:
        budget = EFFORT_TO_BUDGET[effort]

        # Renesas enforces the model's hard max_tokens ceiling server-side
        # before validating budget_tokens < max_tokens. Clamp budget to stay
        # under that ceiling — continuation loop handles thinking_only turns.
        model_max = _fallback_max_tokens(body.get("model", ""))
        budget = min(budget, model_max - 1)

        body["max_tokens"] = model_max
        body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        return body

    def supports_effort(self, effort: str) -> bool:
        return effort in EFFORT_TO_BUDGET


# ---------------------------------------------------------------------------
# Strategy 3: No-op (fallback for unknown / non-Claude models)
# ---------------------------------------------------------------------------
class NoThinkingStrategy(ThinkingStrategy):
    """Pass-through — used when the model has no thinking support."""

    name = "none"

    def inject(self, body: dict, effort: str) -> dict:
        return body  # no-op

    def supports_effort(self, effort: str) -> bool:
        return False
