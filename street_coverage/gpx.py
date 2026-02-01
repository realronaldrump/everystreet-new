"""GPX helpers for coverage exports."""

from __future__ import annotations

import gpxpy
import gpxpy.gpx


def build_gpx_from_coords(
    coords: list[list[float]],
    name: str = "Track",
    description: str | None = None,
) -> str:
    """Build GPX XML from coordinate list."""
    gpx = gpxpy.gpx.GPX()
    gpx.creator = "Every Street"

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
