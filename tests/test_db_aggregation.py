import pytest

from db.aggregation import aggregate_to_list


class FakeCursor:
    def __init__(self, data: list[dict[str, int]]) -> None:
        self._data = data

    async def to_list(self, length: int | None = None) -> list[dict[str, int]]:
        if length is None:
            return list(self._data)
        return list(self._data)[:length]


class FakeCollection:
    def __init__(self, cursor: FakeCursor, *, awaitable: bool) -> None:
        self._cursor = cursor
        self._awaitable = awaitable

    def aggregate(self, pipeline, **kwargs):
        if self._awaitable:
            return _return_async(self._cursor)
        return self._cursor


class FakeModel:
    def __init__(self, collection: FakeCollection) -> None:
        self._collection = collection

    def get_pymongo_collection(self) -> FakeCollection:
        return self._collection


async def _return_async(value):
    return value


@pytest.mark.asyncio
async def test_aggregate_to_list_handles_sync_cursor() -> None:
    cursor = FakeCursor([{"a": 1}, {"a": 2}])
    model = FakeModel(FakeCollection(cursor, awaitable=False))

    result = await aggregate_to_list(model, [])
    assert result == [{"a": 1}, {"a": 2}]


@pytest.mark.asyncio
async def test_aggregate_to_list_handles_async_cursor() -> None:
    cursor = FakeCursor([{"a": 1}, {"a": 2}, {"a": 3}])
    model = FakeModel(FakeCollection(cursor, awaitable=True))

    result = await aggregate_to_list(model, [], length=2)
    assert result == [{"a": 1}, {"a": 2}]
