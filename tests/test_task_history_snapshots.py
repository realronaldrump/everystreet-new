from __future__ import annotations

from types import SimpleNamespace
import pytest

from tasks import config


class _SortField:
    def __neg__(self) -> str:
        return "descending-timestamp"


class _TaskIDField:
    def __eq__(self, task_id: object) -> str:  # type: ignore[override]
        return str(task_id)


class _HistoryQuery:
    def __init__(self, history: SimpleNamespace | None) -> None:
        self.history = history
        self.limit_value: int | None = None
        self.sort_value: str | None = None

    def sort(self, value: str) -> _HistoryQuery:
        self.sort_value = value
        return self

    def limit(self, value: int) -> _HistoryQuery:
        self.limit_value = value
        return self

    async def to_list(self) -> list[SimpleNamespace]:
        return [self.history] if self.history else []


@pytest.mark.asyncio
async def test_get_latest_task_history_limits_each_task_to_one_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queries: dict[str, _HistoryQuery] = {}
    histories = {
        "first": SimpleNamespace(task_id="first", status="COMPLETED"),
        "second": SimpleNamespace(task_id="second", status="RUNNING"),
    }

    class FakeTaskHistory:
        task_id = _TaskIDField()
        timestamp = _SortField()

        @classmethod
        def find(_cls, task_id: str) -> _HistoryQuery:
            query = _HistoryQuery(histories[task_id])
            queries[task_id] = query
            return query

    monkeypatch.setattr(config, "TaskHistory", FakeTaskHistory)

    latest = await config.get_latest_task_history(["first", "second", "first"])

    assert set(latest) == {"first", "second"}
    assert all(query.limit_value == 1 for query in queries.values())
    assert all(query.sort_value == "descending-timestamp" for query in queries.values())
