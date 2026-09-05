"""Canonical road and historical-input identities."""

import hashlib
import json

from shapely.geometry import shape

from core.date_utils import normalize_to_utc_datetime
from street_coverage.matching import MATCHING_VERSION


def _stored_timestamp(value):
    value = normalize_to_utc_datetime(value)
    # BSON stores datetimes to milliseconds. Hash the persisted precision so
    # a save/reload cannot make an otherwise identical trip look different.
    return value.isoformat(timespec="milliseconds") if value else None


def road_key(geometry: dict, tags: dict | None = None) -> str:
    topology = {key: (tags or {}).get(key) for key in ("layer", "bridge", "tunnel")}
    payload = (
        shape(geometry).normalize().wkb
        + json.dumps(topology, sort_keys=True, default=str).encode()
    )
    return hashlib.sha256(payload).hexdigest()[:32]


def trip_input_revision(trip: dict) -> str:
    fields = {
        name: trip.get(name)
        for name in (
            "gps",
            "matchedGps",
            "matchStatus",
            "matched_at",
            "matchConfidence",
            "startTime",
            "endTime",
            "startTimeZone",
            "endTimeZone",
            "inactive",
            "invalid",
        )
    }
    fields["matcher"] = MATCHING_VERSION
    for key in ("startTime", "endTime", "matched_at"):
        fields[key] = _stored_timestamp(fields[key])
    fields["sample_timestamps"] = [
        _stored_timestamp(sample.get("timestamp")) if isinstance(sample, dict) else None
        for sample in trip.get("coordinates") or []
    ]
    return hashlib.sha256(
        json.dumps(fields, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
