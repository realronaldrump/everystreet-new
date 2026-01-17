import asyncio

import pytest

from core.http.retry import retry_async


@pytest.mark.asyncio
async def test_retry_async_retries_until_success() -> None:
    attempts = 0

    @retry_async(max_retries=2, retry_delay=0)
    async def flaky():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise asyncio.TimeoutError()
        return "ok"

    result = await flaky()
    assert result == "ok"
    assert attempts == 3


@pytest.mark.asyncio
async def test_retry_async_raises_after_exhaustion() -> None:
    attempts = 0

    @retry_async(max_retries=1, retry_delay=0)
    async def always_fail():
        nonlocal attempts
        attempts += 1
        raise asyncio.TimeoutError()

    with pytest.raises(asyncio.TimeoutError):
        await always_fail()

    assert attempts == 2
