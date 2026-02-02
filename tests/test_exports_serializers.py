import unittest
from datetime import UTC, datetime

from bson import ObjectId

from exports.serializers import (
    serialize_boundary_properties,
    serialize_street_properties,
    serialize_trip_properties,
    serialize_trip_record,
)


class ExportSerializerTests(unittest.TestCase):
    def test_serialize_trip_record_includes_expected_fields(self) -> None:
        trip_id = ObjectId()
        trip = {
            "_id": trip_id,
            "transactionId": "tx-1",
            "startTime": "2024-01-01T00:00:00Z",
            "endTime": "2024-01-01T01:00:00Z",
            "distance": 12.5,
            "avgSpeed": 25.5,
            "hardBrakingCounts": 2,
            "startLocation": {"formatted_address": "Start"},
            "destination": {"formatted_address": "End"},
            "gps": {"type": "LineString", "coordinates": [[-97.0, 32.0]]},
        }

        record = serialize_trip_record(trip, include_geometry=True)

        assert record["tripId"] == str(trip_id)
        assert record["transactionId"] == "tx-1"
        assert record["durationSeconds"] == 3600.0
        assert record["hardBrakingCounts"] == 2
        assert record["startLocation"]["formatted_address"] == "Start"
        assert record["gps"] is not None

    def test_serialize_trip_record_can_omit_geometry(self) -> None:
        trip = {
            "transactionId": "tx-2",
            "gps": {"type": "Point", "coordinates": [-97.0, 32.0]},
            "matchedGps": {"type": "Point", "coordinates": [-97.1, 32.1]},
        }

        record = serialize_trip_record(trip, include_geometry=False)
        assert record["gps"] is None
        assert record["matchedGps"] is None

    def test_serialize_trip_properties_for_geojson(self) -> None:
        trip = {
            "transactionId": "tx-3",
            "distance": 5.0,
            "status": "completed",
        }

        props = serialize_trip_properties(trip)
        assert props["transactionId"] == "tx-3"
        assert props["distance"] == 5.0
        assert props["status"] == "completed"

    def test_serialize_street_properties(self) -> None:
        street = {
            "segment_id": "seg-1",
            "area_id": ObjectId(),
            "area_version": 2,
            "street_name": "Main",
            "highway_type": "residential",
            "osm_id": 123,
            "length_miles": 0.8,
        }
        state = {
            "status": "driven",
            "last_driven_at": datetime(2024, 1, 2, tzinfo=UTC),
            "first_driven_at": datetime(2024, 1, 1, tzinfo=UTC),
            "manually_marked": True,
            "marked_at": datetime(2024, 1, 3, tzinfo=UTC),
        }

        props = serialize_street_properties(street, state)
        assert props["segment_id"] == "seg-1"
        assert props["status"] == "driven"
        assert props["last_driven_at"].startswith("2024-01-02")
        assert props["manually_marked"]

    def test_serialize_boundary_properties(self) -> None:
        area = {
            "id": ObjectId(),
            "display_name": "Test Area",
            "area_type": "city",
            "area_version": 1,
            "coverage_percentage": 42.0,
            "total_segments": 10,
            "driven_segments": 4,
        }

        props = serialize_boundary_properties(area)
        assert props["display_name"] == "Test Area"
        assert props["coverage_percentage"] == 42.0


if __name__ == "__main__":
    unittest.main()
