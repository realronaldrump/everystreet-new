"""Business logic for visit statistics and suggestions."""

import logging
import math
from collections import Counter, defaultdict, deque
from datetime import UTC, datetime, timedelta
from typing import Any

from shapely.geometry import MultiPoint, mapping

from core.spatial import get_local_transformers
from db.aggregation import aggregate_to_list
from db.models import Place, Trip
from db.schemas import (
    NonCustomPlaceVisit,
    PlaceResponse,
    PlaceStatisticsResponse,
    PlaceVisitsResponse,
    VisitResponse,
    VisitSuggestion,
)
from visits.services.visit_tracking_service import VisitTrackingService

logger = logging.getLogger(__name__)

TIMEFRAME_DELTAS = {
    "day": timedelta(days=1),
    "week": timedelta(weeks=1),
    "month": timedelta(days=30),
    "year": timedelta(days=365),
}


def _resolve_timeframe_start(
    timeframe: str | None,
    *,
    error_message: str,
) -> datetime | None:
    if not timeframe:
        return None
    timeframe_key = timeframe.lower()
    delta = TIMEFRAME_DELTAS.get(timeframe_key)
    if delta is None:
        raise ValueError(error_message)
    return datetime.now(UTC) - delta


def _extract_destination_coords(doc: dict[str, Any]) -> tuple[float, float] | None:
    dest_geo = doc.get("destinationGeoPoint")
    if isinstance(dest_geo, dict):
        coords = dest_geo.get("coordinates")
        if (
            isinstance(coords, list)
            and len(coords) >= 2
            and isinstance(coords[0], int | float)
            and isinstance(coords[1], int | float)
        ):
            return float(coords[0]), float(coords[1])

    gps = doc.get("gps")
    if isinstance(gps, dict):
        gps_type = gps.get("type")
        coords = gps.get("coordinates")
        if gps_type == "Point" and isinstance(coords, list) and len(coords) >= 2:
            return float(coords[0]), float(coords[1])
        if gps_type == "LineString" and isinstance(coords, list) and len(coords) >= 2:
            last = coords[-1]
            if isinstance(last, list) and len(last) >= 2:
                return float(last[0]), float(last[1])

    destination = doc.get("destination") or {}
    coords = destination.get("coordinates")
    if isinstance(coords, dict):
        lng = coords.get("lng")
        lat = coords.get("lat")
        if isinstance(lng, int | float) and isinstance(lat, int | float):
            return float(lng), float(lat)

    return None


def _extract_destination_label(doc: dict[str, Any]) -> str | None:
    for candidate in (
        doc.get("destinationPlaceName"),
        (doc.get("destination") or {}).get("formatted_address"),
        ((doc.get("destination") or {}).get("address_components") or {}).get("street"),
    ):
        if not isinstance(candidate, str):
            continue
        cleaned = candidate.strip()
        if cleaned and cleaned.lower() not in {"unknown", "n/a", "na"}:
            return cleaned
    return None


def _build_existing_place_index(
    places: list[Place],
) -> tuple[list[Any], Any | None]:
    from shapely import STRtree
    from shapely.geometry import shape as shp_shape

    polygons: list[Any] = []
    for place in places:
        try:
            if place.geometry:
                polygons.append(shp_shape(place.geometry))
        except Exception:
            continue

    if not polygons:
        return polygons, None
    return polygons, STRtree(polygons)


def _is_point_within_existing(
    *,
    lng: float,
    lat: float,
    tree: Any | None,
    polygons: list[Any],
) -> bool:
    if tree is None:
        return False
    from shapely.geometry import Point as ShpPoint

    pt = ShpPoint(lng, lat)
    for idx in tree.query(pt):
        try:
            if polygons[idx].contains(pt):
                return True
        except Exception:
            continue
    return False


