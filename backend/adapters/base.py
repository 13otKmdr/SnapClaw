"""
AgentAdapter — the only interface the relay ever talks to.
Adding a new agent = new file implementing these two methods.
"""
from abc import ABC, abstractmethod
from typing import AsyncGenerator


class AgentAdapter(ABC):

    @abstractmethod
    async def send_message(
        self,
        text: str,
        context_id: str | None = None,
    ) -> tuple[str, str]:
        """
        Send a message to the agent and wait for the final response.

        Returns:
            (response_text, context_id)
            context_id is echoed back so the caller can persist it.
        """

    @abstractmethod
    async def stream_updates(
        self,
        context_id: str,
    ) -> AsyncGenerator[str, None]:
        """
        Subscribe to live log lines the agent emits while it works.
        Yields plain-text log strings as they arrive.
        Call this concurrently with send_message so the UI can show
        what the agent is doing in real time.
        """
        # make this a proper async generator
        return
        yield  # noqa: unreachable — needed so Python sees this as async gen

    @abstractmethod
    async def health_check(self) -> bool:
        """Return True if the agent backend is reachable."""
