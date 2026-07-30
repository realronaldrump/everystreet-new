"""Unified county/state/city coverage services."""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import BackgroundTasks, HTTPException, status
from shapely import STRtree
from shapely.geometry import Point, shape

from core.date_utils import parse_timestamp
from core.job_serialization import serialize_job_payload
from core.jobs import resolve_job_reference
from core.serialization import serialize_datetime
from core.spatial import coerce_coordinate_pair, validate_and_fix_geometry
from core.trip_query_spec import apply_trip_record_filters
from core.trip_source_policy import enforce_bouncie_source
from county.services.county_data_service import get_county_topology_document
from county.services.topojson_utils import topojson_to_geojson
from db.models import (
    CityBoundary,
    CityVisitedCache,
    CountyVisitedCache,
    Job,
    StateBoundaryCache,
    Trip,
)

logger = logging.getLogger(__name__)

GEO_COVERAGE_JOB_TYPE = "geo_coverage_recalc"
GEO_RECALC_ACTIVE_STATUSES: set[str] = {"pending", "running"}
GEO_RECALC_STALE_AFTER_SECONDS = int(
    os.getenv("GEO_RECALC_STALE_AFTER_SECONDS", str(6 * 60 * 60))
)

_SUPPORTED_GEO_TYPES: set[str] = {"LineString", "MultiLineString", "Point"}


def _is_supported_geojson_geometry(value: Any) -> bool:
    return isinstance(value, dict) and value.get("type") in _SUPPORTED_GEO_TYPES


def _select_trip_geometry(trip: Trip) -> dict[str, Any] | None:
    """
    Return the best geometry for geo coverage processing.

    Prefer map-matched geometry when it is a supported type; otherwise
    fall back to raw trip GPS if available.
    """
    matched = trip.matchedGps
    if _is_supported_geojson_geometry(matched):
        return matched

    raw = trip.gps
    if _is_supported_geojson_geometry(raw):
        return raw

    return None


def _record_visit(
    visit_map: dict[str, dict[str, datetime | None]],
    key: str,
    visit_time: datetime | None,
) -> None:
    if key not in visit_map:
        visit_map[key] = {"firstVisit": visit_time, "lastVisit": visit_time}
        return
    if visit_time is None:
        return
    if (
        visit_map[key]["firstVisit"] is None
        or visit_time < visit_map[key]["firstVisit"]
    ):
        visit_map[key]["firstVisit"] = visit_time
    if visit_map[key]["lastVisit"] is None or visit_time > visit_map[key]["lastVisit"]:
        visit_map[key]["lastVisit"] = visit_time


def _record_boundary_visits(
    *,
    trip_geometry: Any,
    boundary_tree: STRtree | None,
    boundary_index_lookup: dict[int, int],
    boundary_shapes: list[Any],
    boundary_ids: list[str],
    visit_map: dict[str, dict[str, datetime | None]],
    visit_time: datetime | None,
) -> None:
    """Record every boundary intersected by any supported trip geometry."""
    if boundary_tree is None:
        return
    for idx in _iter_tree_indexes(
        boundary_tree,
        boundary_index_lookup,
        len(boundary_shapes),
        trip_geometry,
    ):
        if boundary_shapes[idx].intersects(trip_geometry):
            _record_visit(visit_map, boundary_ids[idx], visit_time)


def _extract_stop_points(
    gps_data: dict[str, Any] | None,
    trip_start_time: datetime | None,
    trip_end_time: datetime | None,
    default_time: datetime | None,
) -> list[tuple[Point, datetime | None]]:
    stop_points: list[tuple[Point, datetime | None]] = []

    if not gps_data:
        return stop_points

    gps_type = gps_data.get("type")
    coords = gps_data.get("coordinates")

    if gps_type == "Point":
        point_coords = coerce_coordinate_pair(coords)
        if point_coords:
            stop_points.append((Point(point_coords[0], point_coords[1]), default_time))
        return stop_points

    if gps_type == "LineString" and isinstance(coords, list) and coords:
        start_coords = coerce_coordinate_pair(coords[0])
        end_coords = coerce_coordinate_pair(coords[-1])
        start_time = trip_start_time or default_time
        end_time = trip_end_time or default_time

        if start_coords:
            stop_points.append((Point(start_coords[0], start_coords[1]), start_time))

        if end_coords:
            same_coords = bool(start_coords and end_coords == start_coords)
            same_time = start_time == end_time
            if same_coords and same_time:
                return stop_points
            stop_points.append((Point(end_coords[0], end_coords[1]), end_time))

    if gps_type == "MultiLineString" and isinstance(coords, list) and coords:
        first_coords = None
        last_coords = None

        for segment in coords:
            if not isinstance(segment, list) or not segment:
                continue
            if first_coords is None:
                first_coords = coerce_coordinate_pair(segment[0])
            candidate_last = coerce_coordinate_pair(segment[-1])
            if candidate_last:
                last_coords = candidate_last

        start_time = trip_start_time or default_time
        end_time = trip_end_time or default_time

        if first_coords:
            stop_points.append((Point(first_coords[0], first_coords[1]), start_time))

        if last_coords:
            same_coords = bool(first_coords and last_coords == first_coords)
            same_time = start_time == end_time
            if same_coords and same_time:
                return stop_points
            stop_points.append((Point(last_coords[0], last_coords[1]), end_time))

    return stop_points


