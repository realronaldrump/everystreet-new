"""
County Map API.

Provides endpoints for county-level coverage visualization. Counties are
marked as visited if any trip geometry passes through them. Tracks first
and most recent visit dates for each county. Results are cached in
MongoDB for fast page loads.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks
from shapely import STRtree
from shapely.geometry import Point, shape

from county_data_service import get_county_topology_document
from date_utils import parse_timestamp
from db.models import CountyVisitedCache, Trip

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/counties", tags=["counties"])

try:
    from shapely.validation import make_valid as _make_valid
except Exception:
    try:
        from shapely import make_valid as _make_valid
    except Exception:
        _make_valid = None


@router.get("/topology")
async def get_county_topology(projection: str | None = None) -> dict[str, Any]:
    """
    Return county TopoJSON data stored in MongoDB.

    If the requested projection is not yet cached, it will be downloaded
    and stored.
    """

    try:
        document = await get_county_topology_document(projection)
        if not document:
            return {
                "success": False,
                "error": "County topology not available",
            }

        return {
            "success": True,
            "projection": document.get("projection"),
            "source": document.get("source"),
            "updatedAt": document.get("updated_at"),
            "topology": document.get("topology"),
        }
    except Exception as e:
        logger.exception("Error fetching county topology: %s", e)
        return {"success": False, "error": str(e)}


@router.get("/visited")
async def get_visited_counties() -> dict[str, Any]:
    """
    Get cached list of visited county FIPS codes with visit dates.

    Returns cached data if available, otherwise triggers a
    recalculation.
    """
    try:
        # Try to get cached data using Beanie
        cache = await CountyVisitedCache.get("visited_counties")

        if cache:
            stopped = cache.stopped_counties or {}
            return {
                "success": True,
                "counties": cache.counties or {},
                "stoppedCounties": stopped,
                "totalVisited": len(cache.counties or {}),
                "totalStopped": len(stopped),
                "lastUpdated": cache.updated_at,
                "totalTripsAnalyzed": cache.trips_analyzed or 0,
                "cached": True,
            }

        # No cache - return empty and suggest recalculation
        return {
            "success": True,
            "counties": {},
            "stoppedCounties": {},
            "totalVisited": 0,
            "totalStopped": 0,
            "lastUpdated": None,
            "cached": False,
            "message": "No cached data. Call POST /api/counties/recalculate to compute.",
        }

    except Exception as e:
        logger.exception("Error fetching visited counties: %s", e)
        return {
            "success": False,
            "error": str(e),
            "counties": {},
            "stoppedCounties": {},
            "totalVisited": 0,
            "totalStopped": 0,
        }


@router.post("/recalculate")
async def recalculate_visited_counties(
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """
    Trigger recalculation of visited counties.

    This performs geospatial intersection between trip geometries and
    county polygons. The calculation runs in the background.
    """
    try:
        # Start background calculation
        background_tasks.add_task(calculate_visited_counties_task)

        return {
            "success": True,
            "message": "Recalculation started in background. Refresh the page in a few moments.",
        }
    except Exception as e:
        logger.exception("Error starting recalculation: %s", e)
        return {
            "success": False,
            "error": str(e),
        }


async def calculate_visited_counties_task():
    """
    Background task to calculate which counties have been driven through.

    Tracks first visit date and most recent visit date for each county.
    """
    logger.info("Starting county visited calculation...")
    start_time = datetime.now(UTC)

    try:
        topology_document = await get_county_topology_document()
        if not topology_document or "topology" not in topology_document:
            msg = "County topology could not be loaded from database"
            raise RuntimeError(msg)
        topology = topology_document["topology"]

        # Convert TopoJSON to GeoJSON features
        counties_geojson = topojson_to_geojson(topology, "counties")

        logger.info("Loaded %d county polygons", len(counties_geojson))

        # Build spatial index of counties using shapely
        county_shapes = []
        county_fips = []
        invalid_counties = 0

        for feature in counties_geojson:
            try:
                geom = shape(feature["geometry"])
                geom = _normalize_county_geometry(geom)
                if not geom:
                    invalid_counties += 1
                    continue
                county_shapes.append(geom)
                # FIPS code is the feature id
                fips = str(feature.get("id", "")).zfill(5)
                county_fips.append(fips)
            except Exception as e:
                logger.warning("Invalid county geometry: %s", e)

        tree = STRtree(county_shapes)
        logger.info("Built spatial index for %d counties", len(county_shapes))
        if invalid_counties:
            logger.warning("Skipped %d invalid county geometries", invalid_counties)

        # Dictionary to track visit dates per county
        county_visits: dict[str, dict[str, datetime | None]] = {}
        county_stops: dict[str, dict[str, datetime | None]] = {}

        # Query all valid trips with GPS data using Beanie
        trips_cursor = Trip.find(
            {
                "isInvalid": {"$ne": True},
                "$or": [
                    {"gps.type": {"$in": ["LineString", "Point"]}},
                    {"matchedGps.type": {"$in": ["LineString", "Point"]}},
                ],
            },
        )

        trips_analyzed = 0

        async for trip in trips_cursor:
            trips_analyzed += 1

            # Get trip timestamps - access as Beanie document attributes
            trip_start_time = parse_timestamp(trip.startTime)
            trip_end_time = parse_timestamp(trip.endTime)
            trip_time = trip_start_time or trip_end_time

            # Prefer matched GPS if available
            gps_data = trip.matchedGps or trip.gps
            if not gps_data or gps_data.get("type") not in {"LineString", "Point"}:
                continue

            try:
                gps_type = gps_data.get("type")

                if gps_type == "LineString":
                    trip_geom = shape(gps_data)
                    # Find all counties this trip intersects
                    potential_matches = tree.query(trip_geom)
                    for idx in potential_matches:
                        if county_shapes[idx].intersects(trip_geom):
                            fips = county_fips[idx]
                            _record_visit(county_visits, fips, trip_time)

                stop_points = _extract_stop_points(
                    gps_data,
                    trip_start_time,
                    trip_end_time,
                    trip_time,
                )
                for point, stop_time in stop_points:
                    potential_matches = tree.query(point)
                    for idx in potential_matches:
                        if county_shapes[idx].covers(point):
                            fips = county_fips[idx]
                            _record_visit(county_stops, fips, stop_time)

            except Exception as e:
                logger.warning(
                    "Error processing trip %s: %s",
                    trip.transactionId or "unknown",
                    e,
                )

            # Log progress every 500 trips
            if trips_analyzed % 500 == 0:
                logger.info(
                    "Processed %d trips, found %d visited counties so far",
                    trips_analyzed,
                    len(county_visits),
                )

        # Convert datetime objects to ISO strings for JSON serialization
        counties_serializable = {}
        for fips, visits in county_visits.items():
            counties_serializable[fips] = {
                "firstVisit": (
                    visits["firstVisit"].isoformat() if visits["firstVisit"] else None
                ),
                "lastVisit": (
                    visits["lastVisit"].isoformat() if visits["lastVisit"] else None
                ),
            }

        stops_serializable = {}
        for fips, stops in county_stops.items():
            stops_serializable[fips] = {
                "firstStop": (
                    stops["firstVisit"].isoformat() if stops["firstVisit"] else None
                ),
                "lastStop": (
                    stops["lastVisit"].isoformat() if stops["lastVisit"] else None
                ),
            }

        # Save to cache using Beanie upsert pattern
        existing_cache = await CountyVisitedCache.get("visited_counties")
        if existing_cache:
            existing_cache.counties = counties_serializable
            existing_cache.stopped_counties = stops_serializable
            existing_cache.trips_analyzed = trips_analyzed
            existing_cache.updated_at = datetime.now(UTC)
            existing_cache.calculation_time_seconds = (
                datetime.now(UTC) - start_time
            ).total_seconds()
            await existing_cache.save()
        else:
            new_cache = CountyVisitedCache(
                counties=counties_serializable,
                stopped_counties=stops_serializable,
                trips_analyzed=trips_analyzed,
                updated_at=datetime.now(UTC),
                calculation_time_seconds=(
                    datetime.now(UTC) - start_time
                ).total_seconds(),
            )
            await new_cache.insert()

        logger.info(
            "County calculation complete: %d visited, %d stopped from %d trips in %.1f seconds",
            len(county_visits),
            len(county_stops),
            trips_analyzed,
            (datetime.now(UTC) - start_time).total_seconds(),
        )

    except Exception as e:
        logger.exception("Error in county calculation task: %s", e)


def topojson_to_geojson(topology: dict, object_name: str) -> list[dict]:
    """
    Convert TopoJSON to GeoJSON features.

    Simple implementation that handles the arc-based geometry encoding.
    """
    features = []

    if "objects" not in topology or object_name not in topology["objects"]:
        return features

    arcs = topology.get("arcs", [])
    transform_data = topology.get("transform")

    def decode_coordinates(arc: list) -> list:
        """Decode delta-encoded coordinates."""
        coords = []
        x, y = 0, 0

        for point in arc:
            x += point[0]
            y += point[1]

            if transform_data:
                # Apply transform: coord = coord * scale + translate
                scale = transform_data.get("scale", [1, 1])
                translate = transform_data.get("translate", [0, 0])
                lon = x * scale[0] + translate[0]
                lat = y * scale[1] + translate[1]
                coords.append([lon, lat])
            else:
                coords.append([x, y])

        return coords

    def decode_arc(arc_index: int) -> list:
        """Decode a single arc to coordinates."""
        if arc_index < 0:
            # Negative index means reverse the arc
            arc = arcs[~arc_index]
            coords = decode_coordinates(arc)
            return list(reversed(coords))
        arc = arcs[arc_index]
        return decode_coordinates(arc)

    def arcs_to_coordinates(arc_indices: list) -> list:
        """Convert arc indices to a coordinate ring."""
        coords = []
        for arc_idx in arc_indices:
            arc_coords = decode_arc(arc_idx)
            # Skip first point if we already have coords (it's shared with previous arc)
            if coords:
                coords.extend(arc_coords[1:])
            else:
                coords.extend(arc_coords)
        return coords

    obj = topology["objects"][object_name]
    geometries = obj.get("geometries", [])

    for geom in geometries:
        geom_type = geom.get("type")
        arcs_data = geom.get("arcs", [])

        try:
            if geom_type == "Polygon":
                rings = [arcs_to_coordinates(ring) for ring in arcs_data]
                feature = {
                    "type": "Feature",
                    "id": geom.get("id"),
                    "properties": geom.get("properties", {}),
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": rings,
                    },
                }
                features.append(feature)

            elif geom_type == "MultiPolygon":
                polygons = []
                for polygon_arcs in arcs_data:
                    rings = [arcs_to_coordinates(ring) for ring in polygon_arcs]
                    polygons.append(rings)
                feature = {
                    "type": "Feature",
                    "id": geom.get("id"),
                    "properties": geom.get("properties", {}),
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": polygons,
                    },
                }
                features.append(feature)

        except Exception as e:
            logger.warning("Error converting geometry: %s", e)

    return features


def _normalize_county_geometry(geom):
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


def _coerce_point_coords(coords):
    if not isinstance(coords, list | tuple) or len(coords) < 2:
        return None
    try:
        return [float(coords[0]), float(coords[1])]
    except (TypeError, ValueError):
        return None


def _extract_point_coords(geo_point: dict | None):
    if not geo_point or geo_point.get("type") != "Point":
        return None
    return _coerce_point_coords(geo_point.get("coordinates"))


def _record_visit(
    visit_map: dict[str, dict[str, datetime | None]],
    fips: str,
    visit_time: datetime | None,
) -> None:
    if fips not in visit_map:
        visit_map[fips] = {"firstVisit": visit_time, "lastVisit": visit_time}
        return
    if visit_time is None:
        return
    if visit_map[fips]["firstVisit"] is None or (
        visit_time < visit_map[fips]["firstVisit"]
    ):
        visit_map[fips]["firstVisit"] = visit_time
    if visit_map[fips]["lastVisit"] is None or (
        visit_time > visit_map[fips]["lastVisit"]
    ):
        visit_map[fips]["lastVisit"] = visit_time


def _extract_stop_points(
    gps_data,
    trip_start_time,
    trip_end_time,
    fallback_time,
):
    stop_points = []

    if not gps_data:
        return stop_points

    gps_type = gps_data.get("type")
    coords = gps_data.get("coordinates")

    if gps_type == "Point":
        point_coords = _coerce_point_coords(coords)
        if point_coords:
            stop_points.append((Point(point_coords[0], point_coords[1]), fallback_time))
        return stop_points

    if gps_type == "LineString" and isinstance(coords, list) and coords:
        start_coords = _coerce_point_coords(coords[0])
        end_coords = _coerce_point_coords(coords[-1])

        if start_coords:
            start_time = trip_start_time or fallback_time
            stop_points.append((Point(start_coords[0], start_coords[1]), start_time))

        if end_coords and (not start_coords or end_coords != start_coords):
            end_time = trip_end_time or fallback_time
            stop_points.append((Point(end_coords[0], end_coords[1]), end_time))

    return stop_points


@router.get("/cache-status")
async def get_cache_status() -> dict[str, Any]:
    """Get the status of the county cache."""
    try:
        cache = await CountyVisitedCache.get("visited_counties")

        if cache:
            stopped = cache.stopped_counties or {}
            return {
                "cached": True,
                "totalVisited": len(cache.counties or {}),
                "totalStopped": len(stopped),
                "tripsAnalyzed": cache.trips_analyzed or 0,
                "lastUpdated": cache.updated_at,
                "calculationTime": cache.calculation_time_seconds,
            }
        return {
            "cached": False,
            "message": "No cache exists. Trigger recalculation.",
        }
    except Exception as e:
        logger.exception("Error getting cache status: %s", e)
        return {"error": str(e)}
