"""Business logic for visit detection and tracking."""

import asyncio
import logging
import math
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime
from typing import Any

from shapely import STRtree
from shapely.errors import ShapelyError
from shapely.geometry import Point, shape

from core.date_utils import normalize_to_utc_datetime
from core.trip_query_spec import apply_trip_record_filters
from core.trip_source_policy import enforce_bouncie_source
from db.aggregation import aggregate_to_list
from db.models import Place, Trip
from db.schemas import PlaceResponse

logger = logging.getLogger(__name__)

# Visit calculations never need the routes, telemetry, or processing histories.
VISIT_TRIP_PROJECTION = {
    "_id": 1,
    "transactionId": 1,
    "imei": 1,
    "startTime": 1,
    "endTime": 1,
    "destinationPlaceId": 1,
    "destinationGeoPoint": 1,
    "distance": 1,
    "source": 1,
}


def _calculate_visits(
    docs: list[dict[str, Any]],
    places: list[Place | PlaceResponse],
    *,
    arrival_since: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Match one compact trip timeline to every place without correlated queries."""
    visits_by_place: dict[str, list[dict[str, Any]]] = {
        str(place.id): [] for place in places
    }
    polygons = []
    polygon_ids = []
    for place in places:
        if not place.geometry:
            continue
        try:
            polygon = shape(place.geometry)
            if polygon.is_empty or not polygon.is_valid:
                continue
            polygons.append(polygon)
            polygon_ids.append(str(place.id))
        except (ShapelyError, TypeError, ValueError, AttributeError):
            continue
    tree = STRtree(polygons) if polygons else None

    # Index departures once per vehicle. Bisect handles overlapping trips and
    # zero dwell while preserving the next start >= arrival rule.
    starts_by_vehicle: dict[str, list[datetime]] = defaultdict(list)
    arrivals = []
    for doc in docs:
        start = normalize_to_utc_datetime(doc.get("startTime"))
        imei = doc.get("imei")
        if start is not None and imei:
            starts_by_vehicle[imei].append(start)
        end = normalize_to_utc_datetime(doc.get("endTime"))
        if end is not None and (arrival_since is None or end >= arrival_since):
            arrivals.append((end, doc))
    for starts in starts_by_vehicle.values():
        starts.sort()
    arrivals.sort(key=lambda arrival: (arrival[0], str(arrival[1].get("_id", ""))))

    for arrival_time, doc in arrivals:
        matched_ids = set()
        explicit_id = doc.get("destinationPlaceId")
        if isinstance(explicit_id, str) and explicit_id in visits_by_place:
            matched_ids.add(explicit_id)
        destination = doc.get("destinationGeoPoint")
        coords = (
            destination.get("coordinates") if isinstance(destination, dict) else None
        )
        if (
            tree is not None
            and isinstance(coords, list)
            and len(coords) >= 2
            and all(
                isinstance(value, int | float) and math.isfinite(value)
                for value in coords[:2]
            )
            and -180 <= coords[0] <= 180
            and -90 <= coords[1] <= 90
        ):
            point = Point(coords[0], coords[1])
            matched_ids.update(
                polygon_ids[index]
                for index in tree.query(point, predicate="covered_by")
            )
        if not matched_ids:
            continue

        starts = starts_by_vehicle.get(doc.get("imei"), [])
        next_index = bisect_left(starts, arrival_time)
        departure = starts[next_index] if next_index < len(starts) else None
        duration = (departure - arrival_time).total_seconds() if departure else None
        for place_id in matched_ids:
            visits = visits_by_place[place_id]
            previous_departure = visits[-1]["departure_time"] if visits else None
            visits.append(
                {
                    "arrival_trip": doc,
                    "arrival_time": arrival_time,
                    "departure_time": departure,
                    "duration": duration,
                    "time_since_last": (
                        (arrival_time - previous_departure).total_seconds()
                        if previous_departure is not None
                        else None
                    ),
                }
            )
    return visits_by_place


class VisitTrackingService:
    """Service class for visit tracking and calculation."""

    @staticmethod
    async def calculate_visits_for_places(
        places: list[Place | PlaceResponse],
        *,
        arrival_since: datetime | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Read a compact timeline once, then calculate all requested places."""
        if not places:
            return {}
        match = enforce_bouncie_source(apply_trip_record_filters())
        if arrival_since is not None:
            # Departures must remain available even if their trip has no endTime.
            match["$or"] = [
                {"endTime": {"$gte": arrival_since}},
                {"startTime": {"$gte": arrival_since}},
            ]
        docs = await aggregate_to_list(
            Trip,
            [{"$match": match}, {"$project": VISIT_TRIP_PROJECTION}],
        )
        return await asyncio.to_thread(
            _calculate_visits, docs, places, arrival_since=arrival_since
        )

    @staticmethod
    async def calculate_visits_for_place(
        place: Place | PlaceResponse,
        *,
        arrival_since: datetime | None = None,
    ) -> list[dict[str, Any]]:
        """Use the same timeline semantics for place details and summary cards."""
        grouped = await VisitTrackingService.calculate_visits_for_places(
            [place], arrival_since=arrival_since
        )
        return grouped[str(place.id)]

    @staticmethod
    def format_duration(seconds) -> str:
        """
        Format duration in seconds to a human-readable string.

        Args:
            seconds: Duration in seconds (can be None or negative)

        Returns:
            Formatted string like "5m 30s", "2h 15m", "3d 4h 30m", or "N/A"
        """
        if seconds is None or seconds < 0:
            return "N/A"

        if seconds < 60:
            return f"{int(seconds)}s"
        if seconds < 3600:
            mins = int(seconds // 60)
            secs = int(seconds % 60)
            return f"{mins}m {secs}s"
        if seconds < 86400:
            hrs = int(seconds // 3600)
            mins = int((seconds % 3600) // 60)
            return f"{hrs}h {mins:02d}m"
        days = int(seconds // 86400)
        hrs = int((seconds % 86400) // 3600)
        mins = int((seconds % 3600) // 60)
        return f"{days}d {hrs}h {mins:02d}m"
