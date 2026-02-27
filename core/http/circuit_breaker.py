"""
Lightweight async circuit breaker for external service calls.

Prevents hammering a service that is known to be down by tracking
recent failures and short-circuiting calls while the breaker is open.
"""

from __future__ import annotations

import functools
import logging
import time

logger = logging.getLogger(__name__)


class CircuitOpen(Exception):
    """Raised when a call is rejected because the circuit is open."""

    def __init__(self, service: str, resets_in: float) -> None:
        super().__init__(
            f"Circuit breaker open for {service} (resets in {resets_in:.0f}s)"
        )
        self.service = service
        self.resets_in = resets_in


class CircuitBreaker:
    """
    Three-state circuit breaker: closed → open → half-open → closed.

    Parameters
    ----------
    service : str
        Human-readable name (for logging / error messages).
    failure_threshold : int
        Consecutive failures before the circuit opens (default 5).
    recovery_timeout : float
        Seconds to wait before allowing a test request (default 60).
    """

    def __init__(
        self,
        service: str,
        *,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
    ) -> None:
        self.service = service
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout

        self._failures = 0
        self._opened_at: float | None = None
        self._state = "closed"  # closed | open | half-open

    @property
    def state(self) -> str:
        if self._state == "open" and self._opened_at is not None:
            if time.monotonic() - self._opened_at >= self.recovery_timeout:
                self._state = "half-open"
        return self._state

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None
        if self._state != "closed":
            logger.info("Circuit breaker CLOSED for %s", self.service)
        self._state = "closed"

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.failure_threshold and self._state == "closed":
            self._state = "open"
            self._opened_at = time.monotonic()
            logger.warning(
                "Circuit breaker OPEN for %s after %d failures",
                self.service,
                self._failures,
            )
        elif self._state == "half-open":
            self._state = "open"
            self._opened_at = time.monotonic()
            logger.warning(
                "Circuit breaker re-OPEN for %s (half-open probe failed)",
                self.service,
            )

    def check(self) -> None:
        """Raise :class:`CircuitOpen` if the circuit is open."""
        state = self.state
        if state == "open":
            resets_in = self.recovery_timeout - (
                time.monotonic() - (self._opened_at or 0)
            )
            raise CircuitOpen(self.service, max(0, resets_in))
        # half-open: allow the request through as a probe


# ---------------------------------------------------------------------------
# Singleton breakers for the two self-hosted services
# ---------------------------------------------------------------------------

valhalla_breaker = CircuitBreaker("Valhalla", failure_threshold=5, recovery_timeout=60)
nominatim_breaker = CircuitBreaker(
    "Nominatim", failure_threshold=5, recovery_timeout=60
)


def with_circuit_breaker(breaker: CircuitBreaker):
    """Decorator that wraps an async function with circuit breaker protection."""

    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            breaker.check()
            try:
                result = await fn(*args, **kwargs)
            except CircuitOpen:
                raise
            except Exception:
                breaker.record_failure()
                raise
            else:
                breaker.record_success()
                return result

        return wrapper

    return decorator
