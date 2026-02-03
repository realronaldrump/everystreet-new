import asyncio

import pytest

from map_data import builders


@pytest.mark.asyncio
async def test_safe_readline_handles_overlong_line() -> None:
    reader = asyncio.StreamReader(limit=32)
    reader.feed_data(b"x" * 64 + b"\n")
    reader.feed_eof()

    result = await builders._safe_readline(
        reader,
        wait_timeout=0.1,
        label="test",
    )

    assert result == builders._OUTPUT_LINE_OVERFLOW_BYTES


@pytest.mark.asyncio
async def test_safe_readline_returns_normal_line() -> None:
    reader = asyncio.StreamReader(limit=32)
    reader.feed_data(b"hello\\n")
    reader.feed_eof()

    result = await builders._safe_readline(
        reader,
        wait_timeout=0.1,
        label="test",
    )

    assert result == b"hello\\n"
