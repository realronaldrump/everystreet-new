from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Self

import aiohttp
from yarl import URL

if TYPE_CHECKING:
    from types import TracebackType


@dataclass
class FakeResponse:
    status: int = 200
    json_data: Any = None
    text_data: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    method: str = "GET"
    url: str = "http://test"

    def __post_init__(self) -> None:
        self.request_info = aiohttp.RequestInfo(
            url=URL(self.url),
            method=self.method,
            headers={},
            real_url=URL(self.url),
        )
        self.history = ()

    async def json(self) -> Any:
        return self.json_data

    async def text(self) -> str:
        return self.text_data

    def raise_for_status(self) -> None:
        if self.status >= 400:
            raise aiohttp.ClientResponseError(
                request_info=self.request_info,
                history=self.history,
                status=self.status,
                message=self.text_data or "error",
            )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        return False


class FakeSession:
    def __init__(
        self,
        *,
        get_responses: list[FakeResponse | Exception] | None = None,
        post_responses: list[FakeResponse | Exception] | None = None,
    ) -> None:
        self._get_responses = list(get_responses or [])
        self._post_responses = list(post_responses or [])
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def get(self, url: str, **kwargs: Any) -> FakeResponse:
        self.requests.append(("GET", url, kwargs))
        return self._next(self._get_responses)

    def post(self, url: str, **kwargs: Any) -> FakeResponse:
        self.requests.append(("POST", url, kwargs))
        return self._next(self._post_responses)

    @staticmethod
    def _next(queue: list[FakeResponse | Exception]) -> FakeResponse:
        if not queue:
            msg = "No fake responses available"
            raise AssertionError(msg)
        response = queue.pop(0)
        if isinstance(response, Exception):
            raise response
        return response
