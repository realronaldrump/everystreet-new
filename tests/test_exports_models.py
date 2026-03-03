import pytest
from bson import ObjectId

from exports.models import ExportItem, ExportRequest, TripFilters

# Resolve forward reference for PydanticObjectId
# Resolve forward reference for PydanticObjectId - No longer needed


def test_trip_filters_normalizes_status() -> None:
    filters = TripFilters(status="completed")
    assert filters.status == ["completed"]

    filters = TripFilters(status=["a", 1, None])
    assert filters.status == ["a", "1"]


def test_export_request_requires_items() -> None:
    with pytest.raises(ValueError):
        ExportRequest(items=[])


def test_export_request_rejects_invalid_format_for_entity() -> None:
    item = ExportItem(entity="boundaries", format="csv")
    with pytest.raises(ValueError):
        ExportRequest(items=[item], area_id=ObjectId())


def test_export_request_requires_area_id_for_coverage() -> None:
    item = ExportItem(entity="streets", format="geojson")
    with pytest.raises(ValueError):
        ExportRequest(items=[item])


def test_export_request_accepts_valid_payload() -> None:
    item = ExportItem(entity="trips", format="json")
    request = ExportRequest(items=[item])
    assert request.items[0].entity == "trips"


def test_export_request_accepts_gpx_trip_format() -> None:
    item = ExportItem(entity="trips", format="gpx")
    request = ExportRequest(items=[item])
    assert request.items[0].format == "gpx"


def test_export_request_rejects_trip_clip_without_trip_entities() -> None:
    item = ExportItem(entity="streets", format="geojson")
    with pytest.raises(ValueError):
        ExportRequest(
            items=[item],
            area_id=ObjectId(),
            trip_filters=TripFilters(clip_to_coverage=True),
        )


def test_export_request_requires_area_id_when_trip_clip_enabled() -> None:
    item = ExportItem(entity="trips", format="json")
    with pytest.raises(ValueError):
        ExportRequest(
            items=[item],
            trip_filters=TripFilters(clip_to_coverage=True),
        )


def test_export_request_accepts_area_id_when_trip_clip_enabled() -> None:
    item = ExportItem(entity="trips", format="json")
    request = ExportRequest(
        items=[item],
        area_id=ObjectId(),
        trip_filters=TripFilters(clip_to_coverage=True),
    )
    assert request.trip_filters is not None
    assert request.trip_filters.clip_to_coverage is True
