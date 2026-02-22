"""
Rate limiting for external API calls
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
from collections import defaultdict
import asyncio


@dataclass
class RateLimit:
    """Rate limit configuration."""
    requests: int
    window_seconds: int


class RateLimiter:
    """Token bucket rate limiter per adapter."""

    DEFAULT_LIMITS = {
        "telegram": RateLimit(requests=30, window_seconds=60),
        "agent_zero": RateLimit(requests=10, window_seconds=60),
        "openclaw": RateLimit(requests=20, window_seconds=60),
    }

    def __init__(self, limits: dict = None):
        self.limits = limits or self.DEFAULT_LIMITS
        self._buckets = defaultdict(list)  # adapter -> [timestamps]
        self._lock = asyncio.Lock()

    async def acquire(self, adapter: str) -> bool:
        """Check if request is allowed. Returns True if allowed."""
        limit = self.limits.get(adapter)
        if not limit:
            return True

        async with self._lock:
            now = datetime.utcnow()
            cutoff = now - timedelta(seconds=limit.window_seconds)

            # Clean old entries
            self._buckets[adapter] = [
                ts for ts in self._buckets[adapter] if ts > cutoff
            ]

            if len(self._buckets[adapter]) >= limit.requests:
                return False

            self._buckets[adapter].append(now)
            return True

    async def wait_and_acquire(self, adapter: str, max_wait_seconds: int = 60) -> bool:
        """Wait if necessary, then acquire. Returns False if max_wait exceeded."""
        waited = 0
        while not await self.acquire(adapter):
            if waited >= max_wait_seconds:
                return False
            await asyncio.sleep(0.5)
            waited += 0.5
        return True

    def get_wait_time(self, adapter: str) -> float:
        """Get estimated wait time in seconds for adapter."""
        limit = self.limits.get(adapter)
        if not limit or not self._buckets[adapter]:
            return 0.0

        now = datetime.utcnow()
        cutoff = now - timedelta(seconds=limit.window_seconds)
        valid_timestamps = [ts for ts in self._buckets[adapter] if ts > cutoff]

        if len(valid_timestamps) < limit.requests:
            return 0.0

        # Wait until oldest entry expires
        oldest = min(valid_timestamps)
        wait_until = oldest + timedelta(seconds=limit.window_seconds)
        return max(0, (wait_until - now).total_seconds())
