from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from core.http.blocklist import DEFAULT_FORBIDDEN_HOSTS, is_forbidden_host

if TYPE_CHECKING:
    import pytest


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
            msg = f"Blocked external host: {url}"
            raise RuntimeError(msg)
        return _orig_requests_get(url, *args, **kwargs)

    async def _httpx_block(
        self,
        method: str,
        url: str,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        if _is_blocked_url(str(url)):
            msg = f"Blocked external host: {url}"
            raise RuntimeError(msg)
        return await _orig_httpx_request(self, method, url, *args, **kwargs)

    def _aiohttp_block(self, method: str, url: str, *args: Any, **kwargs: Any) -> Any:
        if _is_blocked_url(str(url)):
            msg = f"Blocked external host: {url}"
            raise RuntimeError(msg)
        return _orig_aiohttp_request(self, method, url, *args, **kwargs)

    _orig_requests_get = requests.get
    _orig_requests_post = requests.post
    monkeypatch.setattr(requests, "get", _requests_block, raising=True)

    def _requests_post_block(url: str, *args: Any, **kwargs: Any) -> Any:
        if _is_blocked_url(url):
            msg = f"Blocked external host: {url}"
            raise RuntimeError(msg)
        return _orig_requests_post(url, *args, **kwargs)

    monkeypatch.setattr(requests, "post", _requests_post_block, raising=True)

    _orig_httpx_request = httpx.AsyncClient.request
    monkeypatch.setattr(httpx.AsyncClient, "request", _httpx_block, raising=True)

    _orig_httpx_sync_request = httpx.Client.request

    def _httpx_sync_block(
        self,
        method: str,
        url: str,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        if _is_blocked_url(str(url)):
            msg = f"Blocked external host: {url}"
            raise RuntimeError(msg)
        return _orig_httpx_sync_request(self, method, url, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", _httpx_sync_block, raising=True)

    _orig_aiohttp_request = aiohttp.ClientSession._request
    monkeypatch.setattr(aiohttp.ClientSession, "_request", _aiohttp_block, raising=True)
