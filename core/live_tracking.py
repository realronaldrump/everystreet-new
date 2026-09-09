"""Application-wide Bouncie live tracking policy, independent of history sync."""

from core.service_config import get_service_config

DISABLED_MESSAGE = "Bouncie live tracking is disabled."


async def is_enabled() -> bool:
    """Read the persisted switch; missing or unavailable settings mean off.

    Read through the existing settings cache so all web processes converge within
    its 30-second TTL without requiring a deployment or a restart.
    """
    try:
        settings = await get_service_config()
    except Exception:
        return False
    return getattr(settings, "bouncieLiveTrackingEnabled", False) is True
