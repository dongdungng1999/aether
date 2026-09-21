"""
thinking — Strategy Pattern for Claude thinking mode injection.

Different Claude models use different schemas to enable extended thinking:
- Opus 4.6/4.7, Sonnet 4.5/4.6 use: thinking={"type":"adaptive"} + output_config={"effort":...}
- Opus 4.5, Haiku 4.5 use:           thinking={"type":"enabled","budget_tokens":N}

The ThinkingRouter selects the right strategy per model name.
"""

from .router import ThinkingRouter, parse_effort_command
from .strategies import (
    ThinkingStrategy,
    AdaptiveThinkingStrategy,
    LegacyBudgetThinkingStrategy,
    NoThinkingStrategy,
)

__all__ = [
    "ThinkingRouter",
    "parse_effort_command",
    "ThinkingStrategy",
    "AdaptiveThinkingStrategy",
    "LegacyBudgetThinkingStrategy",
    "NoThinkingStrategy",
]
