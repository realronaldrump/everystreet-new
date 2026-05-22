"""Shared OSM extract identity and artifact freshness helpers."""

from __future__ import annotations

import contextlib
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from beanie.exceptions import CollectionWasNotInitialized

from config import require_osm_data_path, resolve_osm_data_path

EXTRACT_ID_ALGORITHM = "path-size-mtime-v1"

GRAPH_OSM_EXTRACT_ID_KEY = "everystreet_osm_extract_id"
GRAPH_OSM_EXTRACT_PATH_KEY = "everystreet_osm_extract_path"
GRAPH_OSM_EXTRACT_SIZE_BYTES_KEY = "everystreet_osm_extract_size_bytes"
GRAPH_OSM_EXTRACT_MTIME_KEY = "everystreet_osm_extract_mtime"
GRAPH_OSM_EXTRACT_ALGORITHM_KEY = "everystreet_osm_extract_algorithm"
GRAPH_BUILT_AT_KEY = "everystreet_graph_built_at"

ARTIFACT_CURRENT = "current"
ARTIFACT_STALE = "stale"
ARTIFACT_MISSING = "missing"
ARTIFACT_BUILDING = "building"
ARTIFACT_NOT_CONFIGURED = "not_configured"
ARTIFACT_NOT_APPLICABLE = "not_applicable"