def _percent(visited: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((visited / total) * 100.0, 2)


def _state_fips(value: str | None) -> str:
    raw = str(value or "").strip()
    if raw.isdigit() and len(raw) <= 2:
        return raw.zfill(2)
    return raw


def _valid_state_fips(value: str | None) -> str | None:
    normalized = _state_fips(value)
    if len(normalized) == 2 and normalized.isdigit():
        return normalized
    return None


def _county_fips(value: Any) -> str | None:
    raw = str(value if value is not None else "").strip()
    if not raw.isdigit() or len(raw) > 5:
        return None
    return raw.zfill(5)


def _valid_boundary_geometry(value: Any) -> Any | None:
    if not isinstance(value, dict):
        return None
    try:
        return validate_and_fix_geometry(shape(value))
    except Exception:
        return None


def _serialize_visit_map(
    raw_map: dict[str, dict[str, datetime | None]],
) -> dict[str, dict[str, str | None]]:
    return {
        key: {
            "firstVisit": serialize_datetime(payload.get("firstVisit")),
            "lastVisit": serialize_datetime(payload.get("lastVisit")),
        }
        for key, payload in raw_map.items()
    }


def _serialize_stop_map(
    raw_map: dict[str, dict[str, datetime | None]],
) -> dict[str, dict[str, str | None]]:
    return {
        key: {
            "firstStop": serialize_datetime(payload.get("firstVisit")),
            "lastStop": serialize_datetime(payload.get("lastVisit")),
        }
        for key, payload in raw_map.items()
    }


def _build_trip_query() -> dict[str, Any]:
    geometry_filter = apply_trip_record_filters(
        {
            "invalid": {"$ne": True},
            "$or": [
                {"gps.type": {"$in": ["LineString", "MultiLineString", "Point"]}},
                {
                    "matchedGps.type": {
                        "$in": ["LineString", "MultiLineString", "Point"]
                    }
                },
            ],
        },
        include_invalid=True,
    )

    return enforce_bouncie_source(geometry_filter)


def _serialize_job(job: Job | None) -> dict[str, Any] | None:
    if not job:
        return None

    payload = serialize_job_payload(job)
    return {
        "id": str(payload["job_id"]),
        "status": payload["status"],
        "stage": payload["stage"],
        "progress": payload["progress"],
        "message": payload["message"] or "",
        "error": payload["error"],
        "mode": "full",
        "createdAt": payload["created_at"],
        "startedAt": payload["started_at"],
        "updatedAt": payload["updated_at"],
        "completedAt": payload["completed_at"],
        "metrics": job.metrics or {},
        "result": payload["result"] or {},
    }


async def _resolve_job(job_id: str | None) -> Job | None:
    return await resolve_job_reference(
        job_id,
        allow_task_id=False,
        allow_operation_id=False,
    )


async def _get_active_geo_recalc_candidates() -> list[Job]:
    return (
        await Job.find(
            {
                "job_type": GEO_COVERAGE_JOB_TYPE,
                "status": {"$in": list(GEO_RECALC_ACTIVE_STATUSES)},
            }
        )
        .sort("-created_at")
        .to_list()
    )


def _is_geo_recalc_job_stale(
    job: Job,
    *,
    now: datetime | None = None,
) -> bool:
    if job.status not in GEO_RECALC_ACTIVE_STATUSES:
        return False

    reference_time = (
        parse_timestamp(job.updated_at)
        or parse_timestamp(job.started_at)
        or parse_timestamp(job.created_at)
    )
    if reference_time is None:
        return True

    current_time = now or datetime.now(UTC)
    return current_time - reference_time > timedelta(
        seconds=GEO_RECALC_STALE_AFTER_SECONDS
    )


async def _mark_geo_recalc_job_stale(
    job: Job,
    *,
    now: datetime | None = None,
) -> None:
    current_time = now or datetime.now(UTC)
    previous_status = job.status
    job.status = "failed"
    job.stage = "Stale"
    job.progress = 100.0
    job.message = "Region Explorer cache rebuild was marked failed after stalling."
    job.error = (
        "Region Explorer cache rebuild exceeded the stale-job timeout while "
        f"status was '{previous_status}'."
    )
    job.completed_at = current_time
    job.updated_at = current_time
    await job.save()


async def _get_active_geo_recalc_job() -> Job | None:
    now = datetime.now(UTC)
    for job in await _get_active_geo_recalc_candidates():
        if _is_geo_recalc_job_stale(job, now=now):
            await _mark_geo_recalc_job_stale(job, now=now)
            continue
        return job
    return None


async def _get_latest_geo_recalc_job() -> Job | None:
    jobs = (
        await Job.find({"job_type": GEO_COVERAGE_JOB_TYPE})
        .sort("-created_at")
        .limit(1)
        .to_list()
    )
    return jobs[0] if jobs else None


async def _update_geo_job(
    job: Job | None,
    *,
    status_value: str | None = None,
    stage: str | None = None,
    progress: float | None = None,
    message: str | None = None,
    error: str | None = None,
    metrics: dict[str, Any] | None = None,
    result: dict[str, Any] | None = None,
) -> None:
    if not job:
        return

    now = datetime.now(UTC)

    if status_value is not None:
        job.status = status_value
        if status_value == "running" and job.started_at is None:
            job.started_at = now
        if status_value in {"completed", "failed", "cancelled"}:
            job.completed_at = now

    if stage is not None:
        job.stage = stage
    if progress is not None:
        job.progress = max(0.0, min(float(progress), 100.0))
    if message is not None:
        job.message = message
    if error is not None:
        job.error = error
    if metrics is not None:
        job.metrics = metrics
    if result is not None:
        job.result = result

    job.updated_at = now
    await job.save()


async def _get_county_topology_payload() -> dict[str, Any]:
    document = await get_county_topology_document()
    if not document or "topology" not in document:
        msg = "County topology could not be loaded from database"
        raise RuntimeError(msg)
    return document


async def _get_state_feature_collection() -> dict[str, Any]:
    cache = await StateBoundaryCache.get("states_boundaries")
    if cache and cache.feature_collection:
        return cache.feature_collection

    topology_document = await _get_county_topology_payload()
    topology = topology_document["topology"]
    states_geojson = topojson_to_geojson(topology, "states")

    features = []
    for feature in states_geojson:
        state_fips = str(feature.get("id", "")).zfill(2)
        props = dict(feature.get("properties") or {})
        props["stateFips"] = state_fips
        props.setdefault("name", props.get("state") or "Unknown")
        features.append(
            {
                "type": "Feature",
                "id": state_fips,
                "properties": props,
                "geometry": feature.get("geometry"),
            }
        )

    feature_collection = {
        "type": "FeatureCollection",
        "features": features,
    }

    new_doc = StateBoundaryCache(
        feature_collection=feature_collection,
        source="county_topology.states",
        updated_at=datetime.now(UTC),
    )
    await new_doc.save()

    return feature_collection


def _build_query_index(geometries: list[Any]) -> dict[int, int]:
    return {id(geom): idx for idx, geom in enumerate(geometries)}


def _iter_tree_indexes(
    tree: STRtree,
    index_lookup: dict[int, int],
    candidate_count: int,
    query_geom: Any,
):
    for raw in tree.query(query_geom):
        try:
            idx = int(raw)
            if 0 <= idx < candidate_count:
                yield idx
                continue
        except (TypeError, ValueError):
            pass

        idx = index_lookup.get(id(raw))
        if idx is not None:
            yield idx


async def calculate_geo_coverage_task(
    *,
    job_id: str | None = None,
) -> None:
    """Background task to calculate county + city visit coverage."""
    job = await _resolve_job(job_id)

    logger.info("Starting full unified geo coverage calculation...")
    start_time = datetime.now(UTC)

    await _update_geo_job(
        job,
        status_value="running",
        stage="Loading boundaries",
        progress=2,
        message="Loading county and city boundaries...",
    )

    try:
        topology_document = await _get_county_topology_payload()
        topology = topology_document["topology"]

        counties_geojson = topojson_to_geojson(topology, "counties")

        state_names: dict[str, str] = {}
        for feature in topojson_to_geojson(topology, "states"):
            state_fips = _valid_state_fips(feature.get("id"))
            if state_fips:
                state_names[state_fips] = str(
                    (feature.get("properties") or {}).get("name") or "Unknown"
                )

        county_shapes = []
        county_fips = []
        county_totals_by_state: dict[str, int] = {}
        invalid_counties = 0

        for feature in counties_geojson:
            county_id = _county_fips(feature.get("id"))
            geom = _valid_boundary_geometry(feature.get("geometry"))
            if county_id is None or geom is None:
                invalid_counties += 1
                continue
            state_fips = county_id[:2]
            county_shapes.append(geom)
            county_fips.append(county_id)
            county_totals_by_state[state_fips] = (
                county_totals_by_state.get(state_fips, 0) + 1
            )

        county_tree = STRtree(county_shapes) if county_shapes else None
        county_index_lookup = _build_query_index(county_shapes)
        logger.info(
            "Geo coverage: loaded %d county polygons (%d invalid)",
            len(county_shapes),
            invalid_counties,
        )

        city_docs = await CityBoundary.find_all().to_list()
        city_shapes = []
        city_ids = []
        city_state_index: dict[str, str] = {}
        city_state_names: dict[str, str] = {}
        city_totals_by_state: dict[str, int] = {}
        invalid_cities = 0

        for city in city_docs:
            state_fips = _valid_state_fips(city.state_fips)
            geom = _valid_boundary_geometry(city.geometry)
            if state_fips is None or geom is None:
                invalid_cities += 1
                continue
            city_shapes.append(geom)
            city_ids.append(city.id)
            city_state_index[city.id] = state_fips
            city_totals_by_state[state_fips] = (
                city_totals_by_state.get(state_fips, 0) + 1
            )
            city_state_names[state_fips] = city.state_name or city_state_names.get(
                state_fips,
                "Unknown",
            )

        city_tree = STRtree(city_shapes) if city_shapes else None
        city_index_lookup = _build_query_index(city_shapes)
        logger.info(
            "Geo coverage: loaded %d city polygons (%d invalid)",
            len(city_shapes),
            invalid_cities,
        )

        county_cache = await CountyVisitedCache.get("visited_counties")
        city_cache = await CityVisitedCache.get("visited_cities")

        if job:
            metadata = dict(job.metadata or {})
            metadata["mode"] = "full"
            job.metadata = metadata
            await job.save()

        county_visits: dict[str, dict[str, datetime | None]] = {}
        county_stops: dict[str, dict[str, datetime | None]] = {}
        city_visits: dict[str, dict[str, datetime | None]] = {}
        city_stops: dict[str, dict[str, datetime | None]] = {}

        await _update_geo_job(
            job,
            stage="Scanning trips",
            progress=8,
            message="Scanning all trips for full rebuild...",
        )

        trip_query = _build_trip_query()
        total_trips = await Trip.find(trip_query).count()

        await _update_geo_job(
            job,
            stage="Processing trips",
            progress=12,
            message="Processing trip geometry and stop points...",
            metrics={
                "mode": "full",
                "processedTrips": 0,
                "totalTrips": total_trips,
                "visitedCounties": len(county_visits),
                "stoppedCounties": len(county_stops),
                "visitedCities": len(city_visits),
                "stoppedCities": len(city_stops),
            },
        )

        trips_cursor = Trip.find(trip_query)
        trips_analyzed = 0

        async for trip in trips_cursor:
            trips_analyzed += 1

            trip_start_time = parse_timestamp(trip.startTime)
            trip_end_time = parse_timestamp(trip.endTime)
            trip_time = trip_start_time or trip_end_time

            gps_data = _select_trip_geometry(trip)
            if not gps_data:
                continue

            try:
                trip_geom = shape(gps_data)

                _record_boundary_visits(
                    trip_geometry=trip_geom,
                    boundary_tree=county_tree,
                    boundary_index_lookup=county_index_lookup,
                    boundary_shapes=county_shapes,
                    boundary_ids=county_fips,
                    visit_map=county_visits,
                    visit_time=trip_time,
                )
                _record_boundary_visits(
                    trip_geometry=trip_geom,
                    boundary_tree=city_tree,
                    boundary_index_lookup=city_index_lookup,
                    boundary_shapes=city_shapes,
                    boundary_ids=city_ids,
                    visit_map=city_visits,
                    visit_time=trip_time,
                )

                for point, stop_time in _extract_stop_points(
                    gps_data,
                    trip_start_time,
                    trip_end_time,
                    trip_time,
                ):
                    if county_tree:
                        for idx in _iter_tree_indexes(
                            county_tree,
                            county_index_lookup,
                            len(county_shapes),
                            point,
                        ):
                            if county_shapes[idx].covers(point):
                                _record_visit(county_stops, county_fips[idx], stop_time)

                    if city_tree:
                        for idx in _iter_tree_indexes(
                            city_tree,
                            city_index_lookup,
                            len(city_shapes),
                            point,
                        ):
                            if city_shapes[idx].covers(point):
                                _record_visit(city_stops, city_ids[idx], stop_time)

            except Exception as exc:
                logger.warning(
                    "Geo coverage: error processing trip %s: %s",
                    trip.transactionId or "unknown",
                    exc,
                )

            if trips_analyzed % 100 == 0:
                progress = (
                    12
                    if total_trips <= 0
                    else 12 + (min(trips_analyzed, total_trips) / total_trips) * 78
                )
                metrics = {
                    "mode": "full",
                    "processedTrips": trips_analyzed,
                    "totalTrips": total_trips,
                    "visitedCounties": len(county_visits),
                    "stoppedCounties": len(county_stops),
                    "visitedCities": len(city_visits),
                    "stoppedCities": len(city_stops),
                }
                await _update_geo_job(
                    job,
                    stage="Processing trips",
                    progress=progress,
                    message=(
                        f"Processed {trips_analyzed:,} of {total_trips:,} trips..."
                        if total_trips > 0
                        else "Processing trips..."
                    ),
                    metrics=metrics,
                )
                logger.info(
                    "Geo coverage progress: %d/%d trips, %d counties, %d cities",
                    trips_analyzed,
                    total_trips,
                    len(county_visits),
                    len(city_visits),
                )

        valid_city_ids = set(city_ids)
        city_visits = {
            city_id: visits
            for city_id, visits in city_visits.items()
            if city_id in valid_city_ids
        }
        city_stops = {
            city_id: stops
            for city_id, stops in city_stops.items()
            if city_id in valid_city_ids
        }

        await _update_geo_job(
            job,
            stage="Saving cache",
            progress=94,
            message="Saving county and city cache documents...",
            metrics={
                "mode": "full",
                "processedTrips": trips_analyzed,
                "totalTrips": total_trips,
                "visitedCounties": len(county_visits),
                "stoppedCounties": len(county_stops),
                "visitedCities": len(city_visits),
                "stoppedCities": len(city_stops),
            },
        )

        counties_serializable = _serialize_visit_map(county_visits)
        stops_serializable = _serialize_stop_map(county_stops)
        cities_serializable = _serialize_visit_map(city_visits)
        city_stops_serializable = _serialize_stop_map(city_stops)

        county_state_rollups = {
            state_fips: {
                "stateFips": state_fips,
                "stateName": state_names.get(state_fips, "Unknown"),
                "total": total,
            }
            for state_fips, total in county_totals_by_state.items()
        }

        state_rollups: dict[str, dict[str, Any]] = {}
        for state_fips, total in city_totals_by_state.items():
            state_rollups[state_fips] = {
                "stateFips": state_fips,
                "stateName": city_state_names.get(state_fips, "Unknown"),
                "visited": 0,
                "stopped": 0,
                "total": total,
                "percent": 0.0,
                "firstVisit": None,
                "lastVisit": None,
                "firstStop": None,
                "lastStop": None,
            }

        for city_id, visits in city_visits.items():
            state_fips = city_state_index.get(city_id)
            if not state_fips:
                continue

            rollup = state_rollups.setdefault(
                state_fips,
                {
                    "stateFips": state_fips,
                    "stateName": city_state_names.get(state_fips, "Unknown"),
                    "visited": 0,
                    "stopped": 0,
                    "total": city_totals_by_state.get(state_fips, 0),
                    "percent": 0.0,
                    "firstVisit": None,
                    "lastVisit": None,
                    "firstStop": None,
                    "lastStop": None,
                },
            )
            rollup["visited"] += 1

            first_visit = visits.get("firstVisit")
            last_visit = visits.get("lastVisit")

            if first_visit and (
                rollup.get("firstVisit") is None or first_visit < rollup["firstVisit"]
            ):
                rollup["firstVisit"] = first_visit
            if last_visit and (
                rollup.get("lastVisit") is None or last_visit > rollup["lastVisit"]
            ):
                rollup["lastVisit"] = last_visit

        for city_id, stops in city_stops.items():
            state_fips = city_state_index.get(city_id)
            if not state_fips:
                continue

            rollup = state_rollups.setdefault(
                state_fips,
                {
                    "stateFips": state_fips,
                    "stateName": city_state_names.get(state_fips, "Unknown"),
                    "visited": 0,
                    "stopped": 0,
                    "total": city_totals_by_state.get(state_fips, 0),
                    "percent": 0.0,
                    "firstVisit": None,
                    "lastVisit": None,
                    "firstStop": None,
                    "lastStop": None,
                },
            )
            rollup["stopped"] += 1

            first_stop = stops.get("firstVisit")
            last_stop = stops.get("lastVisit")

            if first_stop and (
                rollup.get("firstStop") is None or first_stop < rollup["firstStop"]
            ):
                rollup["firstStop"] = first_stop
            if last_stop and (
                rollup.get("lastStop") is None or last_stop > rollup["lastStop"]
            ):
                rollup["lastStop"] = last_stop

        for rollup in state_rollups.values():
            total = int(rollup.get("total") or 0)
            visited = int(rollup.get("visited") or 0)
            rollup["percent"] = _percent(visited, total)
            rollup["firstVisit"] = serialize_datetime(rollup.get("firstVisit"))
            rollup["lastVisit"] = serialize_datetime(rollup.get("lastVisit"))
            rollup["firstStop"] = serialize_datetime(rollup.get("firstStop"))
            rollup["lastStop"] = serialize_datetime(rollup.get("lastStop"))

        now = datetime.now(UTC)
        duration_seconds = (now - start_time).total_seconds()

        if county_cache:
            county_cache.counties = counties_serializable
            county_cache.stopped_counties = stops_serializable
            county_cache.state_rollups = county_state_rollups
            county_cache.total_counties = len(county_shapes)
            county_cache.trips_analyzed = trips_analyzed
            county_cache.updated_at = now
            county_cache.calculation_time_seconds = duration_seconds
            county_cache.last_job_id = str(job.id) if job else None
            await county_cache.save()
        else:
            await CountyVisitedCache(
                counties=counties_serializable,
                stopped_counties=stops_serializable,
                state_rollups=county_state_rollups,
                total_counties=len(county_shapes),
                trips_analyzed=trips_analyzed,
                updated_at=now,
                calculation_time_seconds=duration_seconds,
                last_job_id=str(job.id) if job else None,
            ).insert()

        if city_cache:
            city_cache.cities = cities_serializable
            city_cache.stopped_cities = city_stops_serializable
            city_cache.state_rollups = state_rollups
            city_cache.total_visited = len(cities_serializable)
            city_cache.total_stopped = len(city_stops_serializable)
            city_cache.total_cities = len(city_shapes)
            city_cache.trips_analyzed = trips_analyzed
            city_cache.updated_at = now
            city_cache.calculation_time_seconds = duration_seconds
            city_cache.last_job_id = str(job.id) if job else None
            await city_cache.save()
        else:
            await CityVisitedCache(
                cities=cities_serializable,
                stopped_cities=city_stops_serializable,
                state_rollups=state_rollups,
                total_visited=len(cities_serializable),
                total_stopped=len(city_stops_serializable),
                total_cities=len(city_shapes),
                trips_analyzed=trips_analyzed,
                updated_at=now,
                calculation_time_seconds=duration_seconds,
                last_job_id=str(job.id) if job else None,
            ).insert()

        result = {
            "mode": "full",
            "processedTrips": trips_analyzed,
            "totalTrips": total_trips,
            "visitedCounties": len(counties_serializable),
            "stoppedCounties": len(stops_serializable),
            "visitedCities": len(cities_serializable),
            "stoppedCities": len(city_stops_serializable),
            "durationSeconds": round(duration_seconds, 2),
        }

        await _update_geo_job(
            job,
            status_value="completed",
            stage="Completed",
            progress=100,
            message=(
                f"Region Explorer cache rebuild complete: {trips_analyzed:,} trips processed."
            ),
            metrics={
                "mode": "full",
                "processedTrips": trips_analyzed,
                "totalTrips": total_trips,
                "visitedCounties": len(counties_serializable),
                "stoppedCounties": len(stops_serializable),
                "visitedCities": len(cities_serializable),
                "stoppedCities": len(city_stops_serializable),
            },
            result=result,
        )

        logger.info(
            "Geo coverage calculation complete: %d counties, %d county stops, %d cities, %d city stops, %d/%d trips, %.1fs",
            len(counties_serializable),
            len(stops_serializable),
            len(cities_serializable),
            len(city_stops_serializable),
            trips_analyzed,
            total_trips,
            duration_seconds,
        )

    except Exception as exc:
        logger.exception("Error in unified geo coverage calculation task")
        await _update_geo_job(
            job,
            status_value="failed",
            stage="Failed",
            progress=100,
            message="Region Explorer cache rebuild failed.",
            error=str(exc),
        )


async def get_summary() -> dict[str, Any]:
    county_cache = await CountyVisitedCache.get("visited_counties")
    city_cache = await CityVisitedCache.get("visited_cities")

    county_visits = county_cache.counties if county_cache else {}
    county_stops = county_cache.stopped_counties if county_cache else {}

    city_state_totals: dict[str, dict[str, Any]] = {}
    if city_cache and city_cache.state_rollups:
        for state_fips, rollup in city_cache.state_rollups.items():
            normalized = _valid_state_fips(state_fips)
            if normalized is None or not isinstance(rollup, dict):
                continue
            city_state_totals[normalized] = {
                "name": str(rollup.get("stateName") or "Unknown"),
                "total": int(rollup.get("total") or 0),
                "visited": int(rollup.get("visited") or 0),
                "stopped": int(rollup.get("stopped") or 0),
                "firstVisit": rollup.get("firstVisit"),
                "lastVisit": rollup.get("lastVisit"),
                "firstStop": rollup.get("firstStop"),
                "lastStop": rollup.get("lastStop"),
            }

    county_rollup: dict[str, dict[str, Any]] = {}
    if county_cache and county_cache.state_rollups:
        for state_fips, rollup in county_cache.state_rollups.items():
            normalized = _valid_state_fips(state_fips)
            if normalized is None or not isinstance(rollup, dict):
                continue
            county_rollup[normalized] = {
                "name": rollup.get("stateName") or "Unknown",
                "total": int(rollup.get("total") or 0),
                "visited": 0,
                "firstVisit": None,
                "lastVisit": None,
            }

    for county_fips, visits in county_visits.items():
        normalized_county_fips = _county_fips(county_fips)
        if normalized_county_fips is None:
            continue
        state_fips = normalized_county_fips[:2]
        if state_fips not in county_rollup:
            county_rollup[state_fips] = {
                "name": "Unknown",
                "total": 0,
                "visited": 0,
                "firstVisit": None,
                "lastVisit": None,
            }

        entry = county_rollup[state_fips]
        entry["visited"] += 1

        first_visit = (
            parse_timestamp(visits.get("firstVisit"))
            if isinstance(visits, dict)
            else None
        )
        last_visit = (
            parse_timestamp(visits.get("lastVisit"))
            if isinstance(visits, dict)
            else None
        )

        if first_visit and (
            entry.get("firstVisit") is None or first_visit < entry["firstVisit"]
        ):
            entry["firstVisit"] = first_visit
        if last_visit and (
            entry.get("lastVisit") is None or last_visit > entry["lastVisit"]
        ):
            entry["lastVisit"] = last_visit

    state_keys = sorted(set(county_rollup.keys()) | set(city_state_totals.keys()))
    states = []
    for state_fips in state_keys:
        county_entry = county_rollup.get(
            state_fips,
            {
                "name": "Unknown",
                "total": 0,
                "visited": 0,
                "firstVisit": None,
                "lastVisit": None,
            },
        )
        city_entry = city_state_totals.get(
            state_fips,
            {
                "name": county_entry.get("name") or "Unknown",
                "total": 0,
                "visited": 0,
                "stopped": 0,
                "firstVisit": None,
                "lastVisit": None,
                "firstStop": None,
                "lastStop": None,
            },
        )

        county_total = int(county_entry.get("total") or 0)
        county_visited = int(county_entry.get("visited") or 0)
        city_total = int(city_entry.get("total") or 0)
        city_visited = int(city_entry.get("visited") or 0)
        city_stopped = int(city_entry.get("stopped") or 0)

        states.append(
            {
                "stateFips": state_fips,
                "stateName": county_entry.get("name")
                or city_entry.get("name")
                or "Unknown",
                "county": {
                    "visited": county_visited,
                    "total": county_total,
                    "percent": _percent(county_visited, county_total),
                    "firstVisit": serialize_datetime(county_entry.get("firstVisit")),
                    "lastVisit": serialize_datetime(county_entry.get("lastVisit")),
                },
                "city": {
                    "visited": city_visited,
                    "stopped": city_stopped,
                    "total": city_total,
                    "percent": _percent(city_visited, city_total),
                    "firstVisit": city_entry.get("firstVisit"),
                    "lastVisit": city_entry.get("lastVisit"),
                    "firstStop": city_entry.get("firstStop"),
                    "lastStop": city_entry.get("lastStop"),
                },
            }
        )

    states.sort(key=lambda item: item["stateName"])

    county_total = sum(entry["total"] for entry in county_rollup.values())
    county_visited = len(county_visits)
    county_stopped = len(county_stops)

    state_total = len([entry for entry in county_rollup.values() if entry["total"] > 0])
    state_visited = len(
        [entry for entry in county_rollup.values() if entry["visited"] > 0]
    )

    city_total = sum(
        int(entry.get("total") or 0) for entry in city_state_totals.values()
    )
    city_visited = sum(
        int(entry.get("visited") or 0) for entry in city_state_totals.values()
    )
    city_stopped = sum(
        int(entry.get("stopped") or 0) for entry in city_state_totals.values()
    )

    return {
        "success": True,
        "levels": {
            "county": {
                "visited": county_visited,
                "total": county_total,
                "stopped": county_stopped,
                "percent": _percent(county_visited, county_total),
            },
            "state": {
                "visited": state_visited,
                "total": state_total,
                "percent": _percent(state_visited, state_total),
            },
            "city": {
                "visited": city_visited,
                "stopped": city_stopped,
                "total": city_total,
                "percent": _percent(city_visited, city_total),
            },
        },
        "states": states,
        "lastUpdated": max(
            [
                dt
                for dt in [
                    county_cache.updated_at if county_cache else None,
                    city_cache.updated_at if city_cache else None,
                ]
                if dt is not None
            ],
            default=None,
        ),
    }


async def get_topology(
    level: Literal["county", "state", "city"],
    state_fips: str | None = None,
) -> dict[str, Any]:
    if level == "county":
        document = await _get_county_topology_payload()
        return {
            "success": True,
            "level": "county",
            "projection": document.get("projection"),
            "source": document.get("source"),
            "updatedAt": document.get("updated_at"),
            "topology": document.get("topology"),
        }

    if level == "state":
        feature_collection = await _get_state_feature_collection()
        return {
            "success": True,
            "level": "state",
            "featureCollection": feature_collection,
        }

    if level == "city":
        normalized_fips = _valid_state_fips(state_fips)
        if normalized_fips is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="stateFips is required when level=city",
            )

        cities = (
            await CityBoundary.find(CityBoundary.state_fips == normalized_fips)
            .sort("name")
            .to_list()
        )

        features = []
        for city in cities:
            geom = _valid_boundary_geometry(city.geometry)
            if geom is None:
                continue
            features.append(
                {
                    "type": "Feature",
                    "id": city.id,
                    "properties": {
                        "cityId": city.id,
                        "name": city.name,
                        "stateFips": city.state_fips,
                        "stateName": city.state_name,
                        "classfp": city.classfp,
                    },
                    "geometry": geom.__geo_interface__,
                }
            )

        return {
            "success": True,
            "level": "city",
            "stateFips": normalized_fips,
            "featureCollection": {
                "type": "FeatureCollection",
                "features": features,
            },
        }

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unsupported level '{level}'",
    )


