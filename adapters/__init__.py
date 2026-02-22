"""
Adapters package - External system integrations
"""
from .telegram import TelegramAdapter, TelegramAction, TelegramTarget
from .agent_zero import AgentZeroAdapter, AgentZeroAction, AgentZeroTarget
from .openclaw import OpenClawAdapter, OpenClawAction, OpenClawTarget

__all__ = [
    "TelegramAdapter", "TelegramAction", "TelegramTarget",
    "AgentZeroAdapter", "AgentZeroAction", "AgentZeroTarget",
    "OpenClawAdapter", "OpenClawAction", "OpenClawTarget",
]
