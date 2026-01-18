from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import pytest

from core.http.blocklist import DEFAULT_FORBIDDEN_HOSTS, is_forbidden_host


def _is_blocked_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    return is_forbidden_host(url, DEFAULT_FORBIDDEN_HOSTS)


def install_network_blocker(monkeypatch: pytest.MonkeyPatch) -> None:
    import aiohttp
    import httpx
    import requests

    def _requests_block(url: str, *args: Any, **kwargs: Any) -> Any:
        if _is_blocked_url(url):
            raise RuntimeError(f"Blocked external host: {url}")
        return _orig_requests_get(url, *args, **kwargs)

    async def _httpx_block(self, url: str, *args: Any, **kwargs: Any) -> Any:
        if _is_blocked_url(str(url)):
            raise RuntimeError(f"Blocked external host: {url}")
        return await _orig_httpx_request(self, url, *args, **kwargs)

    def _aiohttp_block(self, url: str, *args: Any, **kwargs: Any) -> Any:
        if _is_blocked_url(str(url)):
            raise RuntimeError(f"Blocked external host: {url}")
        return _orig_aiohttp_request(self, url, *args, **kwargs)

    _orig_requests_get = requests.get
    monkeypatch.setattr(requests, "get", _requests_block, raising=True)

    _orig_httpx_request = httpx.AsyncClient.request
    monkeypatch.setattr(httpx.AsyncClient, "request", _httpx_block, raising=True)

    _orig_aiohttp_request = aiohttp.ClientSession._request
    monkeypatch.setattr(aiohttp.ClientSession, "_request", _aiohttp_block, raising=True)