def _build_candidates(
    docs: list[dict[str, Any]],
    *,
    tree: Any | None,
    polygons: list[Any],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for doc in docs:
        coords = _extract_destination_coords(doc)
        if not coords:
            continue
        lng, lat = coords
        if not (-180 <= lng <= 180 and -90 <= lat <= 90):
            continue
        if _is_point_within_existing(lng=lng, lat=lat, tree=tree, polygons=polygons):
            continue
        candidates.append(
            {
                "lng": lng,
                "lat": lat,
                "endTime": doc.get("endTime"),
                "label": _extract_destination_label(doc),
            },
        )
    return candidates


def _grid_key(x: float, y: float, cell: float) -> tuple[int, int]:
    return (math.floor(x / cell), math.floor(y / cell))


def _neighbors_for_point(
    *,
    point_idx: int,
    points: list[tuple[float, float]],
    grid: dict[tuple[int, int], list[int]],
    eps_sq: float,
    cell: float,
) -> list[int]:
    x, y = points[point_idx]
    gx, gy = _grid_key(x, y, cell)
    result: list[int] = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for j in grid.get((gx + dx, gy + dy), []):
                dx_m = x - points[j][0]
                dy_m = y - points[j][1]
                if dx_m * dx_m + dy_m * dy_m <= eps_sq:
                    result.append(j)
    return result


def _dbscan(
    points: list[tuple[float, float]],
    eps: float,
    min_samples: int,
) -> list[int]:
    labels = [-1] * len(points)
    if not points:
        return labels

    cell = max(eps, 1.0)
    eps_sq = eps * eps
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for idx, (x, y) in enumerate(points):
        grid[_grid_key(x, y, cell)].append(idx)

    visited = [False] * len(points)
    cluster_id = 0
    for i in range(len(points)):
        if visited[i]:
            continue
        visited[i] = True
        neighbor_idxs = _neighbors_for_point(
            point_idx=i,
            points=points,
            grid=grid,
            eps_sq=eps_sq,
            cell=cell,
        )
        if len(neighbor_idxs) < min_samples:
            labels[i] = -1
            continue
        cluster_id += 1
        labels[i] = cluster_id
        _expand_cluster(
            points=points,
            grid=grid,
            eps_sq=eps_sq,
            cell=cell,
            min_samples=min_samples,
            visited=visited,
            labels=labels,
            cluster_id=cluster_id,
            seed_neighbors=neighbor_idxs,
        )
    return labels


def _expand_cluster(
    *,
    points: list[tuple[float, float]],
    grid: dict[tuple[int, int], list[int]],
    eps_sq: float,
    cell: float,
    min_samples: int,
    visited: list[bool],
    labels: list[int],
    cluster_id: int,
    seed_neighbors: list[int],
) -> None:
    seed_set = set(seed_neighbors)
    seeds = deque(seed_neighbors)
    while seeds:
        j = seeds.popleft()
        if not visited[j]:
            visited[j] = True
            neighbor_j = _neighbors_for_point(
                point_idx=j,
                points=points,
                grid=grid,
                eps_sq=eps_sq,
                cell=cell,
            )
            if len(neighbor_j) >= min_samples:
                for k in neighbor_j:
                    if k not in seed_set:
                        seed_set.add(k)
                        seeds.append(k)
        if labels[j] == -1:
            labels[j] = cluster_id


def _cluster_centroid_m(
    points_m: list[tuple[float, float]],
    indices: list[int],
) -> tuple[float, float]:
    xs = [points_m[i][0] for i in indices]
    ys = [points_m[i][1] for i in indices]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def _cluster_max_radius_m(
    points_m: list[tuple[float, float]],
    indices: list[int],
) -> float:
    cx, cy = _cluster_centroid_m(points_m, indices)
    return max(math.hypot(points_m[i][0] - cx, points_m[i][1] - cy) for i in indices)


def _refine_cluster(
    *,
    points_m: list[tuple[float, float]],
    indices: list[int],
    min_visits: int,
    cell_size_m: int,
) -> list[list[int]]:
    if len(indices) < (min_visits * 2):
        return [indices]

    max_dist = _cluster_max_radius_m(points_m, indices)
    if max_dist <= (cell_size_m * 1.1):
        return [indices]

    refined_eps = max(35.0, min(cell_size_m * 0.35, max_dist * 0.3))
    local_points = [points_m[i] for i in indices]
    sub_labels = _dbscan(local_points, refined_eps, min_visits)

    subclusters: dict[int, list[int]] = {}
    for local_idx, sub_label in enumerate(sub_labels):
        if sub_label == -1:
            continue
        subclusters.setdefault(sub_label, []).append(indices[local_idx])

    if len(subclusters) <= 1:
        return [indices]
    return list(subclusters.values())


def _cluster_boundary(
    *,
    points: list[tuple[float, float]],
    cell_size_m: int,
) -> Any:
    from shapely.geometry import MultiPoint
    from shapely.ops import transform

    from core.spatial import get_local_transformers

    cluster_geom = MultiPoint(points)
    to_meters_cluster, to_wgs84_cluster = get_local_transformers(cluster_geom)
    cluster_geom_m = transform(to_meters_cluster, cluster_geom)
    hull_m = cluster_geom_m.convex_hull
    centroid_m = cluster_geom_m.centroid
    distances = sorted(centroid_m.distance(pt) for pt in cluster_geom_m.geoms)
    if distances:
        p60_idx = int(0.6 * (len(distances) - 1))
        p60_dist = distances[p60_idx]
    else:
        p60_dist = 0.0
    buffer_m = max(20.0, min(cell_size_m * 0.35, p60_dist * 0.6))
    return transform(to_wgs84_cluster, hull_m.buffer(buffer_m))


def _boundary_overlaps_existing(
    *,
    boundary_geom: Any,
    tree: Any | None,
    polygons: list[Any],
) -> bool:
    if tree is None:
        return False
    for idx in tree.query(boundary_geom):
        try:
            if polygons[idx].intersects(boundary_geom):
                return True
        except Exception:
            continue
    return False


def _suggestion_match_stage(timeframe: str | None) -> dict[str, Any]:
    match_stage: dict[str, Any] = {
        "$and": [
            {
                "$or": [
                    {"destinationPlaceId": {"$exists": False}},
                    {"destinationPlaceId": None},
                    {"destinationPlaceId": ""},
                ],
            },
            {
                "$or": [
                    {"destinationGeoPoint": {"$exists": True}},
                    {"gps": {"$exists": True}},
                    {"destination.coordinates": {"$exists": True}},
                ],
            },
        ],
        "endTime": {"$ne": None},
    }

    timeframe_start = _resolve_timeframe_start(
        timeframe,
        error_message="Unsupported timeframe. Choose from day, week, month, year.",
    )
    if timeframe_start is not None:
        match_stage["endTime"] = {"$gte": timeframe_start}
    return match_stage


def _collect_cluster_indices(labels: list[int]) -> dict[int, list[int]]:
    cluster_indices: dict[int, list[int]] = {}
    for idx, label in enumerate(labels):
        if label == -1:
            continue
        cluster_indices.setdefault(label, []).append(idx)
    return cluster_indices


def _collect_refined_clusters(
    *,
    points_m: list[tuple[float, float]],
    cluster_indices: dict[int, list[int]],
    min_visits: int,
    cell_size_m: int,
) -> list[list[int]]:
    refined_clusters: list[list[int]] = []
    for indices in cluster_indices.values():
        refined_clusters.extend(
            _refine_cluster(
                points_m=points_m,
                indices=indices,
                min_visits=min_visits,
                cell_size_m=cell_size_m,
            ),
        )
    return refined_clusters


def _cluster_summary(
    *,
    indices: list[int],
    candidates: list[dict[str, Any]],
) -> tuple[list[tuple[float, float]], Counter[str], Any | None, Any | None]:
    points: list[tuple[float, float]] = []
    label_counts: Counter[str] = Counter()
    first_visit = None
    last_visit = None

    for idx in indices:
        candidate = candidates[idx]
        points.append((candidate["lng"], candidate["lat"]))
        if candidate["label"]:
            label_counts[candidate["label"]] += 1
        end_time = candidate["endTime"]
        if end_time:
            if first_visit is None or end_time < first_visit:
                first_visit = end_time
            if last_visit is None or end_time > last_visit:
                last_visit = end_time

    return points, label_counts, first_visit, last_visit


def _build_cluster_suggestion(
    *,
    indices: list[int],
    candidates: list[dict[str, Any]],
    min_visits: int,
    cell_size_m: int,
    tree: Any | None,
    existing_polygons: list[Any],
) -> VisitSuggestion | None:
    if len(indices) < min_visits:
        return None

    points, label_counts, first_visit, last_visit = _cluster_summary(
        indices=indices,
        candidates=candidates,
    )
    avg_lng = sum(p[0] for p in points) / len(points)
    avg_lat = sum(p[1] for p in points) / len(points)
    suggested_name = (
        label_counts.most_common(1)[0][0]
        if label_counts
        else f"Area near {round(avg_lat, 4)}, {round(avg_lng, 4)}"
    )

    boundary_geom = _cluster_boundary(points=points, cell_size_m=cell_size_m)
    if _boundary_overlaps_existing(
        boundary_geom=boundary_geom,
        tree=tree,
        polygons=existing_polygons,
    ):
        return None

    return VisitSuggestion(
        suggestedName=suggested_name,
        totalVisits=len(points),
        firstVisit=first_visit,
        lastVisit=last_visit,
        centroid=[avg_lng, avg_lat],
        boundary=mapping(boundary_geom),
    )


class VisitStatsService:
    """Service class for visit statistics and suggestions."""

    @staticmethod
    async def get_place_statistics(
        place: Place | PlaceResponse,
    ) -> PlaceStatisticsResponse:
        """
        Get statistics about visits to a place.

        Args:
            place: Place model or PlaceResponse

        Returns:
            PlaceStatisticsResponse with visit statistics
        """
        visits = await VisitTrackingService.calculate_visits_for_place(place)

        total_visits = len(visits)
        durations = [
            v["duration"]
            for v in visits
            if v.get("duration") is not None and v["duration"] >= 0
        ]
        time_between_visits = [
            v["time_since_last"]
            for v in visits
            if v.get("time_since_last") is not None and v["time_since_last"] >= 0
        ]

        avg_duration = sum(durations) / len(durations) if durations else None
        avg_time_between = (
            sum(time_between_visits) / len(time_between_visits)
            if time_between_visits
            else None
        )

        first_visit = min((v["arrival_time"] for v in visits), default=None)
        last_visit = max((v["arrival_time"] for v in visits), default=None)

        # Get place name and id
        if isinstance(place, PlaceResponse):
            place_id = place.id
            name = place.name
        else:
            place_id = str(place.id)
            name = place.name or ""

        return PlaceStatisticsResponse(
            id=place_id,
            name=name,
            totalVisits=total_visits,
            averageTimeSpent=VisitTrackingService.format_duration(avg_duration),
            firstVisit=first_visit,
            lastVisit=last_visit,
            averageTimeSinceLastVisit=VisitTrackingService.format_duration(
                avg_time_between,
            ),
        )

    @staticmethod
    async def get_all_places_statistics() -> list[PlaceStatisticsResponse]:
        """
        Get statistics for all custom places.

        Returns:
            List of PlaceStatisticsResponse objects
        """
        places = await Place.find_all().to_list()
        if not places:
            return []

        results = []
        for place_model in places:
            visits = await VisitTrackingService.calculate_visits_for_place(place_model)

            total_visits = len(visits)
            durations = [
                v["duration"]
                for v in visits
                if v.get("duration") is not None and v["duration"] >= 0
            ]

            avg_duration = sum(durations) / len(durations) if durations else None

            first_visit = min((v["arrival_time"] for v in visits), default=None)
            last_visit = max((v["arrival_time"] for v in visits), default=None)

            results.append(
                PlaceStatisticsResponse(
                    id=str(place_model.id),
                    name=place_model.name or "",
                    totalVisits=total_visits,
                    averageTimeSpent=VisitTrackingService.format_duration(avg_duration),
                    firstVisit=first_visit,
                    lastVisit=last_visit,
                ),
            )
        return results

    @staticmethod
    async def get_trips_for_place(
        place: Place | PlaceResponse,
    ) -> PlaceVisitsResponse:
        """
        Get trips that visited a specific place.

        Args:
            place: Place model or PlaceResponse

        Returns:
            PlaceVisitsResponse with trips list and place name
        """
        visits = await VisitTrackingService.calculate_visits_for_place(place)

        trips_data = []
        for visit in visits:
            trip = visit["arrival_trip"]
            arrival_trip_id = str(trip.get("_id", ""))

            duration_str = VisitTrackingService.format_duration(visit["duration"])
            time_since_last_str = VisitTrackingService.format_duration(
                visit["time_since_last"],
            )

            distance = trip.get("distance", 0)
            if isinstance(distance, dict):
                distance = distance.get("value", 0)

            transaction_id = trip.get("transactionId", arrival_trip_id)

            trips_data.append(
                VisitResponse(
                    id=arrival_trip_id,
                    transactionId=transaction_id,
                    endTime=visit["arrival_time"],
                    departureTime=visit["departure_time"],
                    timeSpent=duration_str,
                    timeSinceLastVisit=time_since_last_str,
                    source=trip.get("source"),
                    distance=distance,
                ),
            )

        # Sort by endTime descending
        trips_data.sort(
            key=lambda x: x.endTime or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        # Get place name
        name = place.name if isinstance(place, PlaceResponse) else place.name or ""

        return PlaceVisitsResponse(trips=trips_data, name=name)

    @staticmethod
    async def get_non_custom_places_visits(
        timeframe: str | None = None,
    ) -> list[NonCustomPlaceVisit]:
        """
        Aggregate visits to non-custom destinations.

        The logic derives a human-readable place name from destination information,
        prioritizing actual place names over addresses:
            1. destinationPlaceName (if present - explicitly set place name)
            2. destination.formatted_address (full address from Nominatim, includes POI names)
            3. destination.address_components.street (street name as last resort)

        Args:
            timeframe: Optional time filter (day|week|month|year)

        Returns:
            List of NonCustomPlaceVisit objects

        Raises:
            ValueError: If timeframe is invalid
        """
        match_stage: dict[str, Any] = {
            "destinationPlaceId": {"$exists": False},
            "$or": [
                {"destinationPlaceName": {"$exists": True, "$ne": None}},
                {"destination.formatted_address": {"$exists": True, "$ne": ""}},
                {"destination.address_components.street": {"$exists": True, "$ne": ""}},
            ],
        }

        start_date = _resolve_timeframe_start(
            timeframe,
            error_message=(
                f"Unsupported timeframe '{timeframe}'. Choose from day, week, month, year."
            ),
        )
        if start_date is not None:
            match_stage["endTime"] = {"$gte": start_date}

        pipeline = [
            {"$match": match_stage},
            {
                "$addFields": {
                    "placeName": {
                        "$ifNull": [
                            "$destinationPlaceName",
                            {
                                "$ifNull": [
                                    "$destination.formatted_address",
                                    {
                                        "$ifNull": [
                                            "$destination.address_components.street",
                                            "Unknown",
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
            {"$match": {"placeName": {"$ne": None, "$nin": ["", "Unknown"]}}},
            {
                "$group": {
                    "_id": "$placeName",
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                },
            },
            {"$sort": {"totalVisits": -1}},
            {"$limit": 100},
        ]

        results = await aggregate_to_list(Trip, pipeline)

        return [
            NonCustomPlaceVisit(
                name=doc["_id"],
                totalVisits=doc["totalVisits"],
                firstVisit=doc.get("firstVisit"),
                lastVisit=doc.get("lastVisit"),
            )
            for doc in results
        ]

    @staticmethod
    async def get_visit_suggestions(
        min_visits: int = 5,
        cell_size_m: int = 250,
        timeframe: str | None = None,
    ) -> list[VisitSuggestion]:
        """
        Suggest areas that are visited often but are not yet custom places.

        This endpoint clusters trip destinations without destinationPlaceId
        using a distance-based approach (DBSCAN-style). It returns clusters
        with at least min_visits visits and generates a precise polygon
        boundary around each cluster.

        Args:
            min_visits: Minimum number of visits to suggest a place
            cell_size_m: Cluster radius in meters (neighbor distance)
            timeframe: Optional time filter (day|week|month|year)

        Returns:
            List of VisitSuggestion objects

        Raises:
            ValueError: If timeframe is invalid
        """
        match_stage = _suggestion_match_stage(timeframe)

        pipeline = [
            {"$match": match_stage},
            {
                "$project": {
                    "endTime": 1,
                    "destinationPlaceName": 1,
                    "destination": 1,
                    "destinationGeoPoint": 1,
                    "gps": 1,
                },
            },
        ]

        docs = await aggregate_to_list(Trip, pipeline)

        if not docs:
            return []

        existing_places = await Place.find_all().to_list()
        existing_polygons, tree = _build_existing_place_index(existing_places)
        candidates = _build_candidates(docs, tree=tree, polygons=existing_polygons)

        if not candidates:
            return []

        all_points = [(c["lng"], c["lat"]) for c in candidates]
        all_points_geom = MultiPoint(all_points)
        to_meters, _ = get_local_transformers(all_points_geom)
        points_m = [to_meters(lng, lat) for lng, lat in all_points]

        labels = _dbscan(points_m, cell_size_m, min_visits)
        cluster_indices = _collect_cluster_indices(labels)
        refined_clusters = _collect_refined_clusters(
            points_m=points_m,
            cluster_indices=cluster_indices,
            min_visits=min_visits,
            cell_size_m=cell_size_m,
        )

        suggestions: list[VisitSuggestion] = []
        for indices in refined_clusters:
            suggestion = _build_cluster_suggestion(
                indices=indices,
                candidates=candidates,
                min_visits=min_visits,
                cell_size_m=cell_size_m,
                tree=tree,
                existing_polygons=existing_polygons,
            )
            if suggestion is not None:
                suggestions.append(suggestion)

        suggestions.sort(key=lambda s: s.totalVisits, reverse=True)
        return suggestions
