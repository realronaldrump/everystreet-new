"""County Map API.

Provides endpoints for county-level coverage visualization.
Counties are marked as visited if any trip geometry passes through them.
Tracks first and most recent visit dates for each county.
Results are cached in MongoDB for fast page loads.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks
from shapely import STRtree
from shapely.geometry import shape
from shapely.ops import unary_union
from shapely.validation import make_valid

from county_data_service import get_county_topology_document
from db import db_manager, trips_collection

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/counties", tags=["counties"])

# Collection for caching visited counties
county_cache_collection = db_manager.db["county_visited_cache"]


@router.get("/topology")
async def get_county_topology(projection: str | None = None) -> dict[str, Any]:
    """Return county TopoJSON data stored in MongoDB.

    If the requested projection is not yet cached, it will be downloaded and stored.
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
    """Get cached list of visited county FIPS codes with visit dates.

    Returns cached data if available, otherwise triggers a recalculation.
    """
    try:
        # Try to get cached data
        cache = await county_cache_collection.find_one({"_id": "visited_counties"})

        if cache:
            return {
                "success": True,
                "counties": cache.get(
                    "counties", {}
                ),  # {fips: {firstVisit, lastVisit}}
                "stoppedCounties": cache.get("stoppedCounties", {}),
                "totalVisited": len(cache.get("counties", {})),
                "lastUpdated": cache.get("updated_at"),
                "totalTripsAnalyzed": cache.get("trips_analyzed", 0),
                "cached": True,
            }

        # No cache - return empty and suggest recalculation
        return {
            "success": True,
            "counties": {},
            "stoppedCounties": {},
            "totalVisited": 0,
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
        }


