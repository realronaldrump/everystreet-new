import unittest
from datetime import datetime, timezone

from bson import ObjectId

from exports.serializers import (
    serialize_boundary_properties,
    serialize_street_properties,
    serialize_trip_properties,
    serialize_trip_record,
)


class ExportSerializerTests(unittest.TestCase):
    def test_serialize_trip_record_includes_expected_fields(self):
        trip_id = ObjectId()
        trip = {
            "_id": trip_id,
            "transactionId": "tx-1",
            "startTime": "2024-01-01T00:00:00Z",
            "endTime": "2024-01-01T01:00:00Z",
            "distance": 12.5,
            "avgSpeed": 25.5,
            "hardBrakingCount": 2,
            "startLocation": {"formatted_address": "Start"},
            "destination": {"formatted_address": "End"},
            "gps": {"type": "LineString", "coordinates": [[-97.0, 32.0]]},
        }

        record = serialize_trip_record(trip, include_geometry=True)

        self.assertEqual(record["tripId"], str(trip_id))
        self.assertEqual(record["transactionId"], "tx-1")
        self.assertEqual(record["durationSeconds"], 3600.0)
        self.assertEqual(record["hardBrakingCounts"], 2)
        self.assertEqual(record["startLocation"]["formatted_address"], "Start")
        self.assertIsNotNone(record["gps"])

    def test_serialize_trip_record_can_omit_geometry(self):
        trip = {
            "transactionId": "tx-2",
            "gps": {"type": "Point", "coordinates": [-97.0, 32.0]},
            "matchedGps": {"type": "Point", "coordinates": [-97.1, 32.1]},
        }

        record = serialize_trip_record(trip, include_geometry=False)
        self.assertIsNone(record["gps"])
        self.assertIsNone(record["matchedGps"])

    def test_serialize_trip_properties_for_geojson(self):
        trip = {
            "transactionId": "tx-3",
            "distance": 5.0,
            "status": "completed",
        }

        props = serialize_trip_properties(trip)
        self.assertEqual(props["transactionId"], "tx-3")
        self.assertEqual(props["distance"], 5.0)
        self.assertEqual(props["status"], "completed")

    def test_serialize_street_properties(self):
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
            "last_driven_at": datetime(2024, 1, 2, tzinfo=timezone.utc),
            "first_driven_at": datetime(2024, 1, 1, tzinfo=timezone.utc),
            "manually_marked": True,
            "marked_at": datetime(2024, 1, 3, tzinfo=timezone.utc),
        }

        props = serialize_street_properties(street, state)
        self.assertEqual(props["segment_id"], "seg-1")
        self.assertEqual(props["status"], "driven")
        self.assertTrue(props["last_driven_at"].startswith("2024-01-02"))
        self.assertTrue(props["manually_marked"])

    def test_serialize_boundary_properties(self):
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
        self.assertEqual(props["display_name"], "Test Area")
        self.assertEqual(props["coverage_percentage"], 42.0)


if __name__ == "__main__":
    unittest.main()
