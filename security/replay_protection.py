"""
Replay attack protection using nonce tracking
"""
from datetime import datetime, timedelta
from collections import OrderedDict
import hashlib
import secrets


class ReplayProtection:
    """Prevent replay attacks using nonce tracking."""

    def __init__(self, window_minutes: int = 5, max_nonces: int = 10000):
        self.window = timedelta(minutes=window_minutes)
        self.max_nonces = max_nonces
        self._seen_nonces = OrderedDict()  # nonce_hash -> timestamp

    def generate_nonce(self) -> str:
        """Generate a unique nonce."""
        return secrets.token_urlsafe(32)

    def _hash(self, nonce: str, payload: str) -> str:
        """Create hash of nonce+payload."""
        return hashlib.sha256(f"{nonce}:{payload}".encode()).hexdigest()

    def check_and_record(self, nonce: str, payload: str) -> bool:
        """
        Check if nonce+payload combo has been seen.
        Returns True if this is a new, valid request.
        """
        key = self._hash(nonce, payload)
        now = datetime.utcnow()

        # Clean old entries
        cutoff = now - self.window
        while self._seen_nonces:
            oldest_key, oldest_time = next(iter(self._seen_nonces.items()))
            if oldest_time < cutoff:
                self._seen_nonces.popitem(last=False)
            else:
                break

        # Check if seen
        if key in self._seen_nonces:
            return False  # Replay detected

        # Record new nonce
        if len(self._seen_nonces) >= self.max_nonces:
            self._seen_nonces.popitem(last=False)

        self._seen_nonces[key] = now
        return True

    def clear(self) -> None:
        """Clear all recorded nonces."""
        self._seen_nonces.clear()
