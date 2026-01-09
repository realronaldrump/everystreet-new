"""TripCompleted event definition.

This event is emitted whenever a trip is completed through any path:
- Bouncie webhook (tripEnd event)
- Manual upload
- Periodic fetch task
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass
class TripCompleted:
    """Event emitted when a trip is completed.

    This is the single entry point for triggering coverage updates.
    """

    trip_id: str
    bbox: tuple[float, float, float, float]  # (minLon, minLat, maxLon, maxLat)
    timestamp: datetime
    source: str  # "webhook", "upload", "fetch", "live_tracking"

    # Optional geometry for precise matching
    gps_geometry: dict[str, Any] | None = None

    # Metadata
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "trip_id": self.trip_id,
            "bbox": list(self.bbox),
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "source": self.source,
            "gps_geometry": self.gps_geometry,
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TripCompleted":
        """Create from dictionary."""
        from date_utils import parse_timestamp

        return cls(
            trip_id=data["trip_id"],
            bbox=tuple(data["bbox"]),
            timestamp=parse_timestamp(data["timestamp"]) or datetime.now(UTC),
            source=data["source"],
            gps_geometry=data.get("gps_geometry"),
            created_at=parse_timestamp(data.get("created_at")) or datetime.now(UTC),
        )


def compute_trip_bbox(gps_geometry: dict[str, Any] | None) -> tuple[float, float, float, float]:
    """Compute bounding box from trip GPS geometry.

    Args:
        gps_geometry: GeoJSON Point or LineString

    Returns:
        (minLon, minLat, maxLon, maxLat) tuple
    """
    if not gps_geometry:
        # Return world bbox as fallback
        return (-180.0, -90.0, 180.0, 90.0)

    geom_type = gps_geometry.get("type")
    coords = gps_geometry.get("coordinates", [])

    if geom_type == "Point" and len(coords) >= 2:
        lon, lat = coords[0], coords[1]
        # Add small buffer around point
        buffer = 0.001  # ~100m at equator
        return (lon - buffer, lat - buffer, lon + buffer, lat + buffer)

    elif geom_type == "LineString" and coords:
        lons = [c[0] for c in coords if len(c) >= 2]
        lats = [c[1] for c in coords if len(c) >= 2]
        if lons and lats:
            return (min(lons), min(lats), max(lons), max(lats))

    return (-180.0, -90.0, 180.0, 90.0)
