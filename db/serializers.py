"""Serialization utilities for MongoDB documents.

Provides functions for converting MongoDB documents and types to
JSON-serializable formats.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from bson import ObjectId

from date_utils import parse_timestamp


def serialize_datetime(dt: datetime | str | None) -> str | None:
    """Serialize a datetime to ISO format string.

    Handles datetime objects, ISO format strings, and None values.
    Converts +00:00 timezone suffix to Z for consistency.

    Args:
        dt: datetime object, ISO string, or None.

    Returns:
        ISO format string with Z suffix, or None.
    """
    if dt is None:
        return None
    if isinstance(dt, (str, datetime)):
        dt = parse_timestamp(dt)
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def serialize_for_json(data: Any) -> Any:
    """Recursively serialize MongoDB types for JSON compatibility.

    Converts ObjectId to string and datetime to ISO format.
    Handles nested dicts and lists.

    Args:
        data: Data to serialize (dict, list, ObjectId, datetime, or any).

    Returns:
        JSON-serializable version of the data.
    """
    if isinstance(data, dict):
        return {k: serialize_for_json(v) for k, v in data.items()}
    if isinstance(data, list):
        return [serialize_for_json(item) for item in data]
    if isinstance(data, ObjectId):
        return str(data)
    if isinstance(data, datetime):
        return data.isoformat()
    return data


def serialize_document(doc: dict[str, Any]) -> dict[str, Any]:
    """Serialize a MongoDB document for JSON response.

    Convenience wrapper around serialize_for_json for single documents.

    Args:
        doc: MongoDB document to serialize.

    Returns:
        JSON-serializable document, or empty dict if doc is falsy.
    """
    if not doc:
        return {}
    return serialize_for_json(doc)


def json_dumps(data: Any, **kwargs: Any) -> str:
    """Serialize data to JSON string with MongoDB type handling.

    This is the canonical way to serialize MongoDB documents to JSON strings.
    Handles ObjectId, datetime, and nested structures automatically.

    Args:
        data: Data to serialize (dict, list, or any JSON-serializable type).
        **kwargs: Additional arguments passed to json.dumps (e.g., separators, indent).

    Returns:
        JSON string.

    Example:
        >>> doc = {"_id": ObjectId(), "created": datetime.now()}
        >>> json_str = json_dumps(doc)
        >>> json_str = json_dumps(doc, indent=2)
    """
    return json.dumps(serialize_for_json(data), **kwargs)
