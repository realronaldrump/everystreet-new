"""
export_helpers.py

This module provides functions to export trip data into various formats:
  - create_geojson: converts a list of trip dicts into a GeoJSON FeatureCollection.
  - create_gpx: converts a list of trip dicts into a GPX file.
These functions take care of serializing special types (e.g. ObjectIds, datetime objects)
and converting stored gps JSON strings into the appropriate structures.
"""

import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

async def create_geojson(trips):
    """
    Converts a list of trip dictionaries into a GeoJSON FeatureCollection.
    
    Each trip’s "gps" field is expected to be stored as a JSON string; this function
    parses that string and attaches it as the geometry. In addition, any datetime or ObjectId
    in the trip properties are converted into serializable forms.
    
    Returns the GeoJSON as a JSON-formatted string.
    """
    features = []
    for t in trips:
        # Parse the gps data.
        gps_data = t.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except Exception as e:
                logger.error(f"Error parsing gps data for trip {t.get('transactionId', '?')}: {e}")
                continue

        # Convert non-serializable fields in properties.
        properties_dict = {}
        for key, value in t.items():
            if key == "_id":
                properties_dict[key] = str(value)
            elif isinstance(value, datetime):
                properties_dict[key] = value.isoformat()
            else:
                properties_dict[key] = value

        feature = {
            "type": "Feature",
            "geometry": gps_data,
            "properties": properties_dict
        }
        features.append(feature)
    feature_collection = {"type": "FeatureCollection", "features": features}
    return json.dumps(feature_collection)

async def create_gpx(trips):
    """
    Converts a list of trip dictionaries into a GPX file.
    
    Each trip’s "gps" field is expected to be a JSON string representing either a Point or
    a LineString. This function builds a GPX file (using the gpxpy library) that contains
    a track for each trip.
    
    Returns the GPX XML as a string.
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
                logger.error(f"Error parsing gps data for trip {t.get('transactionId', '?')}: {e}")
                continue
        if gps_data.get("type") == "LineString":
            for coord in gps_data.get("coordinates", []):
                if len(coord) >= 2:
                    lon, lat = coord[0], coord[1]
                    segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        elif gps_data.get("type") == "Point":
            coords = gps_data.get("coordinates", [])
            if len(coords) >= 2:
                lon, lat = coords[0], coords[1]
                segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        track.name = f"Trip {t.get('transactionId', 'UNKNOWN')}"
    return gpx.to_xml()