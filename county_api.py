"""County Map API.

Provides endpoints for county-level coverage visualization.
Counties are marked as visited if any trip geometry passes through them.
Results are cached in MongoDB for fast page loads.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks
from shapely.geometry import LineString, shape, mapping
from shapely.ops import transform
import pyproj

from db import db_manager, trips_collection

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/counties", tags=["counties"])

# Collection for caching visited counties
county_cache_collection = db_manager.db["county_visited_cache"]


@router.get("/visited")
async def get_visited_counties() -> dict[str, Any]:
    """Get cached list of visited county FIPS codes.
    
    Returns cached data if available, otherwise triggers a recalculation.
    """
    try:
        # Try to get cached data
        cache = await county_cache_collection.find_one({"_id": "visited_counties"})
        
        if cache:
            return {
                "success": True,
                "visitedFips": cache.get("fips_codes", []),
                "totalVisited": len(cache.get("fips_codes", [])),
                "lastUpdated": cache.get("updated_at"),
                "totalTripsAnalyzed": cache.get("trips_analyzed", 0),
                "cached": True,
            }
        
        # No cache - return empty and suggest recalculation
        return {
            "success": True,
            "visitedFips": [],
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
            "visitedFips": [],
            "totalVisited": 0,
        }


@router.post("/recalculate")
async def recalculate_visited_counties(background_tasks: BackgroundTasks) -> dict[str, Any]:
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
    """Background task to calculate which counties have been driven through."""
    import json
    
    logger.info("Starting county visited calculation...")
    start_time = datetime.now(UTC)
    
    try:
        # Load county boundaries from the TopoJSON file
        import os
        topojson_path = os.path.join(
            os.path.dirname(__file__), 
            "static", "data", "counties-10m.json"
        )
        
        with open(topojson_path, "r") as f:
            topology = json.load(f)
        
        # Convert TopoJSON to GeoJSON features
        # Using a simple TopoJSON parser since we can't use topojson-client in Python
        counties_geojson = topojson_to_geojson(topology, "counties")
        
        logger.info("Loaded %d county polygons", len(counties_geojson))
        
        # Build spatial index of counties using shapely
        from shapely import STRtree
        county_shapes = []
        county_fips = []
        
        for feature in counties_geojson:
            try:
                geom = shape(feature["geometry"])
                if geom.is_valid:
                    county_shapes.append(geom)
                    # FIPS code is the feature id
                    fips = str(feature.get("id", "")).zfill(5)
                    county_fips.append(fips)
            except Exception as e:
                logger.warning("Invalid county geometry: %s", e)
        
        tree = STRtree(county_shapes)
        logger.info("Built spatial index for %d counties", len(county_shapes))
        
        # Query all valid trips with GPS data
        trips_cursor = trips_collection.find(
            {
                "isInvalid": {"$ne": True},
                "$or": [
                    {"gps.type": "LineString"},
                    {"matchedGps.type": "LineString"},
                ]
            },
            {"gps": 1, "matchedGps": 1, "transactionId": 1}
        )
        
        visited_fips = set()
        trips_analyzed = 0
        
        async for trip in trips_cursor:
            trips_analyzed += 1
            
            # Prefer matched GPS if available
            gps_data = trip.get("matchedGps") or trip.get("gps")
            if not gps_data or gps_data.get("type") != "LineString":
                continue
            
            try:
                trip_geom = shape(gps_data)
                if not trip_geom.is_valid:
                    continue
                
                # Find all counties this trip intersects
                potential_matches = tree.query(trip_geom)
                for idx in potential_matches:
                    if county_shapes[idx].intersects(trip_geom):
                        visited_fips.add(county_fips[idx])
                        
            except Exception as e:
                logger.warning(
                    "Error processing trip %s: %s", 
                    trip.get("transactionId", "unknown"), e
                )
            
            # Log progress every 500 trips
            if trips_analyzed % 500 == 0:
                logger.info(
                    "Processed %d trips, found %d visited counties so far",
                    trips_analyzed, len(visited_fips)
                )
        
        # Save to cache
        await county_cache_collection.update_one(
            {"_id": "visited_counties"},
            {
                "$set": {
                    "fips_codes": list(visited_fips),
                    "trips_analyzed": trips_analyzed,
                    "updated_at": datetime.now(UTC),
                    "calculation_time_seconds": (datetime.now(UTC) - start_time).total_seconds(),
                }
            },
            upsert=True,
        )
        
        logger.info(
            "County calculation complete: %d counties visited from %d trips in %.1f seconds",
            len(visited_fips), trips_analyzed,
            (datetime.now(UTC) - start_time).total_seconds()
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
        else:
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
                    }
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
                    }
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
                "totalVisited": len(cache.get("fips_codes", [])),
                "tripsAnalyzed": cache.get("trips_analyzed", 0),
                "lastUpdated": cache.get("updated_at"),
                "calculationTime": cache.get("calculation_time_seconds"),
            }
        else:
            return {
                "cached": False,
                "message": "No cache exists. Trigger recalculation.",
            }
    except Exception as e:
        logger.exception("Error getting cache status: %s", e)
        return {"error": str(e)}