async def get_visits(
    level: Literal["county", "city"],
    state_fips: str | None = None,
) -> dict[str, Any]:
    if level == "county":
        cache = await CountyVisitedCache.get("visited_counties")
        if not cache:
            return {
                "success": True,
                "level": "county",
                "cached": False,
                "visits": {},
                "stopped": {},
                "totalVisited": 0,
                "totalStopped": 0,
                "lastUpdated": None,
            }

        return {
            "success": True,
            "level": "county",
            "cached": True,
            "visits": cache.counties or {},
            "stopped": cache.stopped_counties or {},
            "totalVisited": len(cache.counties or {}),
            "totalStopped": len(cache.stopped_counties or {}),
            "lastUpdated": cache.updated_at,
            "tripsAnalyzed": cache.trips_analyzed or 0,
        }

    if level == "city":
        cache = await CityVisitedCache.get("visited_cities")
        if not cache:
            return {
                "success": True,
                "level": "city",
                "cached": False,
                "visits": {},
                "stopped": {},
                "totalVisited": 0,
                "totalStopped": 0,
                "lastUpdated": None,
            }

        visits = cache.cities or {}
        stops = cache.stopped_cities or {}
        normalized_fips = _valid_state_fips(state_fips)
        if normalized_fips:
            city_ids = {
                city.id
                for city in await CityBoundary.find(
                    CityBoundary.state_fips == normalized_fips
                ).to_list()
            }
            visits = {
                city_id: value
                for city_id, value in visits.items()
                if city_id in city_ids
            }
            stops = {
                city_id: value
                for city_id, value in stops.items()
                if city_id in city_ids
            }

        return {
            "success": True,
            "level": "city",
            "cached": True,
            "visits": visits,
            "stopped": stops,
            "totalVisited": len(visits),
            "totalStopped": len(stops),
            "lastUpdated": cache.updated_at,
            "tripsAnalyzed": cache.trips_analyzed or 0,
        }

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unsupported level '{level}'",
    )