def _path_stat(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return int(stat.st_size), int(stat.st_mtime_ns)


def _mtime_iso(mtime_ns: int) -> str:
    return datetime.fromtimestamp(mtime_ns / 1_000_000_000, UTC).isoformat()


def _normalize_path(path: str | Path) -> str:
    return str(Path(path).expanduser())


def _extract_id(path: str, size_bytes: int, mtime_ns: int) -> str:
    payload = {
        "algorithm": EXTRACT_ID_ALGORITHM,
        "path": path,
        "size_bytes": size_bytes,
        "mtime_ns": mtime_ns,
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"),
    ).hexdigest()[:16]
    return f"osm-{digest}"


def describe_osm_extract(path: str | Path) -> dict[str, Any]:
    """Return the local OSM extract identity used by all map-derived artifacts."""
    normalized_path = _normalize_path(path)
    size_bytes, mtime_ns = _path_stat(Path(normalized_path))
    return {
        "id": _extract_id(normalized_path, size_bytes, mtime_ns),
        "algorithm": EXTRACT_ID_ALGORITHM,
        "path": normalized_path,
        "size_bytes": size_bytes,
        "mtime_ns": mtime_ns,
        "mtime": _mtime_iso(mtime_ns),
    }


def require_resolved_osm_extract_metadata() -> dict[str, Any]:
    """Resolve and describe the local extract, raising if no local file exists."""
    return describe_osm_extract(require_osm_data_path())


def try_resolved_osm_extract_metadata() -> dict[str, Any] | None:
    path = resolve_osm_data_path()
    if not path:
        return None
    with contextlib.suppress(OSError):
        return describe_osm_extract(path)
    return None


def metadata_from_config(config: Any) -> dict[str, Any] | None:
    extract_id = str(getattr(config, "active_extract_id", "") or "").strip()
    extract_path = str(getattr(config, "active_extract_path", "") or "").strip()
    if not extract_id and not extract_path:
        return None
    return {
        "id": extract_id or None,
        "algorithm": getattr(config, "active_extract_algorithm", None)
        or EXTRACT_ID_ALGORITHM,
        "path": extract_path or None,
        "size_bytes": getattr(config, "active_extract_size_bytes", None),
        "mtime_ns": getattr(config, "active_extract_mtime_ns", None),
        "mtime": (
            getattr(config, "active_extract_mtime", None).isoformat()
            if getattr(config, "active_extract_mtime", None)
            else None
        ),
        "built_at": (
            getattr(config, "active_extract_built_at", None).isoformat()
            if getattr(config, "active_extract_built_at", None)
            else None
        ),
        "source_files": list(getattr(config, "active_extract_source_files", []) or []),
    }


async def get_configured_extract_identity() -> dict[str, Any] | None:
    """Return the configured active extract identity without requiring the file."""
    try:
        from map_data.models import MapServiceConfig

        config = await MapServiceConfig.get_or_create()
    except CollectionWasNotInitialized:
        return None
    return metadata_from_config(config)


async def get_preferred_osm_extract_metadata() -> dict[str, Any]:
    """
    Describe the extract coverage GraphML builds should use.

    A configured active map-service extract wins over ad-hoc environment
    resolution. If no active extract has been recorded yet, fall back to the
    local resolver so tests and first-time setup can still build from an
    explicit local OSM_DATA_PATH.
    """
    configured = await get_configured_extract_identity()
    configured_path = str((configured or {}).get("path") or "").strip()
    if configured_path:
        metadata = describe_osm_extract(configured_path)
        configured_id = str((configured or {}).get("id") or "").strip()
        if configured_id and metadata["id"] != configured_id:
            metadata["configured_id"] = configured_id
            metadata["configured_mismatch"] = True
        return metadata
    return require_resolved_osm_extract_metadata()


def graph_metadata_attributes(
    metadata: dict[str, Any],
    *,
    built_at: datetime | None = None,
) -> dict[str, str]:
    built = built_at or datetime.now(UTC)
    return {
        GRAPH_OSM_EXTRACT_ID_KEY: str(metadata.get("id") or ""),
        GRAPH_OSM_EXTRACT_PATH_KEY: str(metadata.get("path") or ""),
        GRAPH_OSM_EXTRACT_SIZE_BYTES_KEY: str(metadata.get("size_bytes") or ""),
        GRAPH_OSM_EXTRACT_MTIME_KEY: str(metadata.get("mtime") or ""),
        GRAPH_OSM_EXTRACT_ALGORITHM_KEY: str(
            metadata.get("algorithm") or EXTRACT_ID_ALGORITHM,
        ),
        GRAPH_BUILT_AT_KEY: built.isoformat(),
    }


def extract_graph_metadata(graph_attrs: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(graph_attrs.get(GRAPH_OSM_EXTRACT_ID_KEY) or "").strip() or None,
        "path": str(graph_attrs.get(GRAPH_OSM_EXTRACT_PATH_KEY) or "").strip() or None,
        "size_bytes": graph_attrs.get(GRAPH_OSM_EXTRACT_SIZE_BYTES_KEY),
        "mtime": str(graph_attrs.get(GRAPH_OSM_EXTRACT_MTIME_KEY) or "").strip()
        or None,
        "algorithm": str(
            graph_attrs.get(GRAPH_OSM_EXTRACT_ALGORITHM_KEY) or "",
        ).strip()
        or None,
        "built_at": str(graph_attrs.get(GRAPH_BUILT_AT_KEY) or "").strip() or None,
    }


def _status_from_counts(total: int, current: int, stale: int, missing: int) -> str:
    if total <= 0:
        return ARTIFACT_NOT_APPLICABLE
    if missing >= total:
        return ARTIFACT_MISSING
    if stale > 0 or missing > 0:
        return ARTIFACT_STALE
    if current >= total:
        return ARTIFACT_CURRENT
    return ARTIFACT_STALE


def _artifact_status(
    *,
    active_extract_id: str | None,
    artifact_extract_id: str | None,
    ready: bool,
    building: bool = False,
) -> str:
    if building:
        return ARTIFACT_BUILDING
    if not active_extract_id:
        return ARTIFACT_NOT_CONFIGURED
    if not ready or not artifact_extract_id:
        return ARTIFACT_MISSING
    if artifact_extract_id == active_extract_id:
        return ARTIFACT_CURRENT
    return ARTIFACT_STALE


async def _coverage_artifact_summary(active_extract_id: str | None) -> dict[str, Any]:
    try:
        from db.models import CoverageArea, Street
        from routing.constants import GRAPH_STORAGE_DIR
    except Exception:
        return {
            "areas_total": 0,
            "graph": {"status": ARTIFACT_MISSING},
            "streets": {"status": ARTIFACT_MISSING},
            "backfill": {"status": ARTIFACT_MISSING},
            "areas_needing_rebuild": [],
        }

    try:
        areas = await CoverageArea.find_all().to_list()
    except CollectionWasNotInitialized:
        areas = []

    graph_counts = {"current": 0, "stale": 0, "missing": 0}
    street_counts = {"current": 0, "stale": 0, "missing": 0}
    backfill_counts = {"current": 0, "stale": 0, "missing": 0}
    areas_needing_rebuild: list[dict[str, Any]] = []

    for area in areas:
        area_id = getattr(area, "id", None)
        if area_id is None:
            continue
        area_version = int(getattr(area, "area_version", 1) or 1)
        display_name = str(getattr(area, "display_name", area_id) or area_id)

        graph_path_raw = str(getattr(area, "graph_path", "") or "").strip()
        graph_path = (
            Path(graph_path_raw)
            if graph_path_raw
            else GRAPH_STORAGE_DIR / f"{area_id}.graphml"
        )
        graph_extract_id = str(getattr(area, "graph_extract_id", "") or "").strip()
        graph_exists = graph_path.exists()
        if not graph_exists:
            graph_counts["missing"] += 1
            graph_area_status = ARTIFACT_MISSING
        elif active_extract_id and graph_extract_id == active_extract_id:
            graph_counts["current"] += 1
            graph_area_status = ARTIFACT_CURRENT
        else:
            graph_counts["stale"] += 1
            graph_area_status = ARTIFACT_STALE

        street_total = 0
        street_current = 0
        try:
            street_total = await Street.find(
                Street.area_id == area_id,
                Street.area_version == area_version,
            ).count()
            if active_extract_id:
                street_current = await Street.find(
                    Street.area_id == area_id,
                    Street.area_version == area_version,
                    Street.osm_extract_id == active_extract_id,
                ).count()
        except CollectionWasNotInitialized:
            street_total = 0
            street_current = 0

        if street_total <= 0:
            street_counts["missing"] += 1
            street_area_status = ARTIFACT_MISSING
        elif active_extract_id and street_current == street_total:
            street_counts["current"] += 1
            street_area_status = ARTIFACT_CURRENT
        else:
            street_counts["stale"] += 1
            street_area_status = ARTIFACT_STALE

        backfill_extract_id = str(
            getattr(area, "coverage_backfill_extract_id", "") or "",
        ).strip()
        if not getattr(area, "last_synced", None):
            backfill_counts["missing"] += 1
            backfill_area_status = ARTIFACT_MISSING
        elif active_extract_id and backfill_extract_id == active_extract_id:
            backfill_counts["current"] += 1
            backfill_area_status = ARTIFACT_CURRENT
        else:
            backfill_counts["stale"] += 1
            backfill_area_status = ARTIFACT_STALE

        if (
            graph_area_status != ARTIFACT_CURRENT
            or street_area_status != ARTIFACT_CURRENT
            or backfill_area_status != ARTIFACT_CURRENT
        ):
            areas_needing_rebuild.append(
                {
                    "id": str(area_id),
                    "name": display_name,
                    "graph_status": graph_area_status,
                    "streets_status": street_area_status,
                    "backfill_status": backfill_area_status,
                },
            )

    total = len(areas)
    return {
        "areas_total": total,
        "graph": {
            "status": _status_from_counts(
                total,
                graph_counts["current"],
                graph_counts["stale"],
                graph_counts["missing"],
            ),
            **graph_counts,
        },
        "streets": {
            "status": _status_from_counts(
                total,
                street_counts["current"],
                street_counts["stale"],
                street_counts["missing"],
            ),
            **street_counts,
        },
        "backfill": {
            "status": _status_from_counts(
                total,
                backfill_counts["current"],
                backfill_counts["stale"],
                backfill_counts["missing"],
            ),
            **backfill_counts,
        },
        "areas_needing_rebuild": areas_needing_rebuild[:10],
        "areas_needing_rebuild_count": len(areas_needing_rebuild),
    }


async def build_local_osm_artifact_status(
    *,
    config: Any,
    health: Any | None = None,
    is_building: bool = False,
) -> dict[str, Any]:
    active_extract = metadata_from_config(config)
    pending_extract_id = str(getattr(config, "pending_extract_id", "") or "").strip()
    active_extract_id = str((active_extract or {}).get("id") or "").strip() or None
    active_path = str((active_extract or {}).get("path") or "").strip()
    active_exists = bool(active_path and Path(active_path).exists())
    active_file_changed = False

    if active_exists:
        with contextlib.suppress(OSError):
            actual_extract = describe_osm_extract(active_path)
            configured_id = active_extract_id
            if configured_id and actual_extract["id"] != configured_id:
                actual_extract["configured_id"] = configured_id
                actual_extract["configured_mismatch"] = True
                active_extract = actual_extract
                active_extract_id = str(actual_extract["id"])
                active_file_changed = True
            elif not configured_id:
                active_extract = actual_extract
                active_extract_id = str(actual_extract["id"])

    if not active_extract:
        resolved = try_resolved_osm_extract_metadata()
        if resolved:
            active_extract = resolved | {"configured": False}
            active_extract_id = str(resolved.get("id") or "")
            active_path = str(resolved.get("path") or "")
            active_exists = True

    if pending_extract_id:
        extract_status = ARTIFACT_BUILDING
    elif not active_extract_id:
        extract_status = ARTIFACT_NOT_CONFIGURED
    elif active_file_changed:
        extract_status = ARTIFACT_STALE
    elif not active_exists:
        extract_status = ARTIFACT_MISSING
    else:
        extract_status = ARTIFACT_CURRENT

    nominatim_extract_id = (
        str(getattr(config, "nominatim_extract_id", "") or "").strip() or None
    )
    valhalla_extract_id = (
        str(getattr(config, "valhalla_extract_id", "") or "").strip() or None
    )

    nominatim_ready = bool(
        getattr(health, "nominatim_has_data", False)
        or getattr(config, "geocoding_ready", False),
    )
    valhalla_ready = bool(
        getattr(health, "valhalla_has_data", False)
        or getattr(config, "routing_ready", False),
    )

    coverage = await _coverage_artifact_summary(active_extract_id)

    artifacts = [
        {
            "key": "nominatim",
            "label": "Nominatim import",
            "status": _artifact_status(
                active_extract_id=active_extract_id,
                artifact_extract_id=nominatim_extract_id,
                ready=nominatim_ready,
                building=is_building
                and getattr(config, "status", "") == config.STATUS_BUILDING,
            ),
            "extract_id": nominatim_extract_id,
        },
        {
            "key": "valhalla",
            "label": "Valhalla tiles",
            "status": _artifact_status(
                active_extract_id=active_extract_id,
                artifact_extract_id=valhalla_extract_id,
                ready=valhalla_ready,
                building=is_building
                and getattr(config, "status", "") == config.STATUS_BUILDING,
            ),
            "extract_id": valhalla_extract_id,
        },
        {
            "key": "graphml",
            "label": "Coverage GraphML files",
            "status": coverage["graph"]["status"],
            "summary": coverage["graph"],
        },
        {
            "key": "streets",
            "label": "Mongo Street records",
            "status": coverage["streets"]["status"],
            "summary": coverage["streets"],
        },
        {
            "key": "backfill",
            "label": "Coverage/backfill results",
            "status": coverage["backfill"]["status"],
            "summary": coverage["backfill"],
        },
    ]

    stale_count = sum(
        1
        for artifact in artifacts
        if artifact["status"] in {ARTIFACT_STALE, ARTIFACT_MISSING}
    )
    overall_status = extract_status
    if extract_status == ARTIFACT_CURRENT and stale_count:
        overall_status = ARTIFACT_STALE

    return {
        "status": overall_status,
        "active_extract": active_extract,
        "active_extract_status": extract_status,
        "pending_extract": (
            {
                "id": pending_extract_id,
                "path": getattr(config, "pending_extract_path", None),
                "started_at": (
                    getattr(config, "pending_extract_started_at", None).isoformat()
                    if getattr(config, "pending_extract_started_at", None)
                    else None
                ),
            }
            if pending_extract_id
            else None
        ),
        "artifacts": artifacts,
        "coverage": coverage,
        "stale_artifact_count": stale_count,
    }
