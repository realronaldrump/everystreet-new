"""
Export utilities for trip data.

Provides functions to convert lists of trip dictionaries into standard
geospatial formats (GeoJSON and GPX) for export and interoperability
with other mapping tools and applications.
"""

import json
import logging
from datetime import datetime
from typing import List, Dict, Any
from bson import ObjectId
import gpxpy
import gpxpy.gpx

logger = logging.getLogger(__name__)


def default_serializer(obj: Any) -> str:
    """
    Custom JSON serializer to handle datetime and ObjectId types.

    Args:
        obj: The object to serialize

    Returns:
        str: String representation of the object
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, ObjectId):
        return str(obj)
    return str(obj)


async def create_geojson(trips: List[Dict[str, Any]]) -> str:
    """
    Convert trip dictionaries to a GeoJSON FeatureCollection string.

    Args:
        trips: List of trip dictionaries

    Returns:
        str: A GeoJSON string representing the trips
    """
    features = []

    for trip in trips:
        try:
            # Parse GPS data if it's a string
            gps_data = trip.get("gps")
            if not gps_data:
                logger.warning(
                    "Trip %s missing GPS data, skipping", trip.get("transactionId", "?")
                )
                continue

            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                except json.JSONDecodeError as e:
                    logger.error(
                        "Error parsing GPS for trip %s: %s",
                        trip.get("transactionId", "?"),
                        e,
                    )
                    continue

            # Copy all properties except large/complex objects
            properties_dict = {}
            for key, value in trip.items():
                if key != "gps" and value is not None:  # Skip GPS data and null values
                    properties_dict[key] = value

            # Create feature
            feature = {
                "type": "Feature",
                "geometry": gps_data,
                "properties": properties_dict,
            }
            features.append(feature)

        except Exception as e:
            logger.error(
                "Error processing trip %s for GeoJSON: %s",
                trip.get("transactionId", "?"),
                e,
            )

    # Create feature collection
    fc = {"type": "FeatureCollection", "features": features}

    if not features:
        logger.warning("No valid features generated from %d trips", len(trips))
    else:
        logger.info(
            "Created GeoJSON with %d features from %d trips", len(features), len(trips)
        )

    return json.dumps(fc, default=default_serializer)


async def create_gpx(trips: List[Dict[str, Any]]) -> str:
    """
    Convert trip dictionaries to a GPX file (XML string).

    Args:
        trips: List of trip dictionaries

    Returns:
        str: A GPX XML string representing the trips
    """
    gpx = gpxpy.gpx.GPX()
    trip_count = 0

    for trip in trips:
        try:
            # Parse GPS data if it's a string
            gps_data = trip.get("gps")
            if not gps_data:
                logger.warning(
                    "Trip %s missing GPS data, skipping", trip.get("transactionId", "?")
                )
                continue

            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                except json.JSONDecodeError as e:
                    logger.error(
                        "Error parsing GPS for trip %s: %s",
                        trip.get("transactionId", "?"),
                        e,
                    )
                    continue

            # Create track
            track = gpxpy.gpx.GPXTrack()
            track.name = f"Trip {trip.get('transactionId', 'UNKNOWN')}"

            # Add description if available
            if trip.get("startLocation") and trip.get("destination"):
                track.description = (
                    f"From {trip.get('startLocation')} to {trip.get('destination')}"
                )

            gpx.tracks.append(track)

            # Create segment
            segment = gpxpy.gpx.GPXTrackSegment()
            track.segments.append(segment)

            # Process coordinates based on geometry type
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

            if segment.points:
                trip_count += 1

        except Exception as e:
            logger.error(
                "Error processing trip %s for GPX: %s",
                trip.get("transactionId", "?"),
                e,
            )

    if trip_count == 0:
        logger.warning("No valid tracks generated from %d trips", len(trips))
    else:
        logger.info("Created GPX with %d tracks from %d trips", trip_count, len(trips))

    return gpx.to_xml()
