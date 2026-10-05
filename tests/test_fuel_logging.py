from __future__ import annotations

import asyncio
import struct
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie
from pydantic import ValidationError

from db.models import AppSettings, GasFillup, Vehicle
from every_street_mcp.fuel import (
    FuelFillupInput,
    fuel_logging_context,
    resolve_fuel_vehicle,
    save_fuel_fillup,
)
from every_street_mcp.photo_metadata import (
    FuelPhoto,
    capture_metadata,
    inspect_photo,
    inspect_photos,
    validate_photo_url,
)


def readings(**changes) -> FuelFillupInput:
    values = {
        "fillup_time": "2026-01-02T17:28:00-06:00",
        "time_source": "receipt",
        "gallons": 10.0,
        "odometer": 1200.0,
        "total_cost": 35.0,
    }
    values.update(changes)
    return FuelFillupInput(**values)


@pytest.fixture
async def fuel_db(monkeypatch):
    database = await init_mock_beanie(
        GasFillup, Vehicle, AppSettings, database_name="fuel_logging"
    )
    await Vehicle(
        imei="nissan-device", custom_name="Marquise", make="NISSAN", model="Murano"
    ).insert()
    # Other active cars must never become the implied gas-logging target.
    await Vehicle(imei="toyota-device", custom_name="Toyota", make="TOYOTA").insert()
    await AppSettings(user_timezone="America/Chicago").insert()
    lock = asyncio.Lock()
    redis = SimpleNamespace(lock=lambda *args, **kwargs: lock)
    monkeypatch.setattr(
        "every_street_mcp.fuel.get_shared_redis", AsyncMock(return_value=redis)
    )
    monkeypatch.setattr(
        "gas.services.fillup_service.bump_trip_map_revision", AsyncMock()
    )
    return database


def test_prices_are_derived_with_decimal_rounding():
    from_price = readings(
        total_cost=None, price_per_gallon=3.599, gallons=17.781
    ).readings()
    assert from_price["total_cost"] == 63.99
    half_cent = readings(total_cost=None, price_per_gallon=3.5995).readings()
    assert half_cent["total_cost"] == 36.0
    from_total = readings(total_cost=86.58, gallons=17.781).readings()
    assert from_total["price_per_gallon"] == 4.869
    assert from_total["odometer_source"] == "manual"
    assert from_total["odometer_is_estimated"] is False


def test_display_rounding_is_allowed_but_inconsistent_readings_are_rejected():
    assert (
        readings(total_cost=86.58, price_per_gallon=4.869, gallons=17.781).readings()[
            "total_cost"
        ]
        == 86.58
    )
    with pytest.raises(ValueError, match="recheck the photos"):
        readings(price_per_gallon=4.5).readings()
    with pytest.raises(ValueError, match="total paid or price"):
        readings(total_cost=None).readings()


@pytest.mark.parametrize(
    "changes",
    [
        {"gallons": 0},
        {"gallons": -1},
        {"gallons": float("nan")},
        {"gallons": True},
        {"odometer": -1},
        {"odometer": float("inf")},
        {"total_cost": float("nan")},
        {"price_per_gallon": -1},
        {"is_full_tank": "false"},
        {"missed_previous": 1},
        {"fillup_time": "2026-01-02T17:28:00"},
        {"time_source": "upload_time"},
        {"imei": "another-car"},
    ],
)
def test_unsupported_readings_fail_before_any_write(changes):
    with pytest.raises(ValidationError):
        readings(**changes)


def test_future_times_are_not_silently_saved():
    with pytest.raises(ValueError, match="future"):
        readings(fillup_time=datetime.now(UTC) + timedelta(days=1)).readings()


def test_offset_is_normalized_and_partial_fill_is_preserved():
    result = readings(is_full_tank=False).readings()
    assert result["fillup_time"] == datetime(2026, 1, 2, 23, 28, tzinfo=UTC)
    assert result["is_full_tank"] is False
    assert result["fillup_time_source"] == "receipt"


@pytest.mark.asyncio
async def test_context_selects_marquise_and_does_not_expose_identifiers(fuel_db):
    await GasFillup(imei="toyota-device", gallons=99).insert()
    await GasFillup(
        imei="nissan-device", fillup_time=datetime(2026, 1, 1, tzinfo=UTC), gallons=10
    ).insert()
    context = await fuel_logging_context()
    assert context["vehicle"] == {
        "name": "Marquise",
        "make": "NISSAN",
        "model": "Murano",
    }
    assert context["account_timezone"] == "America/Chicago"
    assert len(context["recent_fillups"]) == 1
    assert context["recent_fillups"][0]["gallons"] == 10
    assert context["recent_fillups"][0]["fillup_time"].endswith("+00:00")
    assert "imei" not in str(context)
    assert "vin" not in context["vehicle"]


