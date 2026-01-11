"""
GPX export utilities.

Provides functions to convert trip data to GPX format for export.
"""

import logging
from typing import Any

import gpxpy
import gpxpy.gpx

logger = logging.getLogger(__name__)


def build_gpx_from_coords(
    coords: list[list[float]],
    name: str = "Track",
    description: str | None = None,
) -> str:
    """
    Build GPX XML from coordinate list using gpxpy.

    Args:
        coords: List of [lon, lat] coordinate pairs
        name: Name for the GPX track
        description: Optional description

    Returns:
        GPX XML string
    """
    gpx = gpxpy.gpx.GPX()
    gpx.creator = "EveryStreet"

    track = gpxpy.gpx.GPXTrack()
    track.name = name
    if description:
        track.description = description
    gpx.tracks.append(track)

    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)

    for coord in coords:
        if len(coord) >= 2:
            lon, lat = coord[0], coord[1]
            segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

    return gpx.to_xml()


def _validate_point_coordinates(coords: Any, trip_id: str) -> bool:
    """Validate Point geometry coordinates."""
    if not (
        isinstance(coords, list)
        and len(coords) == 2
        and all(isinstance(c, float | int) for c in coords)
    ):
        logger.warning(
            "Trip %s GPX export - Invalid Point coordinate structure: %s. Skipping.",
            trip_id,
            coords,
        )
        return False
    return True


def _validate_linestring_coordinates(coords_list: Any, trip_id: str) -> bool:
    """Validate LineString geometry coordinates."""
    if not (isinstance(coords_list, list) and len(coords_list) >= 2):
        logger.warning(
            "Trip %s GPX export - LineString has too few points: %s. Skipping.",
            trip_id,
            len(coords_list) if isinstance(coords_list, list) else "N/A",
        )
        return False

    for coord_pair in coords_list:
        if not (
            isinstance(coord_pair, list)
            and len(coord_pair) == 2
            and all(isinstance(c, float | int) for c in coord_pair)
        ):
            logger.warning(
                "Trip %s GPX export - Invalid coordinate pair in LineString: %s. Skipping trip.",
                trip_id,
                coord_pair,
            )
            return False
    return True


async def create_gpx(trips: list[dict[str, Any]]) -> str:
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
            gps_data = trip.get("gps")
            trip_id = trip.get("transactionId", "?")

            if not gps_data:
                logger.warning("Trip %s missing GPS data, skipping", trip_id)
                continue

            # Expect gps_data to be a GeoJSON dictionary or None
            if (
                not isinstance(gps_data, dict)
                or "type" not in gps_data
                or "coordinates" not in gps_data
            ):
                logger.warning(
                    "Trip %s has invalid or missing GeoJSON gps_data structure, skipping for GPX export. Data: %s",
                    trip_id,
                    str(gps_data)[:100],
                )
                continue

            # Validate coordinates based on type for GPX generation
            geom_type = gps_data["type"]
            if geom_type == "Point":
                if not _validate_point_coordinates(
                    gps_data.get("coordinates", []),
                    trip_id,
                ):
                    continue
            elif geom_type == "LineString":
                if not _validate_linestring_coordinates(
                    gps_data.get("coordinates", []),
                    trip_id,
                ):
                    continue
            else:
                logger.warning(
                    "Trip %s GPX export - Unsupported GPS type: %s. Skipping.",
                    trip_id,
                    geom_type,
                )
                continue

            track = gpxpy.gpx.GPXTrack()
            track.name = f"Trip {trip_id}"

            if trip.get("startLocation") and trip.get("destination"):
                track.description = (
                    f"From {trip.get('startLocation')} to {trip.get('destination')}"
                )

            gpx.tracks.append(track)

            segment = gpxpy.gpx.GPXTrackSegment()
            track.segments.append(segment)

            if geom_type == "LineString":
                for coord in gps_data.get("coordinates", []):
                    if len(coord) >= 2:
                        lon, lat = coord[0], coord[1]
                        segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
            elif geom_type == "Point":
                coords = gps_data.get("coordinates", [])
                if len(coords) >= 2:
                    lon, lat = coords[0], coords[1]
                    segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

            if segment.points:
                trip_count += 1

        except Exception as e:
            logger.exception(
                "Error processing trip %s for GPX: %s",
                trip.get("transactionId", "?"),
                e,
            )

    if trip_count == 0:
        logger.warning("No valid tracks generated from %d trips", len(trips))
    else:
        logger.info("Created GPX with %d tracks from %d trips", trip_count, len(trips))

    return gpx.to_xml()
