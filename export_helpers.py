"""
export_helpers.py

This module provides functions to export trip data into various formats:
  - create_geojson: converts a list of trip dictionaries into a GeoJSON FeatureCollection.
  - create_gpx: converts a list of trip dictionaries into a GPX file.
These functions take care of serializing special types (e.g. ObjectIds, datetime objects)
and converting stored gps JSON strings into the appropriate structures.
"""

import json
import logging
from datetime import datetime
from typing import List, Dict, Any

from bson import ObjectId  # Ensure ObjectIds are handled

logger = logging.getLogger(__name__)


def default_serializer(o):
    """Custom serializer for JSON to handle datetime and ObjectId types."""
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, ObjectId):
        return str(o)
    return str(o)


async def create_geojson(trips: List[Dict[str, Any]]) -> str:
    """
    Converts a list of trip dictionaries into a GeoJSON FeatureCollection.

    Each trip's "gps" field is expected to be stored as a JSON string; this function
    parses that string and attaches it as the geometry. In addition, any datetime (or other
    non-serializable) fields in the trip properties are converted into serializable forms.

    Returns:
        A JSON-formatted string representing the GeoJSON FeatureCollection.
    """
    features = []
    for t in trips:
        # Parse the GPS data.
        gps_data = t.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except Exception as e:
                logger.error("Error parsing gps data for trip %s: %s",
                             t.get('transactionId', '?'), e)
                continue

        # Build a properties dictionary.
        # For each key/value, if the value is a datetime or an ObjectId, convert it.
        properties_dict = {}
        for key, value in t.items():
            if isinstance(value, datetime):
                properties_dict[key] = value.isoformat()
            elif isinstance(value, ObjectId):
                properties_dict[key] = str(value)
            else:
                properties_dict[key] = value

        feature = {
            "type": "Feature",
            "geometry": gps_data,
            "properties": properties_dict,
        }
        features.append(feature)
    feature_collection = {"type": "FeatureCollection", "features": features}

    # Use our custom default serializer to handle non-serializable types.
    return json.dumps(feature_collection, default=default_serializer)


async def create_gpx(trips: List[Dict[str, Any]]) -> str:
    """
    Converts a list of trip dictionaries into a GPX file.

    Each trip's "gps" field is expected to be a JSON string representing either a Point or
    a LineString. This function builds a GPX file (using the gpxpy library) that contains
    a track for each trip.

    Returns:
        The GPX XML as a string.
    """
    import gpxpy

    gpx = gpxpy.gpx.GPX()
    for t in trips:
        track = gpxpy.gpx.GPXTrack()
        gpx.tracks.append(track)
        segment = gpxpy.gpx.GPXTrackSegment()
        track.segments.append(segment)
        gps_data = t.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except Exception as e:
                logger.error("Error parsing gps data for trip %s: %s",
                             t.get('transactionId', '?'), e)
                continue

        if not gps_data:
            logger.warning("No gps data for trip %s",
                           t.get('transactionId', '?'))
            continue

        # Process a LineString.
        if gps_data.get("type") == "LineString":
            for coord in gps_data.get("coordinates", []):
                if isinstance(coord, list) and len(coord) >= 2:
                    lon, lat = coord[0], coord[1]
                    segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        # Process a Point.
        elif gps_data.get("type") == "Point":
            coords = gps_data.get("coordinates", [])
            if isinstance(coords, list) and len(coords) >= 2:
                lon, lat = coords[0], coords[1]
                segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        # Set the track name, ensuring transactionId is a string.
        track.name = f"Trip {str(t.get('transactionId', 'UNKNOWN'))}"
    return gpx.to_xml()
