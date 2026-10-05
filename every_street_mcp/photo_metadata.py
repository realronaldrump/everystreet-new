"""Read capture times from original photo files without retaining the images."""

from __future__ import annotations

import asyncio
import io
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import aiohttp
import exifread
from pydantic import BaseModel, ConfigDict

from core.http.session import get_session

MAX_PHOTO_BYTES = 20 * 1024 * 1024
MAX_PHOTOS = 6


class FuelPhoto(BaseModel):
    """OpenAI file-parameter contract; URLs never appear in tool results."""

    model_config = ConfigDict(extra="forbid")

    download_url: str
    file_id: str
    mime_type: str = ""
    file_name: str = ""


def validate_photo_url(url: str) -> None:
    parsed = urlsplit(url)
    hostname = (parsed.hostname or "").lower()
    trusted = hostname == "oaiusercontent.com" or hostname.endswith(
        ".oaiusercontent.com"
    )
    # Older ChatGPT file URLs use OpenAI's Azure storage accounts.
    trusted = trusted or bool(
        re.fullmatch(r"(?:openai|oai)[a-z0-9-]*\.blob\.core\.windows\.net", hostname)
    )
    if (
        parsed.scheme != "https"
        or not trusted
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
    ):
        raise ValueError(
            "Photo metadata requires an original ChatGPT attachment download URL"
        )


def capture_metadata(data: bytes) -> dict[str, Any]:
    tags = exifread.process_file(
        io.BytesIO(data), details=False, extract_thumbnail=False
    )
    original = str(tags.get("EXIF DateTimeOriginal") or "").strip()
    if not original:
        return {
            "status": "no_capture_time",
            "capture_time": None,
            "note": "Original capture metadata is absent. Use a visible receipt timestamp or ask the owner.",
        }
    # Keep a timezone-less local camera time as such, rather than interpreting it as UTC.
    iso_date = re.sub(r"^(\d{4}):(\d{2}):(\d{2}) ", r"\1-\2-\3T", original)
    datetime.fromisoformat(iso_date)
    offset = str(tags.get("EXIF OffsetTimeOriginal") or "").strip()
    if offset and not re.fullmatch(r"[+-]\d{2}:\d{2}", offset):
        offset = ""
    capture_time = datetime.fromisoformat(iso_date + offset)
    return {
        "status": "ok",
        "capture_time": capture_time.isoformat(),
        "capture_time_utc": capture_time.astimezone(UTC).isoformat()
        if offset
        else None,
        "timezone_known": bool(offset),
        "source": "EXIF DateTimeOriginal",
        "note": None
        if offset
        else "Camera local time has no UTC offset; resolve the timezone before logging.",
    }


async def _download_photo(photo: FuelPhoto) -> bytes:
    validate_photo_url(photo.download_url)
    if photo.mime_type and not photo.mime_type.startswith("image/"):
        raise ValueError("Only image attachments are supported")
    session = await get_session()
    async with session.get(
        photo.download_url,
        allow_redirects=False,
        timeout=aiohttp.ClientTimeout(total=20),
        headers={"Accept": "image/*", "Accept-Encoding": "identity"},
    ) as response:
        if response.status != 200:
            raise ValueError("Original photo download is unavailable or expired")
        if response.content_length and response.content_length > MAX_PHOTO_BYTES:
            raise ValueError("Original photo exceeds the 20 MiB metadata limit")
        data = bytearray()
        async for chunk in response.content.iter_chunked(64 * 1024):
            data.extend(chunk)
            if len(data) > MAX_PHOTO_BYTES:
                raise ValueError("Original photo exceeds the 20 MiB metadata limit")
    return bytes(data)


async def inspect_photo(photo: FuelPhoto) -> dict[str, Any]:
    result: dict[str, Any] = {"file_id": photo.file_id}
    try:
        data = await _download_photo(photo)
        result.update(await asyncio.to_thread(capture_metadata, data))
    except Exception:
        # Do not leak signed file URLs or unrelated EXIF (GPS, serial numbers, etc.).
        result.update(
            {
                "status": "unavailable",
                "capture_time": None,
                "note": "Original capture metadata could not be read. Use a visible receipt timestamp or ask the owner.",
            }
        )
    return result


async def inspect_photos(photos: list[FuelPhoto]) -> dict[str, Any]:
    if not 1 <= len(photos) <= MAX_PHOTOS:
        raise ValueError("Supply between one and six original fill-up photos")
    semaphore = asyncio.Semaphore(3)

    async def inspect_limited(photo: FuelPhoto) -> dict[str, Any]:
        async with semaphore:
            return await inspect_photo(photo)

    results = await asyncio.gather(*(inspect_limited(photo) for photo in photos))
    return {
        "photos": results,
        "images_retained": False,
        "instructions": "Read pump and odometer numbers visually in the conversation. Do not use file upload or modification time as capture time.",
    }