@pytest.mark.asyncio
async def test_ambiguous_marquise_is_not_replaced_with_another_car(fuel_db):
    await Vehicle(imei="another-nissan", custom_name="MARQUISE", make="Nissan").insert()
    with pytest.raises(ValueError, match="uniquely identify"):
        await resolve_fuel_vehicle()


@pytest.mark.asyncio
async def test_unknown_vehicle_does_not_default_to_first_active_car(fuel_db):
    await Vehicle.find_one({"imei": "nissan-device"}).update(
        {"$set": {"is_active": False}}
    )
    with pytest.raises(ValueError, match="uniquely identify"):
        await resolve_fuel_vehicle()


@pytest.mark.asyncio
async def test_save_uses_existing_service_and_persists_sources(fuel_db):
    await GasFillup(
        imei="nissan-device",
        fillup_time=datetime(2026, 1, 1, tzinfo=UTC),
        odometer=1000,
        odometer_source="manual",
        gallons=10,
        is_full_tank=True,
    ).insert()
    result = await save_fuel_fillup(readings())
    assert result["success"] is True
    assert result["already_logged"] is False
    assert result["fillup"]["mpg"] == 20
    saved = await GasFillup.get(result["fillup"]["id"])
    assert saved.imei == "nissan-device"
    assert saved.entry_source == "conversation"
    assert saved.fillup_time_source == "receipt"
    assert saved.odometer_source == "manual"


@pytest.mark.asyncio
async def test_retries_and_concurrent_submissions_create_only_one_fill(fuel_db):
    first, second = await asyncio.gather(
        save_fuel_fillup(readings()), save_fuel_fillup(readings())
    )
    assert first["fillup"]["id"] == second["fillup"]["id"]
    assert sorted([first["already_logged"], second["already_logged"]]) == [False, True]
    later = await save_fuel_fillup(readings(fillup_time="2026-01-02T17:33:00-06:00"))
    assert later["already_logged"] is True
    assert await GasFillup.find_all().count() == 1
    with pytest.raises(ValueError, match="different readings"):
        await save_fuel_fillup(readings(total_cost=36))
    assert await GasFillup.find_all().count() == 1


@pytest.mark.asyncio
async def test_odometer_chronology_is_checked_without_writing(fuel_db):
    await GasFillup(
        imei="nissan-device",
        fillup_time=datetime(2026, 1, 1, tzinfo=UTC),
        odometer=1300,
    ).insert()
    with pytest.raises(ValueError, match="below the preceding"):
        await save_fuel_fillup(readings())
    await GasFillup.find_all().delete()
    await GasFillup(
        imei="nissan-device",
        fillup_time=datetime(2026, 1, 3, tzinfo=UTC),
        odometer=1100,
    ).insert()
    with pytest.raises(ValueError, match="above a later"):
        await save_fuel_fillup(readings())
    assert await GasFillup.find_all().count() == 1


@pytest.mark.asyncio
async def test_missed_fills_and_partial_tanks_do_not_get_misleading_mpg(fuel_db):
    await GasFillup(
        imei="nissan-device",
        fillup_time=datetime(2026, 1, 1, tzinfo=UTC),
        odometer=100,
        odometer_source="manual",
        gallons=10,
        is_full_tank=True,
    ).insert()
    with pytest.raises(ValueError, match="intervening fills"):
        await save_fuel_fillup(readings())
    result = await save_fuel_fillup(readings(missed_previous=True))
    assert result["fillup"]["mpg"] is None
    await GasFillup.find_all().delete()
    partial = await save_fuel_fillup(readings(is_full_tank=False))
    assert partial["fillup"]["is_full_tank"] is False
    assert partial["fillup"]["mpg"] is None


