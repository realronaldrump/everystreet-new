"""Reusable streaming utilities for SSE and GeoJSON endpoints."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any

from starlette.responses import StreamingResponse


def format_sse_event(
    data: Any,
    *,
    event: str | None = None,
) -> str:
    """Format a single SSE frame."""
    payload = json.dumps(data, default=str)
    if event:
        return f"event: {event}\ndata: {payload}\n\n"
    return f"data: {payload}\n\n"


def format_sse_comment(comment: str = "keepalive") -> str:
    """Format an SSE comment frame."""
    return f": {comment}\n\n"


async def sse_event_stream(
    fetch_fn: Callable[[], Awaitable[dict[str, Any] | None]],
    *,
    is_terminal: Callable[[dict[str, Any]], bool] | None = None,
    serialize_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    event_name_fn: Callable[[dict[str, Any]], str | None] | None = None,
    poll_interval: float = 1.0,
    max_polls: int = 3600,
    keepalive_every: int = 15,
    deduplicate: bool = True,
) -> AsyncGenerator[str]:
    """
    Generic SSE poll-and-stream generator.

    Args:
        fetch_fn: Async callable returning current state dict (or None to skip).
        is_terminal: Predicate returning True when streaming should end.
            Defaults to checking status in {"completed","failed","cancelled","error"}.
        serialize_fn: Optional transform applied to fetch result before JSON encoding.
        poll_interval: Seconds between polls.
        max_polls: Maximum number of poll iterations.
        keepalive_every: Send keepalive comment every N polls with no changes.
        deduplicate: If True, only emit when payload changes from last emission.
    """

    def default_is_terminal(state: dict[str, Any]) -> bool:
        return state.get("status") in {
            "completed",
            "failed",
            "cancelled",
            "error",
        }

    if is_terminal is None:
        is_terminal = default_is_terminal

    last_payload_json = None
    poll_count = 0

    while poll_count < max_polls:
        poll_count += 1
        try:
            state = await fetch_fn()
        except Exception:
            await asyncio.sleep(poll_interval)
            continue

        if state is None:
            if poll_count % keepalive_every == 0:
                yield format_sse_comment()
            await asyncio.sleep(poll_interval)
            continue

        data = serialize_fn(state) if serialize_fn else state
        payload_json = json.dumps(data, default=str)
        event_name = event_name_fn(state) if event_name_fn else None

        if not deduplicate or payload_json != last_payload_json:
            yield format_sse_event(data, event=event_name)
            last_payload_json = payload_json
        elif poll_count % keepalive_every == 0:
            yield format_sse_comment()

        if is_terminal(state):
            return

        await asyncio.sleep(poll_interval)


async def sse_queue_stream(
    get_event_fn: Callable[[], Awaitable[dict[str, Any] | None]],
    *,
    event_name_key: str = "_type",
    default_event_name: str = "progress",
    timeout_s: float = 15.0,
    keepalive_event_name: str = "heartbeat",
    keepalive_payload_fn: Callable[[], dict[str, Any]] | None = None,
    max_duration_s: float | None = None,
    is_terminal_event: Callable[[str, dict[str, Any]], bool] | None = None,
) -> AsyncGenerator[str]:
    """Stream SSE messages from a queue-like source with keepalives."""

    def _default_keepalive_payload() -> dict[str, Any]:
        return {"ts": time.time()}

    started_at = time.monotonic()
    keepalive_payload_fn = keepalive_payload_fn or _default_keepalive_payload

    while True:
        if (
            max_duration_s is not None
            and (time.monotonic() - started_at) > max_duration_s
        ):
            yield format_sse_event({"message": "Stream timeout"}, event="timeout")
            return

        try:
            event = await asyncio.wait_for(get_event_fn(), timeout=timeout_s)
        except TimeoutError:
            yield format_sse_event(
                keepalive_payload_fn(),
                event=keepalive_event_name,
            )
            continue

        if event is None:
            continue

        payload = dict(event)
        event_name = payload.pop(event_name_key, default_event_name)
        yield format_sse_event(payload, event=event_name)

        if is_terminal_event and is_terminal_event(event_name, payload):
            return


def sse_response(
    generator: AsyncGenerator[str], **extra_headers: str
) -> StreamingResponse:
    """Wrap an SSE async generator in a StreamingResponse with standard headers."""
    headers = {"Cache-Control": "no-cache", "Connection": "keep-alive"}
    headers.update(extra_headers)
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers=headers,
    )


async def stream_geojson_feature_collection(
    cursor: Any,
    transform_fn: Callable[[Any], dict[str, Any] | None],
) -> AsyncGenerator[str]:
    """
    Stream a GeoJSON FeatureCollection from an async cursor.

    Args:
        cursor: Async iterable of documents.
        transform_fn: Converts each document to a GeoJSON Feature dict,
            or returns None to skip the document. Exceptions in transform_fn
            are caught and the document is skipped.
    """
    yield '{"type":"FeatureCollection","features":['
    first = True
    try:
        async for doc in cursor:
            try:
                feature = transform_fn(doc)
            except Exception:
                continue
            if feature is None:
                continue
            if not first:
                yield ","
            yield json.dumps(feature, separators=(",", ":"), default=str)
            first = False
    finally:
        yield "]}"


def geojson_response(generator: AsyncGenerator[str]) -> StreamingResponse:
    """Wrap a GeoJSON async generator in a StreamingResponse."""
    return StreamingResponse(generator, media_type="application/geo+json")
