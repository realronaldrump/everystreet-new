from datetime import UTC, datetime

from google_photos.services.client import normalize_picker_media_item


def test_normalize_picker_media_item_accepts_serialized_shape() -> None:
    item = {
        "id": "media-1",
        "mime_type": "image/jpeg",
        "file_name": "trip.jpg",
        "capture_time": "2025-01-01T12:34:56Z",
        "lat": 33.76,
        "lon": -84.39,
        "base_url": "https://lh3.googleusercontent.com/example",
    }

    normalized = normalize_picker_media_item(item)

    assert normalized["id"] == "media-1"
    assert normalized["mime_type"] == "image/jpeg"
    assert normalized["file_name"] == "trip.jpg"
    assert normalized["capture_time"] == datetime(2025, 1, 1, 12, 34, 56, tzinfo=UTC)
    assert normalized["lat"] == 33.76
    assert normalized["lon"] == -84.39
    assert normalized["base_url"] == "https://lh3.googleusercontent.com/example"
