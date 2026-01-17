import pytest

from core.http.session import cleanup_session, get_session


@pytest.mark.asyncio
async def test_session_reuse_and_cleanup() -> None:
    session_a = await get_session()
    session_b = await get_session()

    assert session_a is session_b

    await cleanup_session()
    assert session_a.closed

    session_c = await get_session()
    assert session_c is not session_a

    await cleanup_session()
