"""
GeoJSON export utilities.

Provides functions to convert trip data to GeoJSON format for export.
"""

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def create_geojson(trips: list[dict[str, Any]]) -> str:
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
            gps_data = trip.get("gps")
            if not gps_data:
                logger.warning(
                    "Trip %s missing GPS data, skipping",
                    trip.get("transactionId", "?"),
                )
                continue

            # Expect gps_data to be a GeoJSON dictionary or None
            if (
                not isinstance(gps_data, dict)
                or "type" not in gps_data
                or "coordinates" not in gps_data
            ):
                logger.warning(
                    "Trip %s has invalid or missing GeoJSON gps_data structure, skipping for GeoJSON export. Data: %s",
                    trip.get("transactionId", "?"),
                    str(gps_data)[:100],
                )
                continue

            # Basic validation for Point/LineString coordinates structure
            if gps_data["type"] == "Point" and not (
                isinstance(gps_data["coordinates"], list)
                and len(gps_data["coordinates"]) == 2
            ):
                logger.warning(
                    "Trip %s has invalid coordinates structure. Skipping. Coords: %s",
                    trip.get("transactionId", "?"),
                    gps_data["coordinates"],
                )
                continue
            if gps_data["type"] == "LineString" and not (
                isinstance(gps_data["coordinates"], list)
                and len(gps_data["coordinates"]) >= 2
            ):
                logger.warning(
                    "Trip %s has invalid coordinates structure or not enough points. Skipping. Coords: %s",
                    trip.get("transactionId", "?"),
                    gps_data["coordinates"],
                )
                continue

            properties_dict = {}
            for key, value in trip.items():
                if key != "gps" and value is not None:
                    properties_dict[key] = value

            feature = {
                "type": "Feature",
                "geometry": gps_data,
                "properties": properties_dict,
            }
            features.append(feature)

        except Exception as e:
            logger.exception(
                "Error processing trip %s for GeoJSON: %s",
                trip.get("transactionId", "?"),
                e,
            )

    fc = {
        "type": "FeatureCollection",
        "features": features,
    }

    if not features:
        logger.warning(
            "No valid features generated from %d trips",
            len(trips),
        )
    else:
        logger.info(
            "Created GeoJSON with %d features from %d trips",
            len(features),
            len(trips),
        )

    return json.dumps(fc)