def _descending_activity_sort_key(
    row: dict[str, Any],
    field: str,
) -> tuple[bool, float, str]:
    """Sort dated activity newest-first while keeping missing values last."""
    activity_at = parse_timestamp(row.get(field))
    return (
        activity_at is None,
        -activity_at.timestamp() if activity_at is not None else 0.0,
        str(row.get("name") or "").lower(),
    )


async def list_cities(
    *,
    state_fips: str,
    status_filter: Literal[
        "all",
        "driven",
        "stopped",
        "both",
        "visited",
        "unvisited",
    ] = "all",
    q: str | None = None,
    sort: str = "name",
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    normalized_fips = _valid_state_fips(state_fips)
    if normalized_fips is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="stateFips is required",
        )

    page = max(page, 1)
    page_size = max(page_size, 1)
    page_size = min(page_size, 200)

    cities = (
        await CityBoundary.find(CityBoundary.state_fips == normalized_fips)
        .sort("name")
        .to_list()
    )

    cache = await CityVisitedCache.get("visited_cities")
    visits = cache.cities if cache else {}
    stops = cache.stopped_cities if cache else {}

    rows = []
    query = (q or "").strip().lower()
    for city in cities:
        if _valid_boundary_geometry(city.geometry) is None:
            continue
        visit = visits.get(city.id)
        stop = stops.get(city.id)
        visited = visit is not None
        stopped = stop is not None
        first_visit = visit.get("firstVisit") if isinstance(visit, dict) else None
        last_visit = visit.get("lastVisit") if isinstance(visit, dict) else None
        first_stop = stop.get("firstStop") if isinstance(stop, dict) else None
        last_stop = stop.get("lastStop") if isinstance(stop, dict) else None

        if status_filter in {"visited", "driven"} and not visited:
            continue
        if status_filter == "stopped" and not stopped:
            continue
        if status_filter == "both" and not (visited and stopped):
            continue
        if status_filter == "unvisited" and (visited or stopped):
            continue
        if query and query not in city.name.lower():
            continue

        rows.append(
            {
                "cityId": city.id,
                "name": city.name,
                "stateFips": city.state_fips,
                "stateName": city.state_name,
                "visited": visited,
                "stopped": stopped,
                "firstVisit": first_visit,
                "lastVisit": last_visit,
                "firstStop": first_stop,
                "lastStop": last_stop,
                "bbox": city.bbox,
                "centroid": city.centroid,
            }
        )

    if sort in {"visited-desc", "driven_first", "visited_first"}:
        rows.sort(key=lambda row: (not row["visited"], row["name"].lower()))
    elif sort in {"visited-asc", "unvisited_first"}:
        rows.sort(key=lambda row: (row["visited"], row["name"].lower()))
    elif sort in {"stopped-desc", "stopped_first"}:
        rows.sort(
            key=lambda row: (
                not row["stopped"],
                not row["visited"],
                row["name"].lower(),
            )
        )
    elif sort == "activity_first":
        rows.sort(
            key=lambda row: (
                (
                    0
                    if row["stopped"] and row["visited"]
                    else 1
                    if row["stopped"]
                    else 2
                    if row["visited"]
                    else 3
                ),
                row["name"].lower(),
            )
        )
    elif sort == "last-stop-desc":
        rows.sort(key=lambda row: _descending_activity_sort_key(row, "lastStop"))
    elif sort == "first-visit-desc":
        rows.sort(key=lambda row: _descending_activity_sort_key(row, "firstVisit"))
    elif sort == "last-visit-desc":
        rows.sort(key=lambda row: _descending_activity_sort_key(row, "lastVisit"))
    else:
        rows.sort(key=lambda row: row["name"].lower())

    total = len(rows)
    start = (page - 1) * page_size
    end = start + page_size
    paged_rows = rows[start:end]

    return {
        "success": True,
        "stateFips": normalized_fips,
        "cities": paged_rows,
        "pagination": {
            "page": page,
            "pageSize": page_size,
            "total": total,
            "totalPages": (total + page_size - 1) // page_size,
        },
    }