def original_exif(offset="-05:00") -> bytes:
    fields = [(0x9003, b"2026:05:31 17:28:00\0")]
    if offset:
        fields.append((0x9011, offset.encode() + b"\0"))
    exif_offset = 26
    data_offset = exif_offset + 2 + 12 * len(fields) + 4
    data = bytearray(b"II" + struct.pack("<HI", 42, 8))
    data.extend(struct.pack("<H", 1))
    data.extend(struct.pack("<HHII", 0x8769, 4, 1, exif_offset))
    data.extend(struct.pack("<I", 0))
    data.extend(struct.pack("<H", len(fields)))
    payload = bytearray()
    for tag, value in fields:
        data.extend(
            struct.pack("<HHII", tag, 2, len(value), data_offset + len(payload))
        )
        payload.extend(value)
    data.extend(struct.pack("<I", 0))
    data.extend(payload)
    return bytes(data)


def test_original_capture_time_and_offset_are_read_from_actual_exif():
    result = capture_metadata(original_exif())
    assert result["capture_time"] == "2026-05-31T17:28:00-05:00"
    assert result["capture_time_utc"] == "2026-05-31T22:28:00+00:00"
    assert result["timezone_known"] is True


def test_camera_time_without_offset_stays_local():
    result = capture_metadata(original_exif(offset=None))
    assert result["capture_time"] == "2026-05-31T17:28:00"
    assert result["capture_time_utc"] is None
    assert result["timezone_known"] is False


def test_modification_time_and_gps_are_not_used_as_capture_time(monkeypatch):
    monkeypatch.setattr(
        "every_street_mcp.photo_metadata.exifread.process_file",
        lambda *args, **kwargs: {
            "Image DateTime": "2026:05:31 17:28:00",
            "GPS GPSLatitude": "private",
        },
    )
    result = capture_metadata(b"no-original-metadata")
    assert result["status"] == "no_capture_time"
    assert result["capture_time"] is None
    assert "private" not in str(result)


@pytest.mark.parametrize(
    "url",
    [
        "http://files.oaiusercontent.com/file",
        "https://127.0.0.1/file",
        "https://www.everystreet.me/file",
        "https://evil.com/file",
        "https://files.oaiusercontent.com.evil.com/file",
        "https://files.oaiusercontent.com@evil.com/file",
        "https://user:secret@files.oaiusercontent.com/file",
        "https://files.oaiusercontent.com:8080/file",
    ],
)
def test_photo_downloads_cannot_target_arbitrary_or_private_hosts(url):
    with pytest.raises(ValueError):
        validate_photo_url(url)


def test_original_chatgpt_file_urls_are_accepted():
    validate_photo_url("https://files.oaiusercontent.com/file?signature=private")
    validate_photo_url(
        "https://openai-files.blob.core.windows.net/file?signature=private"
    )


class PhotoResponse:
    def __init__(self, data, status=200, content_length=None):
        self.status = status
        self.content_length = content_length
        self.data = data
        self.content = self

    async def iter_chunked(self, _size):
        yield self.data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        PhotoResponse(b"", status=302),
        PhotoResponse(b"", status=403),
        PhotoResponse(b"", content_length=21 * 1024 * 1024),
        PhotoResponse(b"x" * 100),
    ],
)
async def test_expired_redirected_or_oversized_files_have_no_url_leaks(
    response, monkeypatch
):
    monkeypatch.setattr("every_street_mcp.photo_metadata.MAX_PHOTO_BYTES", 50)
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return response

    monkeypatch.setattr(
        "every_street_mcp.photo_metadata.get_session",
        AsyncMock(return_value=SimpleNamespace(get=get)),
    )
    result = await inspect_photo(
        FuelPhoto(
            file_id="file-test",
            download_url="https://files.oaiusercontent.com/file?signature=secret",
        )
    )
    assert result["status"] == "unavailable"
    assert "secret" not in str(result)
    assert calls[0][1]["allow_redirects"] is False


@pytest.mark.asyncio
async def test_original_attachment_metadata_is_returned_without_retaining_photo(
    monkeypatch,
):
    session = SimpleNamespace(
        get=lambda *args, **kwargs: PhotoResponse(original_exif())
    )
    monkeypatch.setattr(
        "every_street_mcp.photo_metadata.get_session", AsyncMock(return_value=session)
    )
    result = await inspect_photos(
        [
            FuelPhoto(
                file_id="file-test",
                download_url="https://files.oaiusercontent.com/file",
            )
        ]
    )
    assert result["photos"][0]["capture_time_utc"] == "2026-05-31T22:28:00+00:00"
    assert result["images_retained"] is False
    with pytest.raises(ValueError, match="one and six"):
        await inspect_photos([])
