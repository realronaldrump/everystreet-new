"""Public-road filtering and audit helpers for coverage ingestion.

This module centralizes road inclusion decisions so preprocessing and ingestion
use the same classifier semantics.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

ROAD_FILTER_VERSION = "public-road-filter-v2"
GRAPH_ROAD_FILTER_VERSION_KEY = "coverage_road_filter_version"
GRAPH_ROAD_FILTER_SIGNATURE_KEY = "coverage_road_filter_signature"
GRAPH_ROAD_FILTER_STATS_KEY = "coverage_road_filter_stats"

# Legacy behavior used prior to v2 public-road filtering.
LEGACY_DRIVEABLE_HIGHWAY_TYPES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "living_street",
    "service",
}

DRIVEABLE_HIGHWAY_TYPES = LEGACY_DRIVEABLE_HIGHWAY_TYPES | {"track"}

HARD_RESTRICTION_VALUES = {
    "private",
    "no",
    "restricted",
    "customers",
    "delivery",
    "permit",
    "agricultural",
    "forestry",
    "emergency",
}

AMBIGUOUS_ACCESS_VALUES = {
    "destination",
    "permissive",
}

EXPLICIT_PUBLIC_ACCESS_VALUES = {
    "yes",
    "designated",
    "official",
    "public",
    "permissive",
}

EXCLUDED_SERVICE_VALUES = {
    "parking_aisle",
    "driveway",
    "alley",
    "drive-through",
    "drive_through",
    "emergency_access",
}

ACCESS_KEYS = ("access", "vehicle", "motor_vehicle", "motorcar")

RELEVANT_FILTER_KEYS = (
    "name",
    "highway",
    "service",
    "access",
    "vehicle",
    "motor_vehicle",
    "motorcar",
    "access:conditional",
    "area",
)

TAG_ALIASES = {
    "access_conditional": "access:conditional",
}

MODE_BALANCED = "balanced"
MODE_STRICT = "strict"
MODE_LEGACY = "legacy"
VALID_MODES = {MODE_BALANCED, MODE_STRICT, MODE_LEGACY}

TRACK_CONDITIONAL = "conditional"
TRACK_EXCLUDE = "exclude"
TRACK_INCLUDE = "include"
VALID_TRACK_POLICIES = {TRACK_CONDITIONAL, TRACK_EXCLUDE, TRACK_INCLUDE}


@dataclass(frozen=True, slots=True)
class PublicRoadDecision:
    """Single classifier decision."""

    include: bool
    reason_code: str
    confidence: float
    highway_type: str | None = None
    ambiguous: bool = False


@dataclass(slots=True)
class PublicRoadFilterAudit:
    """Aggregated classifier diagnostics for an area/graph."""

    sample_limit: int = 25
    included_count: int = 0
    excluded_count: int = 0
    ambiguous_included_count: int = 0
    included_by_reason: dict[str, int] = field(default_factory=dict)
    excluded_by_reason: dict[str, int] = field(default_factory=dict)
    sample_excluded_osm_ids: list[int] = field(default_factory=list)

    def record(self, decision: PublicRoadDecision, osm_id: Any = None) -> None:
        if decision.include:
            self.included_count += 1
            self.included_by_reason[decision.reason_code] = (
                self.included_by_reason.get(decision.reason_code, 0) + 1
            )
            if decision.ambiguous:
                self.ambiguous_included_count += 1
            return

        self.excluded_count += 1
        self.excluded_by_reason[decision.reason_code] = (
            self.excluded_by_reason.get(decision.reason_code, 0) + 1
        )

        sample_id = _coerce_osm_id(osm_id)
        if sample_id is None or len(self.sample_excluded_osm_ids) >= self.sample_limit:
            return
        if sample_id in self.sample_excluded_osm_ids:
            return
        self.sample_excluded_osm_ids.append(sample_id)

    def to_dict(self) -> dict[str, Any]:
        return {
            "road_filter_version": get_public_road_filter_version(),
            "road_filter_signature": get_public_road_filter_signature(),
            "included_count": int(self.included_count),
            "excluded_count": int(self.excluded_count),
            "ambiguous_included_count": int(self.ambiguous_included_count),
            "included_by_reason": dict(self.included_by_reason),
            "excluded_by_reason": dict(self.excluded_by_reason),
            "sample_excluded_osm_ids": list(self.sample_excluded_osm_ids),
        }


def get_public_road_filter_version() -> str:
    return ROAD_FILTER_VERSION


def get_public_road_filter_mode(raw: str | None = None) -> str:
    value = (raw if raw is not None else os.getenv("COVERAGE_PUBLIC_ROAD_FILTER_MODE", "")).strip().lower()
    if value in VALID_MODES:
        return value
    return MODE_BALANCED


def get_track_policy(raw: str | None = None) -> str:
    value = (raw if raw is not None else os.getenv("COVERAGE_TRACK_POLICY", "")).strip().lower()
    if value in VALID_TRACK_POLICIES:
        return value
    return TRACK_CONDITIONAL


def get_public_road_filter_signature(
    *,
    mode: str | None = None,
    track_policy: str | None = None,
) -> str:
    resolved_mode = get_public_road_filter_mode(mode)
    resolved_track = get_track_policy(track_policy)
    return f"{ROAD_FILTER_VERSION}|mode={resolved_mode}|track={resolved_track}"


def normalize_tag_values(value: Any) -> list[str]:
    """Normalize scalar/list/semicolon values into lowercase tokens."""

    if value is None:
        return []

    if isinstance(value, list | tuple | set):
        values: list[str] = []
        for item in value:
            values.extend(normalize_tag_values(item))
        return values

    if isinstance(value, bytes):
        raw = value.decode("utf-8", errors="ignore")
    else:
        raw = str(value)

    parts = [raw]
    if ";" in raw:
        parts = raw.split(";")

    normalized: list[str] = []
    for part in parts:
        token = part.strip().lower()
        if token:
            normalized.append(token)
    return normalized


def extract_relevant_tags(raw_tags: Mapping[str, Any] | None) -> dict[str, Any]:
    """Extract relevant classifier tags from an edge/way payload."""

    if not raw_tags:
        return {}

    nested = _coerce_tags_mapping(raw_tags.get("tags"))
    normalized_nested = _apply_aliases(nested)
    normalized_raw = _apply_aliases(raw_tags)

    merged: dict[str, Any] = {}
    for key in RELEVANT_FILTER_KEYS:
        if key in normalized_raw and normalized_raw.get(key) is not None:
            merged[key] = normalized_raw[key]
            continue
        if key in normalized_nested and normalized_nested.get(key) is not None:
            merged[key] = normalized_nested[key]

    return merged


def classify_public_road(
    tags: Mapping[str, Any] | None,
    *,
    mode: str | None = None,
    track_policy: str | None = None,
) -> PublicRoadDecision:
    """Classify an OSM way as public-road include/exclude."""

    effective_mode = get_public_road_filter_mode(mode)
    effective_track_policy = get_track_policy(track_policy)
    values = extract_relevant_tags(tags)

    if effective_mode == MODE_LEGACY:
        return _classify_legacy(values)

    highway = _pick_driveable_highway(values.get("highway"))
    if highway is None:
        return PublicRoadDecision(
            include=False,
            reason_code="exclude_not_driveable_highway",
            confidence=1.0,
            highway_type=None,
        )

    if "yes" in normalize_tag_values(values.get("area")):
        return PublicRoadDecision(
            include=False,
            reason_code="exclude_area_yes",
            confidence=0.98,
            highway_type=highway,
        )

    if _has_hard_restriction(values):
        return PublicRoadDecision(
            include=False,
            reason_code="exclude_hard_restriction",
            confidence=0.99,
            highway_type=highway,
        )

    service_values = normalize_tag_values(values.get("service"))
    if any(token in EXCLUDED_SERVICE_VALUES for token in service_values):
        return PublicRoadDecision(
            include=False,
            reason_code="exclude_service_subtype",
            confidence=0.99,
            highway_type=highway,
        )

    track_allowed = False
    if highway == "track":
        if effective_track_policy == TRACK_EXCLUDE:
            return PublicRoadDecision(
                include=False,
                reason_code="exclude_track_policy",
                confidence=0.95,
                highway_type=highway,
            )
        if effective_track_policy == TRACK_INCLUDE:
            track_allowed = True
        else:
            track_allowed = _has_explicit_public_vehicle_access(values)
            if not track_allowed:
                return PublicRoadDecision(
                    include=False,
                    reason_code="exclude_track_unverified",
                    confidence=0.9,
                    highway_type=highway,
                )

    if _has_ambiguous_access(values):
        if effective_mode == MODE_STRICT:
            return PublicRoadDecision(
                include=False,
                reason_code="exclude_ambiguous_access_strict",
                confidence=0.8,
                highway_type=highway,
            )
        return PublicRoadDecision(
            include=True,
            reason_code="include_ambiguous_access",
            confidence=0.7 if highway != "track" else 0.6,
            highway_type=highway,
            ambiguous=True,
        )

    if highway == "track" and track_allowed:
        return PublicRoadDecision(
            include=True,
            reason_code="include_track_public_access",
            confidence=0.82,
            highway_type=highway,
        )

    return PublicRoadDecision(
        include=True,
        reason_code="include_public_drivable",
        confidence=0.95,
        highway_type=highway,
    )


def _classify_legacy(tags: Mapping[str, Any] | None) -> PublicRoadDecision:
    highway = _pick_driveable_highway((tags or {}).get("highway"), legacy=True)
    if highway is None:
        return PublicRoadDecision(
            include=False,
            reason_code="exclude_legacy_non_driveable_highway",
            confidence=1.0,
            highway_type=None,
        )
    return PublicRoadDecision(
        include=True,
        reason_code="include_legacy_driveable_highway",
        confidence=0.8,
        highway_type=highway,
    )


def _pick_driveable_highway(value: Any, *, legacy: bool = False) -> str | None:
    candidates = LEGACY_DRIVEABLE_HIGHWAY_TYPES if legacy else DRIVEABLE_HIGHWAY_TYPES
    for token in normalize_tag_values(value):
        if token in candidates:
            return token
    return None


def _has_hard_restriction(tags: Mapping[str, Any]) -> bool:
    for key in ACCESS_KEYS:
        values = normalize_tag_values(tags.get(key))
        if any(token in HARD_RESTRICTION_VALUES for token in values):
            return True
    return False


def _has_ambiguous_access(tags: Mapping[str, Any]) -> bool:
    for key in ACCESS_KEYS:
        values = normalize_tag_values(tags.get(key))
        if any(token in AMBIGUOUS_ACCESS_VALUES for token in values):
            return True

    conditional_raw = tags.get("access:conditional")
    if conditional_raw is None:
        return False
    if isinstance(conditional_raw, str):
        return bool(conditional_raw.strip())
    return True


def _has_explicit_public_vehicle_access(tags: Mapping[str, Any]) -> bool:
    for key in ACCESS_KEYS:
        values = normalize_tag_values(tags.get(key))
        if any(token in EXPLICIT_PUBLIC_ACCESS_VALUES for token in values):
            return True
    return False


def _coerce_tags_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str):
        raw = value.strip()
        if raw.startswith("{") and raw.endswith("}"):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                return {}
            if isinstance(parsed, Mapping):
                return dict(parsed)
    return {}


def _apply_aliases(tags: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(tags)
    for source_key, target_key in TAG_ALIASES.items():
        if source_key in normalized and target_key not in normalized:
            normalized[target_key] = normalized[source_key]
    return normalized


def _coerce_osm_id(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, list | tuple | set):
        for item in value:
            converted = _coerce_osm_id(item)
            if converted is not None:
                return converted
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
