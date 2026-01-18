"""Host allow/block utilities for HTTP clients."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import urlparse

DEFAULT_FORBIDDEN_HOSTS = {
    "overpass-api.de",
    "overpass-api",
    "overpass.kumi.systems",
    "nominatim.openstreetmap.org",
    "api.mapbox.com",
    "events.mapbox.com",
}


@dataclass(frozen=True)
class BlockedHost:
    host: str


def is_forbidden_host(
    url: str, forbidden_hosts: Iterable[str] = DEFAULT_FORBIDDEN_HOSTS
) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    forbidden = {item.lower() for item in forbidden_hosts}
    if host in forbidden:
        return True
    return any(host.endswith(f".{item}") for item in forbidden)
