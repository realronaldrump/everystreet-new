"""Google Photos HTTP client helpers."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import aiohttp

from core.date_utils import parse_timestamp

logger = logging.getLogger(__name__)

GOOGLE_PHOTOS_PICKER_API_BASE = "https://photospicker.googleapis.com/v1"
GOOGLE_PHOTOS_LIBRARY_API_BASE = "https://photoslibrary.googleapis.com/v1"


@dataclass
class GooglePhotosApiError(Exception):
    """Represents a non-success Google Photos API response."""

    message: str
    status: int | None = None


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def _parse_api_error(status: int, body_text: str) -> GooglePhotosApiError:
    detail = body_text.strip() or f"Google Photos API request failed ({status})"
    return GooglePhotosApiError(detail, status=status)


def _as_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_picker_media_item(media_item: dict[str, Any]) -> dict[str, Any]:
    """Normalize a picker media item payload to a stable app shape."""
    metadata = media_item.get("mediaMetadata") or {}
    creation_time = metadata.get("creationTime") or media_item.get("creationTime")
    location = metadata.get("location") or media_item.get("location") or {}
    width = metadata.get("width") or media_item.get("width")
    height = metadata.get("height") or media_item.get("height")

    return {
        "id": media_item.get("id"),
        "mime_type": media_item.get("mimeType"),
        "file_name": media_item.get("filename"),
        "capture_time": parse_timestamp(creation_time),
        "lat": _as_float(location.get("latitude")),
        "lon": _as_float(location.get("longitude")),
        "width": int(width) if str(width).isdigit() else None,
        "height": int(height) if str(height).isdigit() else None,
        "base_url": media_item.get("baseUrl"),
    }


class GooglePhotosClient:
    """Thin async client for Google Photos Picker and Library APIs."""

    @staticmethod
    async def create_picker_session(
        session: aiohttp.ClientSession,
        access_token: str,
    ) -> dict[str, Any]:
        url = f"{GOOGLE_PHOTOS_PICKER_API_BASE}/sessions"
        async with session.post(
            url,
            json={},
            headers={
                **_auth_headers(access_token),
                "Content-Type": "application/json",
            },
        ) as response:
            if response.status >= 400:
                raise _parse_api_error(response.status, await response.text())
            return await response.json()

    @staticmethod
    async def get_picker_session(
        session: aiohttp.ClientSession,
        access_token: str,
        session_id: str,
    ) -> dict[str, Any]:
        url = f"{GOOGLE_PHOTOS_PICKER_API_BASE}/sessions/{session_id}"
        async with session.get(url, headers=_auth_headers(access_token)) as response:
            if response.status >= 400:
                raise _parse_api_error(response.status, await response.text())
            return await response.json()

    @staticmethod
    async def list_picker_media_items(
        session: aiohttp.ClientSession,
        access_token: str,
        session_id: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, str | int] = {"pageSize": max(1, min(page_size, 100))}
        if page_token:
            params["pageToken"] = page_token
        url = f"{GOOGLE_PHOTOS_PICKER_API_BASE}/sessions/{session_id}/mediaItems"
        async with session.get(
            url,
            params=params,
            headers=_auth_headers(access_token),
        ) as response:
            if response.status >= 400:
                raise _parse_api_error(response.status, await response.text())
            return await response.json()

    @staticmethod
    async def delete_picker_session(
        session: aiohttp.ClientSession,
        access_token: str,
        session_id: str,
    ) -> None:
        url = f"{GOOGLE_PHOTOS_PICKER_API_BASE}/sessions/{session_id}"
        async with session.delete(url, headers=_auth_headers(access_token)) as response:
            if response.status >= 400 and response.status != 404:
                raise _parse_api_error(response.status, await response.text())

    @staticmethod
    async def download_thumbnail(
        session: aiohttp.ClientSession,
        base_url: str,
        *,
        width: int = 640,
        height: int = 640,
    ) -> bytes:
        suffix = f"=w{max(16, width)}-h{max(16, height)}"
        target_url = f"{base_url}{suffix}"
        async with session.get(target_url) as response:
            if response.status >= 400:
                raise _parse_api_error(response.status, await response.text())
            return await response.read()

    @staticmethod
    async def upload_bytes(
        session: aiohttp.ClientSession,
        access_token: str,
        *,
        file_name: str,
        content_type: str,
        payload: bytes,
    ) -> str:
        url = f"{GOOGLE_PHOTOS_LIBRARY_API_BASE}/uploads"
        headers = {
            **_auth_headers(access_token),
            "Content-Type": "application/octet-stream",
            "X-Goog-Upload-Content-Type": content_type,
            "X-Goog-Upload-File-Name": file_name,
            "X-Goog-Upload-Protocol": "raw",
        }
        async with session.post(url, data=payload, headers=headers) as response:
            body = await response.text()
            if response.status >= 400:
                raise _parse_api_error(response.status, body)
            upload_token = body.strip()
            if not upload_token:
                raise GooglePhotosApiError("Upload token missing in upload response")
            return upload_token

    @staticmethod
    async def create_album(
        session: aiohttp.ClientSession,
        access_token: str,
        *,
        title: str,
    ) -> dict[str, Any]:
        url = f"{GOOGLE_PHOTOS_LIBRARY_API_BASE}/albums"
        payload = {"album": {"title": title}}
        async with session.post(
            url,
            json=payload,
            headers={
                **_auth_headers(access_token),
                "Content-Type": "application/json",
            },
        ) as response:
            if response.status >= 400:
                raise _parse_api_error(response.status, await response.text())
            return await response.json()

    @staticmethod
    async def batch_create_media_item(
        session: aiohttp.ClientSession,
        access_token: str,
        *,
        upload_token: str,
        file_name: str,
        description: str | None = None,
        album_id: str | None = None,
    ) -> dict[str, Any]:
        url = f"{GOOGLE_PHOTOS_LIBRARY_API_BASE}/mediaItems:batchCreate"
        body: dict[str, Any] = {
            "newMediaItems": [
                {
                    "description": description or "",
                    "simpleMediaItem": {
                        "uploadToken": upload_token,
                        "fileName": file_name,
                    },
                },
            ],
        }
        if album_id:
            body["albumId"] = album_id

        async with session.post(
            url,
            json=body,
            headers={
                **_auth_headers(access_token),
                "Content-Type": "application/json",
            },
        ) as response:
            if response.status >= 400:
                raise _parse_api_error(response.status, await response.text())
            return await response.json()


__all__ = [
    "GOOGLE_PHOTOS_LIBRARY_API_BASE",
    "GOOGLE_PHOTOS_PICKER_API_BASE",
    "GooglePhotosApiError",
    "GooglePhotosClient",
    "normalize_picker_media_item",
]

