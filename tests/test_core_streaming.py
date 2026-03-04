import asyncio
import json

import pytest

from core.streaming import (
    format_sse_comment,
    format_sse_event,
    sse_event_stream,
    sse_queue_stream,
    stream_geojson_feature_collection,
)


class _AsyncCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def __aiter__(self):
        self._iter = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


@pytest.mark.asyncio
async def test_sse_event_stream_emits_named_events_and_stops_on_terminal() -> None:
    states = [
        {"status": "running", "progress": 10},
        {"status": "completed", "progress": 100},
    ]

    async def fetch_fn():
        if states:
            return states.pop(0)
        return None

    frames = [
        frame
        async for frame in sse_event_stream(
            fetch_fn,
            event_name_fn=lambda state: (
                "done" if state["status"] == "completed" else "progress"
            ),
            poll_interval=0,
            max_polls=10,
            keepalive_every=10,
        )
    ]

    assert frames == [
        format_sse_event({"status": "running", "progress": 10}, event="progress"),
        format_sse_event({"status": "completed", "progress": 100}, event="done"),
    ]


@pytest.mark.asyncio
async def test_sse_event_stream_emits_keepalive_for_missing_state() -> None:
    states = [None, None, {"status": "completed"}]

    async def fetch_fn():
        if states:
            return states.pop(0)
        return None

    frames = [
        frame
        async for frame in sse_event_stream(
            fetch_fn,
            poll_interval=0,
            max_polls=10,
            keepalive_every=1,
            deduplicate=False,
        )
    ]

    assert frames[0] == format_sse_comment()
    assert frames[1] == format_sse_comment()
    assert frames[2] == format_sse_event({"status": "completed"})


@pytest.mark.asyncio
async def test_sse_queue_stream_emits_heartbeat_then_terminal_event() -> None:
    calls = 0

    async def get_event():
        nonlocal calls
        calls += 1
        if calls == 1:
            await asyncio.sleep(0.01)
            return None
        return {"_type": "done", "status": "completed"}

    frames = [
        frame
        async for frame in sse_queue_stream(
            get_event,
            timeout_s=0.001,
            keepalive_event_name="heartbeat",
            is_terminal_event=lambda event, payload: event == "done"
            and payload.get("status") == "completed",
        )
    ]

    assert frames[0].startswith("event: heartbeat\n")
    assert frames[1] == format_sse_event({"status": "completed"}, event="done")


@pytest.mark.asyncio
async def test_stream_geojson_feature_collection_skips_none_and_transform_errors() -> (
    None
):
    docs = [
        {"id": 1, "ok": True},
        {"id": 2, "ok": False},
        {"id": 3, "raise": True},
        {"id": 4, "ok": True},
    ]

    def transform(doc):
        if doc.get("raise"):
            raise ValueError("bad doc")
        if not doc.get("ok"):
            return None
        return {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [doc["id"], doc["id"]]},
            "properties": {"id": doc["id"]},
        }

    chunks = [
        chunk
        async for chunk in stream_geojson_feature_collection(
            _AsyncCursor(docs),
            transform,
        )
    ]
    payload = json.loads("".join(chunks))

    assert payload["type"] == "FeatureCollection"
    assert [f["properties"]["id"] for f in payload["features"]] == [1, 4]