async def recalculate(
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    active_job = await _get_active_geo_recalc_job()
    if active_job:
        return {
            "success": True,
            "alreadyRunning": True,
            "message": "A Region Explorer cache rebuild is already running.",
            "job": _serialize_job(active_job),
            "jobId": str(active_job.id),
            "mode": "full",
        }

    now = datetime.now(UTC)

    job = Job(
        job_type=GEO_COVERAGE_JOB_TYPE,
        status="pending",
        stage="Queued",
        progress=0.0,
        message="Queued full Region Explorer cache rebuild...",
        created_at=now,
        updated_at=now,
        metadata={
            "mode": "full",
        },
        metrics={
            "mode": "full",
            "processedTrips": 0,
            "totalTrips": 0,
            "visitedCounties": 0,
            "stoppedCounties": 0,
            "visitedCities": 0,
            "stoppedCities": 0,
        },
    )
    await job.insert()

    background_tasks.add_task(
        calculate_geo_coverage_task,
        job_id=str(job.id),
    )
    return {
        "success": True,
        "alreadyRunning": False,
        "message": "Region Explorer cache rebuild started in the background.",
        "job": _serialize_job(job),
        "jobId": str(job.id),
        "mode": "full",
    }


async def run_scheduled_recalculate() -> dict[str, Any]:
    """Run Region Explorer cache rebuild from scheduled/background task context."""
    active_job = await _get_active_geo_recalc_job()
    if active_job:
        return {
            "status": "skipped",
            "reason": "already_running",
            "message": "Region Explorer cache rebuild is already running.",
            "job_id": str(active_job.id),
            "mode": "full",
        }

    now = datetime.now(UTC)
    job = Job(
        job_type=GEO_COVERAGE_JOB_TYPE,
        status="pending",
        stage="Queued",
        progress=0.0,
        message="Queued scheduled full Region Explorer cache rebuild...",
        created_at=now,
        updated_at=now,
        metadata={
            "mode": "full",
            "trigger": "scheduled",
        },
        metrics={
            "mode": "full",
            "processedTrips": 0,
            "totalTrips": 0,
            "visitedCounties": 0,
            "stoppedCounties": 0,
            "visitedCities": 0,
            "stoppedCities": 0,
        },
    )
    await job.insert()

    await calculate_geo_coverage_task(job_id=str(job.id))

    finished = await _resolve_job(str(job.id))
    if not finished:
        msg = "Scheduled geo coverage job could not be reloaded after execution."
        raise RuntimeError(msg)

    if finished.status == "completed":
        return {
            "status": "success",
            "job_id": str(finished.id),
            "mode": "full",
            "message": finished.message or "Region Explorer cache rebuild completed.",
            "result": finished.result or {},
        }

    if finished.status == "failed":
        msg = (
            finished.error
            or finished.message
            or "Region Explorer cache rebuild failed."
        )
        raise RuntimeError(msg)

    msg = f"Scheduled geo coverage job ended in unexpected status '{finished.status}'."
    raise RuntimeError(msg)


async def get_cache_status() -> dict[str, Any]:
    county_cache = await CountyVisitedCache.get("visited_counties")
    city_cache = await CityVisitedCache.get("visited_cities")
    active_job = await _get_active_geo_recalc_job()
    latest_job = await _get_latest_geo_recalc_job()

    last_updated_candidates = [
        county_cache.updated_at if county_cache else None,
        city_cache.updated_at if city_cache else None,
    ]
    last_updated = max((dt for dt in last_updated_candidates if dt), default=None)

    return {
        "success": True,
        "county": {
            "cached": county_cache is not None,
            "totalVisited": len(county_cache.counties or {}) if county_cache else 0,
            "totalStopped": (
                len(county_cache.stopped_counties or {}) if county_cache else 0
            ),
            "totalCounties": county_cache.total_counties if county_cache else 0,
            "tripsAnalyzed": county_cache.trips_analyzed if county_cache else 0,
        },
        "city": {
            "cached": city_cache is not None,
            "totalVisited": city_cache.total_visited if city_cache else 0,
            "totalStopped": (city_cache.total_stopped if city_cache else 0),
            "totalCities": city_cache.total_cities if city_cache else 0,
            "tripsAnalyzed": city_cache.trips_analyzed if city_cache else 0,
        },
        "cached": county_cache is not None and city_cache is not None,
        "lastUpdated": last_updated,
        "isRecalculating": active_job is not None,
        "recalculation": {
            "active": active_job is not None,
            "job": _serialize_job(active_job or latest_job),
        },
    }


class GeoCoverageService:
    """Service wrapper for unified geo coverage endpoints."""

    @staticmethod
    async def get_summary() -> dict[str, Any]:
        return await get_summary()

    @staticmethod
    async def get_topology(
        level: Literal["county", "state", "city"],
        state_fips: str | None = None,
    ) -> dict[str, Any]:
        return await get_topology(level, state_fips)

    @staticmethod
    async def get_visits(
        level: Literal["county", "city"],
        state_fips: str | None = None,
    ) -> dict[str, Any]:
        return await get_visits(level, state_fips)

    @staticmethod
    async def list_cities(
        *,
        state_fips: str,
        status_filter: Literal[
            "all",
            "driven",
            "stopped",
            "both",
            "visited",
            "unvisited",
        ] = "all",
        q: str | None = None,
        sort: str = "name",
        page: int = 1,
        page_size: int = 100,
    ) -> dict[str, Any]:
        return await list_cities(
            state_fips=state_fips,
            status_filter=status_filter,
            q=q,
            sort=sort,
            page=page,
            page_size=page_size,
        )

    @staticmethod
    async def recalculate(
        background_tasks: BackgroundTasks,
    ) -> dict[str, Any]:
        return await recalculate(background_tasks)

    @staticmethod
    async def run_scheduled_recalculate() -> dict[str, Any]:
        return await run_scheduled_recalculate()

    @staticmethod
    async def get_cache_status() -> dict[str, Any]:
        return await get_cache_status()


__all__ = [
    "GeoCoverageService",
    "calculate_geo_coverage_task",
    "run_scheduled_recalculate",
]