@router.post("/recalculate")
async def recalculate_visited_counties(
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """Trigger recalculation of visited counties.

    This performs geospatial intersection between trip geometries and county polygons.
    The calculation runs in the background.
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
    """Background task to calculate which counties have been driven through.

    Tracks first visit date and most recent visit date for each county.
    """
    logger.info("Starting county visited calculation...")
    start_time = datetime.now(UTC)

    try:
        topology_document = await get_county_topology_document()
        if not topology_document or "topology" not in topology_document:
            raise RuntimeError("County topology could not be loaded from database")
        topology = topology_document["topology"]

        # Convert TopoJSON to GeoJSON features
        counties_geojson = topojson_to_geojson(topology, "counties")

        logger.info("Loaded %d county polygons", len(counties_geojson))

        # Build spatial index of counties using shapely
        county_shapes: list[Any] = []
        county_fips: list[str] = []

        def _clean_county_geometry(raw_geometry: dict[str, Any], fips: str):
            """Convert and repair a county geometry if needed."""
            geom = shape(raw_geometry)

            if not geom.is_valid:
                fixed = make_valid(geom)
                if fixed.is_empty:
                    logger.warning(
                        "Skipping county %s: geometry empty after make_valid", fips
                    )
                    return None
                if fixed.geom_type == "GeometryCollection":
                    polygons = [
                        g
                        for g in fixed.geoms
                        if g.geom_type in ("Polygon", "MultiPolygon")
                    ]
                    if not polygons:
                        logger.warning(
                            "Skipping county %s: no polygonal parts in repaired geometry",
                            fips,
                        )
                        return None
                    geom = unary_union(polygons)
                else:
                    geom = fixed

            if geom.is_empty:
                logger.warning("Skipping county %s: geometry empty", fips)
                return None

            return geom

        for feature in counties_geojson:
            try:
                fips = str(feature.get("id", "")).zfill(5)
                geom = _clean_county_geometry(feature["geometry"], fips)
                if geom:
                    county_shapes.append(geom)
                    county_fips.append(fips)
            except Exception as e:
                logger.warning("Invalid county geometry: %s", e)

        tree = STRtree(county_shapes)
        logger.info("Built spatial index for %d counties", len(county_shapes))

        # Dictionaries to track visit dates per county
        county_visits: dict[str, dict[str, datetime]] = {}
        county_stops: dict[str, dict[str, datetime]] = {}

        # Query all valid trips with GPS data, ordered by time
        trips_cursor = trips_collection.find(
            {
                "isInvalid": {"$ne": True},
                "$or": [
                    {"gps.type": {"$in": ["LineString", "MultiLineString"]}},
                    {"matchedGps.type": {"$in": ["LineString", "MultiLineString"]}},
                ],
            },
            {
                "gps": 1,
                "matchedGps": 1,
                "transactionId": 1,
                "startTime": 1,
                "endTime": 1,
                "startGeoPoint": 1,
                "destinationGeoPoint": 1,
            },
        )

        trips_analyzed = 0

        async for trip in trips_cursor:
            trips_analyzed += 1

            def _parse_trip_time(raw_time: Any) -> datetime | None:
                if not raw_time:
                    return None
                if isinstance(raw_time, datetime):
                    return raw_time
                if isinstance(raw_time, str):
                    try:
                        return datetime.fromisoformat(raw_time.replace("Z", "+00:00"))
                    except Exception:
                        return None
                return None

            # Get trip timestamps
            trip_time = _parse_trip_time(trip.get("startTime"))
            end_time = _parse_trip_time(trip.get("endTime")) or trip_time
            if not trip_time:
                continue

            # Prefer matched GPS if available
            gps_data = trip.get("matchedGps") or trip.get("gps")
            if not gps_data or gps_data.get("type") not in [
                "LineString",
                "MultiLineString",
            ]:
                continue

            try:
                trip_geom = shape(gps_data)
                if not trip_geom.is_valid:
                    continue

                # Find all counties this trip intersects
                potential_matches = tree.query(trip_geom)
                for idx in potential_matches:
                    if county_shapes[idx].intersects(trip_geom):
                        fips = county_fips[idx]

                        if fips not in county_visits:
                            county_visits[fips] = {
                                "firstVisit": trip_time,
                                "lastVisit": trip_time,
                            }
                        else:
                            # Update first/last visit
                            if trip_time < county_visits[fips]["firstVisit"]:
                                county_visits[fips]["firstVisit"] = trip_time
                            if trip_time > county_visits[fips]["lastVisit"]:
                                county_visits[fips]["lastVisit"] = trip_time

                # Track counties where the trip started or ended (stops)
                stop_points = [
                    (trip.get("startGeoPoint"), trip_time),
                    (trip.get("destinationGeoPoint"), end_time),
                ]

                for point_data, point_time in stop_points:
                    if not point_data or point_data.get("type") != "Point":
                        continue
                    coords = point_data.get("coordinates")
                    if (
                        not coords
                        or not isinstance(coords, list)
                        or len(coords) != 2
                        or point_time is None
                    ):
                        continue

                    try:
                        point_geom = shape(point_data)
                        stop_matches = tree.query(point_geom)
                        for idx in stop_matches:
                            if county_shapes[idx].covers(point_geom):
                                fips = county_fips[idx]
                                if fips not in county_stops:
                                    county_stops[fips] = {
                                        "firstStop": point_time,
                                        "lastStop": point_time,
                                    }
                                else:
                                    if point_time < county_stops[fips]["firstStop"]:
                                        county_stops[fips]["firstStop"] = point_time
                                    if point_time > county_stops[fips]["lastStop"]:
                                        county_stops[fips]["lastStop"] = point_time
                    except Exception as stop_error:
                        logger.debug(
                            "Unable to assign stop point for trip %s: %s",
                            trip.get("transactionId", "unknown"),
                            stop_error,
                        )

            except Exception as e:
                logger.warning(
                    "Error processing trip %s: %s",
                    trip.get("transactionId", "unknown"),
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

        stopped_serializable = {}
        for fips, stops in county_stops.items():
            stopped_serializable[fips] = {
                "firstStop": (
                    stops["firstStop"].isoformat() if stops["firstStop"] else None
                ),
                "lastStop": (
                    stops["lastStop"].isoformat() if stops["lastStop"] else None
                ),
            }

        # Save to cache
        await county_cache_collection.update_one(
            {"_id": "visited_counties"},
            {
                "$set": {
                    "counties": counties_serializable,
                    "stoppedCounties": stopped_serializable,
                    "trips_analyzed": trips_analyzed,
                    "updated_at": datetime.now(UTC),
                    "calculation_time_seconds": (
                        datetime.now(UTC) - start_time
                    ).total_seconds(),
                }
            },
            upsert=True,
        )

        logger.info(
            "County calculation complete: %d counties visited, %d counties with stops from %d trips in %.1f seconds",
            len(county_visits),
            len(county_stops),
            trips_analyzed,
            (datetime.now(UTC) - start_time).total_seconds(),
        )

    except Exception as e:
        logger.exception("Error in county calculation task: %s", e)


def topojson_to_geojson(topology: dict, object_name: str) -> list[dict]:
    """Convert TopoJSON to GeoJSON features.

    Simple implementation that handles the arc-based geometry encoding.
    """
    features = []

    if "objects" not in topology or object_name not in topology["objects"]:
        return features

    arcs = topology.get("arcs", [])
    transform_data = topology.get("transform")

    def decode_arc(arc_index: int) -> list:
        """Decode a single arc to coordinates."""
        if arc_index < 0:
            # Negative index means reverse the arc
            arc = arcs[~arc_index]
            coords = decode_coordinates(arc)
            return list(reversed(coords))
        arc = arcs[arc_index]
        return decode_coordinates(arc)

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


@router.get("/cache-status")
async def get_cache_status() -> dict[str, Any]:
    """Get the status of the county cache."""
    try:
        cache = await county_cache_collection.find_one({"_id": "visited_counties"})

        if cache:
            return {
                "cached": True,
                "totalVisited": len(cache.get("counties", {})),
                "totalStopped": len(cache.get("stoppedCounties", {})),
                "tripsAnalyzed": cache.get("trips_analyzed", 0),
                "lastUpdated": cache.get("updated_at"),
                "calculationTime": cache.get("calculation_time_seconds"),
            }
        return {
            "cached": False,
            "message": "No cache exists. Trigger recalculation.",
        }
    except Exception as e:
        logger.exception("Error getting cache status: %s", e)
        return {"error": str(e)}
