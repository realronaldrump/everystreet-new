import pytest

from exports.models import ExportItem
from exports.services.export_service import ExportService


def test_normalize_item_defaults_format_and_geometry() -> None:
    item = ExportItem(entity="trips")
    normalized = ExportService._normalize_item(item)

    assert normalized["format"] == "json"
    assert normalized["include_geometry"] is True


def test_normalize_item_defaults_geometry_for_csv() -> None:
    item = ExportItem(entity="trips", format="csv")
    normalized = ExportService._normalize_item(item)

    assert normalized["format"] == "csv"
    assert normalized["include_geometry"] is False


def test_normalize_item_rejects_invalid_format() -> None:
    item = ExportItem.model_construct(
        entity="trips",
        format="xml",
        include_geometry=None,
    )

    with pytest.raises(ValueError):
        ExportService._normalize_item(item)


def test_build_trip_query_defaults_to_exclude_invalid() -> None:
    """Empty filters should still exclude invalid trips."""
    query = ExportService._build_trip_query({}, matched_only=False)

    assert query == {"invalid": {"$ne": True}}


def test_build_trip_query_adds_matched_gps_filter() -> None:
    """matched_only=True should require matchedGps to be non-null."""
    query = ExportService._build_trip_query({}, matched_only=True)

    assert query["matchedGps"] == {"$ne": None}
    assert query["invalid"] == {"$ne": True}


def test_build_trip_query_includes_imei_filter() -> None:
    """IMEI filter should be passed through to query."""
    filters = {"imei": "test-imei-123"}
    query = ExportService._build_trip_query(filters, matched_only=False)

    assert query["imei"] == "test-imei-123"


def test_build_trip_query_includes_status_filter() -> None:
    """Status filter should use $in operator."""
    filters = {"status": ["active", "completed"]}
    query = ExportService._build_trip_query(filters, matched_only=False)

    assert query["status"] == {"$in": ["active", "completed"]}


def test_build_trip_query_includes_invalid_when_requested() -> None:
    """include_invalid=True should not add invalid filter."""
    filters = {"include_invalid": True}
    query = ExportService._build_trip_query(filters, matched_only=False)

    assert "invalid" not in query


def test_entity_file_path_returns_correct_extension() -> None:
    """Verify file path construction for different entities and formats."""
    from pathlib import Path

    export_dir = Path("/tmp/export")

    # trips entity uses "trips" subdir
    path = ExportService._entity_file_path(export_dir, "trips", "json")
    assert path.name == "trips.json"

    path = ExportService._entity_file_path(export_dir, "streets", "geojson")
    assert path.name == "streets.geojson"
