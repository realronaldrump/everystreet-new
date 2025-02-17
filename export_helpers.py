"""
export_helpers.py

Converts lists of trip dictionaries into either GeoJSON or GPX.
"""

import json
import logging
from datetime import datetime
from typing import List, Dict, Any
from bson import ObjectId

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
    Convert a list of trip dicts into a GeoJSON FeatureCollection string.
    Each trip's 'gps' field is JSON-parsed (if needed) to build geometry.
    """
    features = []
    for t in trips:
        gps_data = t.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except Exception as e:
                logger.error(
                    "Error parsing gps for trip %s: %s",
                    t.get("transactionId", "?"),
                    e,
                )
                continue

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
    fc = {"type": "FeatureCollection", "features": features}
    return json.dumps(fc, default=default_serializer)


async def create_gpx(trips: List[Dict[str, Any]]) -> str:
    """
    Convert a list of trip dictionaries into a GPX file (XML string).
    Each trip's 'gps' field is expected to be a Point or LineString.
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
                logger.error(
                    "Error parsing gps data for trip %s: %s",
                    t.get("transactionId", "?"),
                    e,
                )
                continue

        if not gps_data:
            logger.warning("No gps data for trip %s", t.get("transactionId", "?"))
            continue

        if gps_data.get("type") == "LineString":
            for coord in gps_data.get("coordinates", []):
                if isinstance(coord, list) and len(coord) >= 2:
                    lon, lat = coord[0], coord[1]
                    segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        elif gps_data.get("type") == "Point":
            coords = gps_data.get("coordinates", [])
            if len(coords) >= 2:
                lon, lat = coords[0], coords[1]
                segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

        track.name = f"Trip {str(t.get('transactionId', 'UNKNOWN'))}"

    return gpx.to_xml()
