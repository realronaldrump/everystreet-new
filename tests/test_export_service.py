from datetime import UTC, datetime

import pytest

from exports.models import ExportItem
from exports.services.export_service import ExportService, _TripExportClipContext


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


def test_normalize_item_forces_geometry_for_gpx() -> None:
    item = ExportItem(entity="trips", format="gpx", include_geometry=False)
    normalized = ExportService._normalize_item(item)

    assert normalized["format"] == "gpx"
    assert normalized["include_geometry"] is True


def test_normalize_item_rejects_invalid_format() -> None:
    item = ExportItem.model_construct(
        entity="trips",
        format="xml",
        include_geometry=None,
    )

    with pytest.raises(ValueError):
        ExportService._normalize_item(item)


def test_build_trip_query_defaults_to_exclude_invalid_and_inactive() -> None:
    """Empty filters should still exclude invalid and inactive trips."""
    query = ExportService._build_trip_query({}, matched_only=False)

    assert query == {
        "inactive": {"$ne": True},
        "invalid": {"$ne": True},
        "source": "bouncie",
    }


def test_build_trip_query_adds_matched_gps_filter() -> None:
    """matched_only=True should require matchedGps to be non-null."""
    query = ExportService._build_trip_query({}, matched_only=True)

    assert query["matchedGps"] == {"$ne": None}
    assert query["invalid"] == {"$ne": True}
    assert query["inactive"] == {"$ne": True}


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
    assert query["inactive"] == {"$ne": True}


def test_build_trip_query_adds_clip_prefilter_when_enabled() -> None:
    """Clip context should add bounding-box prefilter against gps."""
    clip_context = _TripExportClipContext(
        enabled=True,
        prefilter_geometry={
            "type": "Polygon",
            "coordinates": [
                [
                    [0.0, 0.0],
                    [1.0, 0.0],
                    [1.0, 1.0],
                    [0.0, 1.0],
                    [0.0, 0.0],
                ],
            ],
        },
    )
    query = ExportService._build_trip_query(
        {},
        matched_only=False,
        trip_clip_context=clip_context,
    )

    assert (
        query["gps"]["$geoIntersects"]["$geometry"] == clip_context.prefilter_geometry
    )


def test_build_matched_trip_query_prefilters_matched_geometry() -> None:
    clip_context = _TripExportClipContext(
        enabled=True,
        prefilter_geometry={
            "type": "Polygon",
            "coordinates": [
                [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]],
            ],
        },
    )

    query = ExportService._build_trip_query(
        {},
        matched_only=True,
        trip_clip_context=clip_context,
    )

    assert "gps" not in query
    assert (
        query["matchedGps"]["$geoIntersects"]["$geometry"]
        == clip_context.prefilter_geometry
    )


def test_gpx_segments_preserve_multiline_parts_and_absolute_times() -> None:
    start = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    row = {
        "startTime": start,
        "endTime": datetime(2024, 1, 1, 12, 0, 30, tzinfo=UTC),
        "gps": {
            "type": "MultiLineString",
            "coordinates": [
                [[-97.0, 31.0], [-97.1, 31.1]],
                [[-98.0, 32.0], [-98.1, 32.1]],
            ],
        },
    }

    segments = ExportService._gpx_segments(row, geometry_field="gps")

    assert [len(segment["coordinates"]) for segment in segments] == [2, 2]
    assert segments[0]["timestamps"] == [
        int(start.timestamp()),
        int(start.timestamp()) + 10,
    ]
    assert segments[1]["timestamps"] == [
        int(start.timestamp()) + 20,
        int(start.timestamp()) + 30,
    ]


def test_gpx_segments_normalize_source_millisecond_timestamps() -> None:
    row = {
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.1, 31.1]],
        },
        "coordinates": [
            {"timestamp": 1_704_110_400_000},
            {"timestamp": 1_704_110_405_000},
        ],
    }

    segments = ExportService._gpx_segments(row, geometry_field="gps")

    assert segments[0]["timestamps"] == [1_704_110_400, 1_704_110_405]


def test_gpx_segments_treat_small_numeric_timestamps_as_elapsed() -> None:
    start = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    row = {
        "startTime": start,
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.1, 31.1]],
        },
        "coordinates": [
            {"timestamp": 100},
            {"timestamp": 105},
        ],
    }

    segments = ExportService._gpx_segments(row, geometry_field="gps")

    assert segments[0]["timestamps"] == [
        int(start.timestamp()),
        int(start.timestamp()) + 5,
    ]


def test_entity_file_path_returns_correct_extension() -> None:
    """Verify file path construction for different entities and formats."""
    from pathlib import Path

    export_dir = Path("/tmp/export")

    # trips entity uses "trips" subdir
    path = ExportService._entity_file_path(export_dir, "trips", "json")
    assert path.name == "trips.json"

    path = ExportService._entity_file_path(export_dir, "trips", "gpx")
    assert path.name == "trips.gpx"

    path = ExportService._entity_file_path(export_dir, "streets", "geojson")
    assert path.name == "streets.geojson"
