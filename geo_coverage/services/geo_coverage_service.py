"""Unified county/state/city coverage services."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import BackgroundTasks, HTTPException, status
from shapely import STRtree
from shapely.geometry import Point, shape

from core.date_utils import parse_timestamp
from core.trip_source_policy import enforce_bouncie_source
from county.services.county_data_service import get_county_topology_document
from county.services.county_service import topojson_to_geojson
from db.models import (
    CityBoundary,
    CityVisitedCache,
    CountyVisitedCache,
    StateBoundaryCache,
    Trip,
)

logger = logging.getLogger(__name__)

try:
    from shapely.validation import make_valid as _make_valid
except Exception:
    try:
        from shapely import make_valid as _make_valid
    except Exception:
        _make_valid = None


def _normalize_geometry(geom):
    if geom.is_empty:
        return None
    if geom.is_valid:
        return geom
    fixed = _make_valid(geom) if _make_valid else geom.buffer(0)
    if fixed.is_empty:
        return None
    if not fixed.is_valid:
        return None
    return fixed


def _coerce_point_coords(coords: Any) -> list[float] | None:
    if not isinstance(coords, list | tuple) or len(coords) < 2:
        return None
    try:
        return [float(coords[0]), float(coords[1])]
    except (TypeError, ValueError):
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
    if visit_map[key]["firstVisit"] is None or visit_time < visit_map[key]["firstVisit"]:
        visit_map[key]["firstVisit"] = visit_time
    if visit_map[key]["lastVisit"] is None or visit_time > visit_map[key]["lastVisit"]:
        visit_map[key]["lastVisit"] = visit_time


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
        point_coords = _coerce_point_coords(coords)
        if point_coords:
            stop_points.append((Point(point_coords[0], point_coords[1]), default_time))
        return stop_points

    if gps_type == "LineString" and isinstance(coords, list) and coords:
        start_coords = _coerce_point_coords(coords[0])
        end_coords = _coerce_point_coords(coords[-1])

        if start_coords:
            start_time = trip_start_time or default_time
            stop_points.append((Point(start_coords[0], start_coords[1]), start_time))

        if end_coords and (not start_coords or end_coords != start_coords):
            end_time = trip_end_time or default_time
            stop_points.append((Point(end_coords[0], end_coords[1]), end_time))

    return stop_points


def _to_iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _percent(visited: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((visited / total) * 100.0, 2)


def _state_fips(value: str | None) -> str:
    raw = str(value or "").strip()
    if raw.isdigit() and len(raw) <= 2:
        return raw.zfill(2)
    return raw


async def _get_county_topology_payload() -> dict[str, Any]:
    document = await get_county_topology_document()
    if not document or "topology" not in document:
        msg = "County topology could not be loaded from database"
        raise RuntimeError(msg)
    return document


async def _get_county_state_totals() -> dict[str, dict[str, Any]]:
    topology_document = await _get_county_topology_payload()
    topology = topology_document["topology"]

    counties_geojson = topojson_to_geojson(topology, "counties")
    states_geojson = topojson_to_geojson(topology, "states")

    state_names: dict[str, str] = {}
    for feature in states_geojson:
        state_fips = str(feature.get("id", "")).zfill(2)
        state_name = str((feature.get("properties") or {}).get("name") or "Unknown")
        state_names[state_fips] = state_name

    totals: dict[str, dict[str, Any]] = {}
    for feature in counties_geojson:
        county_fips = str(feature.get("id", "")).zfill(5)
        state_fips = county_fips[:2]
        if state_fips not in totals:
            totals[state_fips] = {
                "name": state_names.get(state_fips, "Unknown"),
                "total": 0,
            }
        totals[state_fips]["total"] += 1

    return totals


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


async def calculate_geo_coverage_task() -> None:
    """Background task to calculate county + city visit coverage."""

    logger.info("Starting unified geo coverage calculation...")
    start_time = datetime.now(UTC)

    try:
        topology_document = await _get_county_topology_payload()
        topology = topology_document["topology"]

        counties_geojson = topojson_to_geojson(topology, "counties")

        county_shapes = []
        county_fips = []
        invalid_counties = 0

        for feature in counties_geojson:
            try:
                geom = shape(feature["geometry"])
                geom = _normalize_geometry(geom)
                if not geom:
                    invalid_counties += 1
                    continue
                county_shapes.append(geom)
                county_fips.append(str(feature.get("id", "")).zfill(5))
            except Exception:
                invalid_counties += 1

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
            state_fips = _state_fips(city.state_fips)
            if not state_fips:
                invalid_cities += 1
                continue

            city_totals_by_state[state_fips] = city_totals_by_state.get(state_fips, 0) + 1
            city_state_names[state_fips] = city.state_name or city_state_names.get(
                state_fips,
                "Unknown",
            )

            try:
                geom = shape(city.geometry)
                geom = _normalize_geometry(geom)
                if not geom:
                    invalid_cities += 1
                    continue
                city_shapes.append(geom)
                city_ids.append(city.id)
                city_state_index[city.id] = state_fips
            except Exception:
                invalid_cities += 1

        city_tree = STRtree(city_shapes) if city_shapes else None
        city_index_lookup = _build_query_index(city_shapes)
        logger.info(
            "Geo coverage: loaded %d city polygons (%d invalid)",
            len(city_shapes),
            invalid_cities,
        )

        county_visits: dict[str, dict[str, datetime | None]] = {}
        county_stops: dict[str, dict[str, datetime | None]] = {}
        city_visits: dict[str, dict[str, datetime | None]] = {}

        trips_cursor = Trip.find(
            enforce_bouncie_source(
                {
                    "isInvalid": {"$ne": True},
                    "$or": [
                        {"gps.type": {"$in": ["LineString", "Point"]}},
                        {"matchedGps.type": {"$in": ["LineString", "Point"]}},
                    ],
                }
            )
        )

        trips_analyzed = 0

        async for trip in trips_cursor:
            trips_analyzed += 1

            trip_start_time = parse_timestamp(trip.startTime)
            trip_end_time = parse_timestamp(trip.endTime)
            trip_time = trip_start_time or trip_end_time

            gps_data = trip.matchedGps or trip.gps
            if not gps_data or gps_data.get("type") not in {"LineString", "Point"}:
                continue

            try:
                if gps_data.get("type") == "LineString":
                    trip_geom = shape(gps_data)

                    if county_tree:
                        for idx in _iter_tree_indexes(
                            county_tree,
                            county_index_lookup,
                            len(county_shapes),
                            trip_geom,
                        ):
                            if county_shapes[idx].intersects(trip_geom):
                                fips = county_fips[idx]
                                _record_visit(county_visits, fips, trip_time)

                    if city_tree:
                        for idx in _iter_tree_indexes(
                            city_tree,
                            city_index_lookup,
                            len(city_shapes),
                            trip_geom,
                        ):
                            if city_shapes[idx].intersects(trip_geom):
                                city_id = city_ids[idx]
                                _record_visit(city_visits, city_id, trip_time)

                for point, stop_time in _extract_stop_points(
                    gps_data,
                    trip_start_time,
                    trip_end_time,
                    trip_time,
                ):
                    if not county_tree:
                        continue
                    for idx in _iter_tree_indexes(
                        county_tree,
                        county_index_lookup,
                        len(county_shapes),
                        point,
                    ):
                        if county_shapes[idx].covers(point):
                            _record_visit(county_stops, county_fips[idx], stop_time)

            except Exception as exc:
                logger.warning(
                    "Geo coverage: error processing trip %s: %s",
                    trip.transactionId or "unknown",
                    exc,
                )

            if trips_analyzed % 500 == 0:
                logger.info(
                    "Geo coverage progress: %d trips, %d counties, %d cities",
                    trips_analyzed,
                    len(county_visits),
                    len(city_visits),
                )

        counties_serializable = {
            fips: {
                "firstVisit": _to_iso(visits.get("firstVisit")),
                "lastVisit": _to_iso(visits.get("lastVisit")),
            }
            for fips, visits in county_visits.items()
        }

        stops_serializable = {
            fips: {
                "firstStop": _to_iso(stops.get("firstVisit")),
                "lastStop": _to_iso(stops.get("lastVisit")),
            }
            for fips, stops in county_stops.items()
        }

        cities_serializable = {
            city_id: {
                "firstVisit": _to_iso(visits.get("firstVisit")),
                "lastVisit": _to_iso(visits.get("lastVisit")),
            }
            for city_id, visits in city_visits.items()
        }

        state_rollups: dict[str, dict[str, Any]] = {}
        for state_fips, total in city_totals_by_state.items():
            state_rollups[state_fips] = {
                "stateFips": state_fips,
                "stateName": city_state_names.get(state_fips, "Unknown"),
                "visited": 0,
                "total": total,
                "percent": 0.0,
                "firstVisit": None,
                "lastVisit": None,
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
                    "total": city_totals_by_state.get(state_fips, 0),
                    "percent": 0.0,
                    "firstVisit": None,
                    "lastVisit": None,
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

        for state_fips, rollup in state_rollups.items():
            total = int(rollup.get("total") or 0)
            visited = int(rollup.get("visited") or 0)
            rollup["percent"] = _percent(visited, total)
            rollup["firstVisit"] = _to_iso(rollup.get("firstVisit"))
            rollup["lastVisit"] = _to_iso(rollup.get("lastVisit"))

        now = datetime.now(UTC)

        county_cache = await CountyVisitedCache.get("visited_counties")
        if county_cache:
            county_cache.counties = counties_serializable
            county_cache.stopped_counties = stops_serializable
            county_cache.trips_analyzed = trips_analyzed
            county_cache.updated_at = now
            county_cache.calculation_time_seconds = (now - start_time).total_seconds()
            await county_cache.save()
        else:
            await CountyVisitedCache(
                counties=counties_serializable,
                stopped_counties=stops_serializable,
                trips_analyzed=trips_analyzed,
                updated_at=now,
                calculation_time_seconds=(now - start_time).total_seconds(),
            ).insert()

        city_cache = await CityVisitedCache.get("visited_cities")
        if city_cache:
            city_cache.cities = cities_serializable
            city_cache.state_rollups = state_rollups
            city_cache.total_visited = len(cities_serializable)
            city_cache.total_cities = len(city_docs)
            city_cache.trips_analyzed = trips_analyzed
            city_cache.updated_at = now
            city_cache.calculation_time_seconds = (now - start_time).total_seconds()
            await city_cache.save()
        else:
            await CityVisitedCache(
                cities=cities_serializable,
                state_rollups=state_rollups,
                total_visited=len(cities_serializable),
                total_cities=len(city_docs),
                trips_analyzed=trips_analyzed,
                updated_at=now,
                calculation_time_seconds=(now - start_time).total_seconds(),
            ).insert()

        logger.info(
            "Geo coverage calculation complete: %d counties, %d stops, %d cities, %d trips, %.1fs",
            len(counties_serializable),
            len(stops_serializable),
            len(cities_serializable),
            trips_analyzed,
            (datetime.now(UTC) - start_time).total_seconds(),
        )

    except Exception:
        logger.exception("Error in unified geo coverage calculation task")


async def get_summary() -> dict[str, Any]:
    county_cache = await CountyVisitedCache.get("visited_counties")
    city_cache = await CityVisitedCache.get("visited_cities")

    county_visits = county_cache.counties if county_cache else {}
    county_stops = county_cache.stopped_counties if county_cache else {}

    county_totals = await _get_county_state_totals()
    city_state_totals: dict[str, dict[str, Any]] = {}

    if city_cache and city_cache.state_rollups:
        for state_fips, rollup in city_cache.state_rollups.items():
            normalized = _state_fips(state_fips)
            city_state_totals[normalized] = {
                "name": str(rollup.get("stateName") or "Unknown"),
                "total": int(rollup.get("total") or 0),
                "visited": int(rollup.get("visited") or 0),
                "firstVisit": rollup.get("firstVisit"),
                "lastVisit": rollup.get("lastVisit"),
            }
    else:
        city_counts = await CityBoundary.aggregate(
            [
                {
                    "$group": {
                        "_id": "$state_fips",
                        "total": {"$sum": 1},
                        "state_name": {"$first": "$state_name"},
                    }
                }
            ]
        ).to_list()
        for row in city_counts:
            normalized = _state_fips(str(row.get("_id") or ""))
            city_state_totals[normalized] = {
                "name": str(row.get("state_name") or "Unknown"),
                "total": int(row.get("total") or 0),
                "visited": 0,
                "firstVisit": None,
                "lastVisit": None,
            }

    county_rollup: dict[str, dict[str, Any]] = {}
    for state_fips, totals in county_totals.items():
        county_rollup[state_fips] = {
            "name": totals.get("name") or "Unknown",
            "total": int(totals.get("total") or 0),
            "visited": 0,
            "firstVisit": None,
            "lastVisit": None,
        }

    for county_fips, visits in county_visits.items():
        state_fips = str(county_fips)[:2]
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

        first_visit = parse_timestamp(visits.get("firstVisit")) if isinstance(visits, dict) else None
        last_visit = parse_timestamp(visits.get("lastVisit")) if isinstance(visits, dict) else None

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
                "firstVisit": None,
                "lastVisit": None,
            },
        )

        county_total = int(county_entry.get("total") or 0)
        county_visited = int(county_entry.get("visited") or 0)
        city_total = int(city_entry.get("total") or 0)
        city_visited = int(city_entry.get("visited") or 0)

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
                    "firstVisit": _to_iso(county_entry.get("firstVisit")),
                    "lastVisit": _to_iso(county_entry.get("lastVisit")),
                },
                "city": {
                    "visited": city_visited,
                    "total": city_total,
                    "percent": _percent(city_visited, city_total),
                    "firstVisit": city_entry.get("firstVisit"),
                    "lastVisit": city_entry.get("lastVisit"),
                },
            }
        )

    states.sort(key=lambda item: item["stateName"])

    county_total = sum(entry["total"] for entry in county_rollup.values())
    county_visited = len(county_visits)
    county_stopped = len(county_stops)

    state_total = len([entry for entry in county_rollup.values() if entry["total"] > 0])
    state_visited = len([entry for entry in county_rollup.values() if entry["visited"] > 0])

    city_total = sum(int(entry.get("total") or 0) for entry in city_state_totals.values())
    city_visited = int(city_cache.total_visited if city_cache else 0)

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
        normalized_fips = _state_fips(state_fips)
        if not normalized_fips:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="stateFips is required when level=city",
            )

        cities = (
            await CityBoundary.find(CityBoundary.state_fips == normalized_fips)
            .sort("name")
            .to_list()
        )

        features = [
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
                "geometry": city.geometry,
            }
            for city in cities
            if city.geometry
        ]

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
                "totalVisited": 0,
                "lastUpdated": None,
            }

        visits = cache.cities or {}
        normalized_fips = _state_fips(state_fips)
        if normalized_fips:
            city_ids = {
                city.id
                for city in await CityBoundary.find(
                    CityBoundary.state_fips == normalized_fips
                ).to_list()
            }
            visits = {city_id: value for city_id, value in visits.items() if city_id in city_ids}

        return {
            "success": True,
            "level": "city",
            "cached": True,
            "visits": visits,
            "totalVisited": len(visits),
            "lastUpdated": cache.updated_at,
            "tripsAnalyzed": cache.trips_analyzed or 0,
        }

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unsupported level '{level}'",
    )


async def list_cities(
    *,
    state_fips: str,
    status_filter: Literal["all", "visited", "unvisited"] = "all",
    q: str | None = None,
    sort: str = "name",
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    normalized_fips = _state_fips(state_fips)
    if not normalized_fips:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="stateFips is required",
        )

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = 1
    if page_size > 200:
        page_size = 200

    cities = (
        await CityBoundary.find(CityBoundary.state_fips == normalized_fips)
        .sort("name")
        .to_list()
    )

    cache = await CityVisitedCache.get("visited_cities")
    visits = cache.cities if cache else {}

    rows = []
    query = (q or "").strip().lower()
    for city in cities:
        visit = visits.get(city.id)
        visited = visit is not None
        first_visit = visit.get("firstVisit") if isinstance(visit, dict) else None
        last_visit = visit.get("lastVisit") if isinstance(visit, dict) else None

        if status_filter == "visited" and not visited:
            continue
        if status_filter == "unvisited" and visited:
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
                "firstVisit": first_visit,
                "lastVisit": last_visit,
                "bbox": city.bbox,
                "centroid": city.centroid,
            }
        )

    if sort == "visited-desc":
        rows.sort(key=lambda row: (not row["visited"], row["name"].lower()))
    elif sort == "visited-asc":
        rows.sort(key=lambda row: (row["visited"], row["name"].lower()))
    elif sort == "first-visit-desc":
        rows.sort(
            key=lambda row: (
                row["firstVisit"] is None,
                row["firstVisit"] or "",
                row["name"].lower(),
            ),
            reverse=True,
        )
    elif sort == "last-visit-desc":
        rows.sort(
            key=lambda row: (
                row["lastVisit"] is None,
                row["lastVisit"] or "",
                row["name"].lower(),
            ),
            reverse=True,
        )
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


async def recalculate(background_tasks: BackgroundTasks) -> dict[str, Any]:
    background_tasks.add_task(calculate_geo_coverage_task)
    return {
        "success": True,
        "message": "Unified geo coverage recalculation started in background.",
    }


async def get_cache_status() -> dict[str, Any]:
    county_cache = await CountyVisitedCache.get("visited_counties")
    city_cache = await CityVisitedCache.get("visited_cities")

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
            "totalStopped": len(county_cache.stopped_counties or {}) if county_cache else 0,
            "tripsAnalyzed": county_cache.trips_analyzed if county_cache else 0,
        },
        "city": {
            "cached": city_cache is not None,
            "totalVisited": city_cache.total_visited if city_cache else 0,
            "totalCities": city_cache.total_cities if city_cache else 0,
            "tripsAnalyzed": city_cache.trips_analyzed if city_cache else 0,
        },
        "cached": county_cache is not None and city_cache is not None,
        "lastUpdated": last_updated,
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
        status_filter: Literal["all", "visited", "unvisited"] = "all",
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
    async def recalculate(background_tasks: BackgroundTasks) -> dict[str, Any]:
        return await recalculate(background_tasks)

    @staticmethod
    async def get_cache_status() -> dict[str, Any]:
        return await get_cache_status()


__all__ = ["GeoCoverageService", "calculate_geo_coverage_task"]
