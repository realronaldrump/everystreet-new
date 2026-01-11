import asyncio
import unittest
from unittest.mock import MagicMock, patch, AsyncMock
from coverage.calculator import CoverageCalculator
from coverage.constants import MAX_CONCURRENT_DB_OPS


class TestConcurrency(unittest.IsolatedAsyncioTestCase):
    async def test_semaphore_limit(self):
        # Mock dependencies
        mock_location = {"display_name": "Test Location"}

        # Instantiate calculator
        calculator = CoverageCalculator(mock_location, "test_task")

        # Verify semaphore initialization
        self.assertEqual(calculator._db_semaphore._value, MAX_CONCURRENT_DB_OPS)

        # Mock Street.find to simulate DB delay and track concurrency
        active_queries = 0
        max_active_queries = 0

        async def mock_find(*args, **kwargs):
            nonlocal active_queries, max_active_queries
            active_queries += 1
            if active_queries > max_active_queries:
                max_active_queries = active_queries

            # Simulate DB latency
            await asyncio.sleep(0.01)

            active_queries -= 1
            mock_cursor = AsyncMock()
            mock_cursor.to_list.return_value = []
            return mock_cursor

        # Mock GeometryService to return valid geometry
        with (
            patch(
                "coverage.calculator.Street.find", side_effect=mock_find
            ) as mock_street_find,
            patch("coverage.calculator.GeometryService") as mock_geo_service,
            patch("coverage.calculator.Trip") as mock_trip_cls,
        ):
            # Setup mock valid trip
            mock_geo_service.validate_geojson_point_or_linestring.return_value = (
                True,
                {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            )

            # Create a batch larger than the limit
            batch_size = MAX_CONCURRENT_DB_OPS * 3
            batch = []
            for i in range(batch_size):
                trip = MagicMock()
                trip.id = f"trip_{i}"
                trip.gps = {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}
                batch.append(trip)

            processed_ids = set()

            # Run batch processing
            # We are verifying internal behavior of _process_batch triggering _find_intersecting_streets
            # which now constructs tasks wrapped in semaphore?
            # Actually catch: The semaphore is inside _find_intersecting_streets.
            # _process_batch calls asyncio.gather which starts all tasks.
            # Each task enters _find_intersecting_streets.
            # Then they await self._db_semaphore.

            await calculator._process_batch(batch, processed_ids)

            # Internal max_active_queries inside the mock_find should not exceed MAX_CONCURRENT_DB_OPS
            # HOWEVER, since we mock Street.find, and Street.find is called INSIDE the semaphore block,
            # counting active executions of mock_find is the correct way to verify the semaphore works.

            print(f"Max concurrent DB ops recorded: {max_active_queries}")

            # Allow for small timing discrepancies, but it should be close to limit
            # Strictly it should be <= MAX_CONCURRENT_DB_OPS because semaphore blocks entry
            self.assertLessEqual(max_active_queries, MAX_CONCURRENT_DB_OPS)
            self.assertGreater(max_active_queries, 0)


if __name__ == "__main__":
    unittest.main()
