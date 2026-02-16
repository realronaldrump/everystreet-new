"""
Script to preprocess and save OSM graphs for coverage areas to disk.

This script:
1. Connects to MongoDB to fetch all coverage areas.
2. For each area:
    a. Gets the boundary polygon.
    b. Buffers it slightly (ROUTING_BUFFER_FT).
    c. Loads the driveable street network from a local OSM extract (XML/PBF)
       configured via OSM_DATA_PATH.
    d. Saves the graph as a .graphml file to `data/graphs/{location_id}.graphml`.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import uuid
import warnings
from pathlib import Path
from typing import Any

import networkx as nx
from dotenv import load_dotenv
from shapely.geometry import box, mapping, shape

from config import get_osm_extracts_path, require_osm_data_path, resolve_osm_data_path
from core.spatial import buffer_polygon_for_routing
from routing.constants import GRAPH_STORAGE_DIR, ROUTING_BUFFER_FT
from street_coverage.public_road_filter import (
    GRAPH_ROAD_FILTER_SIGNATURE_KEY,
    GRAPH_ROAD_FILTER_STATS_KEY,
    GRAPH_ROAD_FILTER_VERSION_KEY,
    PublicRoadFilterAudit,
    classify_public_road,
    extract_relevant_tags,
    get_public_road_filter_signature,
    get_public_road_filter_version,
)

logger = logging.getLogger(__name__)

OSM_EXTENSIONS = {".osm", ".xml", ".pbf"}
DEFAULT_AREA_EXTRACT_THRESHOLD_MB = 256
# Lowered from 4096 to reduce memory pressure on constrained systems
DEFAULT_GRAPH_MEMORY_LIMIT_MB = 2048
DEFAULT_GRAPH_TILE_START_GRID = 2
DEFAULT_GRAPH_TILE_MAX_GRID = 6
DEFAULT_GRAPH_TILE_OVERLAP_RATIO = 0.03
DEFAULT_GRAPH_TILE_OVERLAP_MIN_DEG = 0.0005
_TRUE_LITERALS = {"true", "t", "1", "yes", "y", "on"}
_FALSE_LITERALS = {"false", "f", "0", "no", "n", "off"}

_REQUIRED_OSMNX_WAY_TAGS = {
    "highway",
    "name",
    "service",
    "access",
    "vehicle",
    "motor_vehicle",
    "motorcar",
    "access:conditional",
    "area",
}

_RELEVANT_EDGE_TAG_KEYS = (
    "highway",
    "name",
    "service",
    "access",
    "vehicle",
    "motor_vehicle",
    "motorcar",
    "access:conditional",
    "area",
)

_PYROSM_EXTRA_ATTRIBUTES = [
    "name",
    "highway",
    "service",
    "access",
    "vehicle",
    "motor_vehicle",
    "motorcar",
    "access:conditional",
    "area",
]


def _get_area_extract_threshold_mb() -> int:
    raw = os.getenv("OSM_AREA_EXTRACT_THRESHOLD_MB", "").strip()
    if not raw:
        return DEFAULT_AREA_EXTRACT_THRESHOLD_MB
    try:
        return max(int(raw), 0)
    except ValueError:
        return DEFAULT_AREA_EXTRACT_THRESHOLD_MB


def _is_area_extract_required() -> bool:
    raw = os.getenv("OSM_AREA_EXTRACT_REQUIRED", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _get_available_memory_mb() -> int | None:
    """
    Detect available system memory in MB.

    Returns None if unable to detect.
    """
    try:
        # Try to get memory info (Linux)
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    # Value is in kB
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return None


def _get_graph_memory_limit_mb() -> int:
    """
    Get graph memory limit with auto-scaling for memory-constrained systems.

    Priority:
    1. COVERAGE_GRAPH_MAX_MB environment variable (explicit override)
    2. Auto-scaled based on available system RAM (use ~25% of available)
    3. DEFAULT_GRAPH_MEMORY_LIMIT_MB fallback
    """
    raw = os.getenv("COVERAGE_GRAPH_MAX_MB", "").strip()
    if raw:
        try:
            return max(int(raw), 0)
        except ValueError:
            pass

    # Auto-scale based on available memory
    available_mb = _get_available_memory_mb()
    if available_mb is not None:
        # Use at most 25% of available RAM, capped at default
        auto_limit = min(available_mb // 4, DEFAULT_GRAPH_MEMORY_LIMIT_MB)
        # Ensure at least 512MB for very constrained systems
        auto_limit = max(auto_limit, 512)
        logger.info(
            "Auto-detected available memory: %d MB, using graph limit: %d MB",
            available_mb,
            auto_limit,
        )
        return auto_limit

    return DEFAULT_GRAPH_MEMORY_LIMIT_MB


def _get_graph_tile_grid_start() -> int:
    raw = os.getenv("COVERAGE_GRAPH_TILE_GRID_START", "").strip()
    if not raw:
        return DEFAULT_GRAPH_TILE_START_GRID
    try:
        return max(int(raw), 2)
    except ValueError:
        return DEFAULT_GRAPH_TILE_START_GRID


def _get_graph_tile_grid_max() -> int:
    raw = os.getenv("COVERAGE_GRAPH_TILE_GRID_MAX", "").strip()
    if not raw:
        return DEFAULT_GRAPH_TILE_MAX_GRID
    try:
        return max(int(raw), _get_graph_tile_grid_start())
    except ValueError:
        return DEFAULT_GRAPH_TILE_MAX_GRID


def _get_graph_tile_overlap_ratio() -> float:
    raw = os.getenv("COVERAGE_GRAPH_TILE_OVERLAP_RATIO", "").strip()
    if not raw:
        return DEFAULT_GRAPH_TILE_OVERLAP_RATIO
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_GRAPH_TILE_OVERLAP_RATIO
    return min(max(value, 0.0), 0.25)


def _write_geojson(path: Path, geometry: Any) -> None:
    feature = {"type": "Feature", "properties": {}, "geometry": mapping(geometry)}
    data = {"type": "FeatureCollection", "features": [feature]}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _build_extract_cache_key(location_id: str, area_version: Any | None) -> str:
    if area_version is None:
        return location_id
    with contextlib.suppress(Exception):
        return f"{location_id}-v{int(area_version)}"
    raw = str(area_version).strip()
    if not raw:
        return location_id
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    return f"{location_id}-v{digest}"


def _maybe_extract_area_pbf(
    source_path: Path,
    routing_polygon: Any,
    extract_cache_key: str,
    *,
    require_extract: bool = False,
    threshold_mb: int | None = None,
) -> Path | None:
    threshold_mb = (
        _get_area_extract_threshold_mb() if threshold_mb is None else threshold_mb
    )
    if threshold_mb <= 0:
        return None
    try:
        size_mb = source_path.stat().st_size / (1024 * 1024)
    except OSError:
        return None
    if size_mb < threshold_mb:
        return None

    extracts_root_str = (get_osm_extracts_path() or "").strip()
    if not extracts_root_str:
        if require_extract:
            msg = "Area extract required for large OSM files, but OSM_EXTRACTS_PATH is not set."
            raise RuntimeError(msg)
        return None
    extracts_root = Path(extracts_root_str)
    area_dir = extracts_root / "coverage" / "areas"
    area_dir.mkdir(parents=True, exist_ok=True)
    area_pbf = area_dir / f"{extract_cache_key}.osm.pbf"
    area_geojson = area_dir / f"{extract_cache_key}.geojson"
    if area_pbf.exists() and area_pbf.stat().st_size > 0:
        logger.info("Using cached area extract: %s", area_pbf)
        return area_pbf

    _write_geojson(area_geojson, routing_polygon)
    # Use .tmp.osm.pbf (not .osm.pbf.tmp) - osmium detects format from extension
    tmp_pbf = area_dir / f"{extract_cache_key}.tmp.osm.pbf"
    cmd = [
        "osmium",
        "extract",
        "-p",
        str(area_geojson),
        "-o",
        str(tmp_pbf),
        "--overwrite",
        str(source_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        logger.warning("osmium not available; skipping area extract.")
        if require_extract:
            msg = (
                "osmium is required to extract large OSM files. "
                "Install osmium or set OSM_AREA_EXTRACT_REQUIRED=0 to allow "
                "loading the full extract (not recommended)."
            )
            raise RuntimeError(msg)
        return None

    if result.returncode != 0:
        err = (result.stderr or "").strip() or "osmium extract failed"
        logger.warning("Area extract failed: %s", err)
        with contextlib.suppress(FileNotFoundError):
            tmp_pbf.unlink()
        if require_extract:
            msg = (
                f"Area extract failed: {err}. "
                "Install osmium or reduce the extract size."
            )
            raise RuntimeError(msg)
        return None

    if not tmp_pbf.exists() or tmp_pbf.stat().st_size == 0:
        logger.warning("Area extract produced empty output.")
        with contextlib.suppress(FileNotFoundError):
            tmp_pbf.unlink()
        if require_extract:
            msg = "Area extract produced empty output."
            raise RuntimeError(msg)
        return None

    tmp_pbf.replace(area_pbf)
    logger.info("Area extract ready: %s", area_pbf)
    return area_pbf


def _run_osmium_extract(
    source_path: Path,
    polygon_geojson: Path,
    output_pbf: Path,
) -> subprocess.CompletedProcess[str]:
    cmd = [
        "osmium",
        "extract",
        "-p",
        str(polygon_geojson),
        "-o",
        str(output_pbf),
        "--overwrite",
        str(source_path),
    ]
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def _extract_polygon_pbf(
    source_path: Path,
    polygon: Any,
    output_pbf: Path,
) -> bool:
    output_pbf.parent.mkdir(parents=True, exist_ok=True)
    polygon_geojson = output_pbf.with_suffix(".geojson")
    _write_geojson(polygon_geojson, polygon)

    try:
        result = _run_osmium_extract(source_path, polygon_geojson, output_pbf)
    except FileNotFoundError as exc:
        msg = (
            "osmium is required for tiled graph builds after memory-limit failures. "
            "Install osmium or increase COVERAGE_GRAPH_MAX_MB."
        )
        raise RuntimeError(msg) from exc

    if result.returncode != 0:
        err = (result.stderr or "").strip() or "osmium extract failed"
        msg = f"Tile extract failed: {err}"
        raise RuntimeError(msg)

    return output_pbf.exists() and output_pbf.stat().st_size > 0


def _looks_like_memory_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    patterns = (
        "memory limit",
        "exceeded memory",
        "cannot allocate memory",
        "std::bad_alloc",
        "memoryerror",
    )
    return any(pattern in msg for pattern in patterns)


def _iter_polygon_tiles(polygon: Any, grid_size: int) -> list[Any]:
    if grid_size <= 1:
        return [polygon]

    minx, miny, maxx, maxy = polygon.bounds
    width = float(maxx - minx)
    height = float(maxy - miny)
    if width <= 0 or height <= 0:
        return [polygon]

    dx = width / grid_size
    dy = height / grid_size
    overlap_ratio = _get_graph_tile_overlap_ratio()
    overlap_x = max(dx * overlap_ratio, DEFAULT_GRAPH_TILE_OVERLAP_MIN_DEG)
    overlap_y = max(dy * overlap_ratio, DEFAULT_GRAPH_TILE_OVERLAP_MIN_DEG)

    tiles: list[Any] = []
    for ix in range(grid_size):
        left = minx + ix * dx - overlap_x
        right = minx + (ix + 1) * dx + overlap_x
        for iy in range(grid_size):
            bottom = miny + iy * dy - overlap_y
            top = miny + (iy + 1) * dy + overlap_y
            tile = box(left, bottom, right, top)
            clip = polygon.intersection(tile)
            if clip.is_empty:
                continue
            if float(getattr(clip, "area", 0.0)) <= 0.0:
                continue
            tiles.append(clip)

    return tiles or [polygon]


def _get_osmnx():
    import osmnx as ox

    return ox


def _ensure_osmnx_useful_way_tags(ox: Any) -> None:
    """
    Ensure graph builders retain tags required for public-road classification.
    """
    current = getattr(ox.settings, "useful_tags_way", None)
    if not isinstance(current, list):
        current = list(current or [])
    merged = list(current)
    seen = set(current)
    for key in _REQUIRED_OSMNX_WAY_TAGS:
        if key in seen:
            continue
        merged.append(key)
        seen.add(key)
    ox.settings.useful_tags_way = merged


def _coerce_osmnx_bool(value: Any) -> bool | None:
    # OSMnx's GraphML loader only accepts "True"/"False" (or bool) for bool attrs.
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return bool(value)
    if isinstance(value, str):
        raw = value.strip()
        if raw in {"True", "False"}:
            return raw == "True"
        lowered = raw.lower()
        if lowered in _TRUE_LITERALS:
            return True
        if lowered in _FALSE_LITERALS:
            return False
        if lowered == "-1":
            return True
    return None


def _sanitize_graph_for_graphml(G: nx.MultiDiGraph) -> None:
    # Some graphs (notably pyrosm) emit "yes"/"no" strings for `oneway`, which
    # OSMnx can't round-trip via GraphML (`load_graphml` expects "True"/"False").
    for key in ("simplified", "consolidated"):
        if key not in G.graph:
            continue
        coerced = _coerce_osmnx_bool(G.graph.get(key))
        if coerced is None:
            G.graph.pop(key, None)
        else:
            G.graph[key] = coerced

    for _u, _v, _k, data in G.edges(keys=True, data=True):
        # Provide a consistent OSM id key for downstream matching/indexing.
        if "osmid" not in data and "id" in data:
            data["osmid"] = data.get("id")

        for key in ("oneway", "reversed"):
            if key not in data:
                continue
            coerced = _coerce_osmnx_bool(data.get(key))
            if coerced is None:
                data.pop(key, None)
            else:
                data[key] = coerced


def _graph_from_pbf(osm_path: Path) -> nx.MultiDiGraph:
    ox = _get_osmnx()
    try:
        from pyrosm import OSM
    except ImportError as exc:
        msg = "pyrosm is required to load .pbf extracts. Install it to use OSM_DATA_PATH with .pbf."
        raise RuntimeError(msg) from exc

    # Pandas Copy-on-Write breaks some third-party chained assignments (pyrosm),
    # producing noisy warnings and potentially incorrect results. Force it off.
    with contextlib.suppress(Exception):
        import pandas as pd

        pd.options.mode.copy_on_write = False
        with contextlib.suppress(Exception):
            warnings.filterwarnings("ignore", category=pd.errors.ChainedAssignmentError)

    osm = OSM(str(osm_path))
    try:
        network = osm.get_network(
            network_type="driving",
            nodes=True,
            extra_attributes=_PYROSM_EXTRA_ATTRIBUTES,
        )
    except TypeError:
        try:
            network = osm.get_network(network_type="driving", nodes=True)
        except TypeError:
            network = osm.get_network(network_type="driving")

    if isinstance(network, nx.MultiDiGraph):
        return network
    if isinstance(network, tuple) and len(network) == 2:
        nodes_edges = _coerce_nodes_edges(network)
        if nodes_edges is not None:
            nodes_gdf, edges_gdf = nodes_edges
            graph = _try_pyrosm_to_graph(osm, nodes_gdf, edges_gdf)
            if graph is not None:
                return graph
            nodes_gdf, edges_gdf = _normalize_pyrosm_gdfs(nodes_gdf, edges_gdf)
            return ox.graph_from_gdfs(nodes_gdf, edges_gdf)

    msg = "Pyrosm returned unexpected network data for .pbf extraction."
    raise RuntimeError(msg)


def _to_graphml_scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, list | tuple | set):
        return ";".join(str(item) for item in value if item is not None)
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True)
    return value


def _prune_non_driveable_edges(G: nx.MultiDiGraph) -> dict[str, Any]:
    """
    Remove non-public roads based on v2 public-road classifier rules.

    Returns an audit payload with include/exclude diagnostics.
    """
    audit = PublicRoadFilterAudit()
    non_public: list[tuple[Any, Any, Any]] = []

    for u, v, k, data in G.edges(keys=True, data=True):
        tags = extract_relevant_tags(data)
        decision = classify_public_road(tags)
        audit.record(decision, osm_id=data.get("osmid") or data.get("id"))

        if not decision.include:
            non_public.append((u, v, k))
            continue

        if decision.highway_type:
            data["highway"] = decision.highway_type

        for key in _RELEVANT_EDGE_TAG_KEYS:
            if key in data:
                continue
            value = tags.get(key)
            scalar = _to_graphml_scalar(value)
            if scalar is not None:
                data[key] = scalar

    if non_public:
        G.remove_edges_from(non_public)
        G.remove_nodes_from(list(nx.isolates(G)))

    stats = audit.to_dict()
    G.graph[GRAPH_ROAD_FILTER_VERSION_KEY] = get_public_road_filter_version()
    G.graph[GRAPH_ROAD_FILTER_SIGNATURE_KEY] = get_public_road_filter_signature()
    G.graph[GRAPH_ROAD_FILTER_STATS_KEY] = json.dumps(stats, sort_keys=True)
    return stats


def _ensure_edge_lengths(G: nx.MultiDiGraph) -> nx.MultiDiGraph:
    if G.number_of_edges() <= 0:
        return G
    missing_length = any(
        "length" not in data for _, _, _, data in G.edges(keys=True, data=True)
    )
    if not missing_length:
        return G
    ox = _get_osmnx()
    return ox.distance.add_edge_lengths(G)


def _atomic_save_graphml(G: nx.MultiDiGraph, graph_path: Path) -> None:
    graph_path = Path(graph_path)
    graph_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = graph_path.with_name(
        f".{graph_path.name}.{uuid.uuid4().hex}.tmp.graphml",
    )
    try:
        _get_osmnx().save_graphml(G, filepath=tmp_path)
        if not tmp_path.exists() or tmp_path.stat().st_size <= 0:
            msg = f"GraphML write produced empty file: {tmp_path}"
            raise RuntimeError(msg)
        tmp_path.replace(graph_path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp_path.unlink()


def _build_graph_in_process(
    osm_path: Path,
    routing_polygon: Any,
    graph_path: Path,
) -> nx.MultiDiGraph:
    G = _load_graph_from_extract(osm_path, routing_polygon)
    if not isinstance(G, nx.MultiDiGraph):
        G = nx.MultiDiGraph(G)
    _prune_non_driveable_edges(G)
    G = _ensure_edge_lengths(G)

    _sanitize_graph_for_graphml(G)
    _atomic_save_graphml(G, graph_path)
    return G


def _apply_memory_limit(max_mb: int) -> None:
    if max_mb <= 0:
        return
    try:
        import resource

        max_bytes = max_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (max_bytes, max_bytes))
    except Exception as exc:
        logger.warning("Unable to apply memory limit: %s", exc)


def _graph_build_worker(
    osm_path_str: str,
    routing_geojson: dict[str, Any],
    graph_path_str: str,
    max_mb: int,
    result_queue: Any,
) -> None:
    try:
        _apply_memory_limit(max_mb)
        from shapely.geometry import shape

        routing_polygon = shape(routing_geojson)
        G = _build_graph_in_process(
            Path(osm_path_str),
            routing_polygon,
            Path(graph_path_str),
        )
        result_queue.put(
            {
                "success": True,
                "nodes": int(G.number_of_nodes()),
                "edges": int(G.number_of_edges()),
            },
        )
    except MemoryError:
        result_queue.put(
            {
                "success": False,
                "error": (
                    f"Graph build exceeded memory limit of {max_mb} MB. "
                    "Increase COVERAGE_GRAPH_MAX_MB or reduce the extract size."
                ),
            },
        )
    except Exception as exc:
        result_queue.put({"success": False, "error": str(exc)})


def _build_graph_in_subprocess(
    osm_path: Path,
    routing_polygon: Any,
    graph_path: Path,
    max_mb: int,
) -> None:
    import multiprocessing as mp

    from shapely.geometry import mapping

    ctx = mp.get_context("spawn")
    result_queue = ctx.Queue()
    routing_geojson = mapping(routing_polygon)
    proc = ctx.Process(
        target=_graph_build_worker,
        args=(str(osm_path), routing_geojson, str(graph_path), max_mb, result_queue),
    )
    proc.start()
    proc.join()

    result = None
    if not result_queue.empty():
        result = result_queue.get()

    if result and not result.get("success"):
        raise RuntimeError(result.get("error") or "Graph build failed.")

    if proc.exitcode and proc.exitcode != 0:
        msg = f"Graph build failed or exceeded memory limit. Memory limit: {max_mb} MB."
        raise RuntimeError(msg)


def _build_graph_with_tiled_fallback(
    osm_path: Path,
    routing_polygon: Any,
    graph_path: Path,
    max_mb: int,
    *,
    location_id: str,
) -> nx.MultiDiGraph:
    from core.osmnx_graphml import load_graphml_robust

    ox = _get_osmnx()
    tile_root = graph_path.parent / "_tile_build" / location_id
    tile_root.mkdir(parents=True, exist_ok=True)

    start_grid = _get_graph_tile_grid_start()
    max_grid = _get_graph_tile_grid_max()
    last_memory_error: Exception | None = None

    try:
        for grid_size in range(start_grid, max_grid + 1):
            tiles = _iter_polygon_tiles(routing_polygon, grid_size)
            logger.warning(
                "Retrying graph build in tiled mode for %s: %dx%d grid (%d tiles)",
                location_id,
                grid_size,
                grid_size,
                len(tiles),
            )

            merged = nx.MultiDiGraph()
            tile_fail_memory = False
            built_tile_count = 0

            for idx, tile_polygon in enumerate(tiles, start=1):
                tile_prefix = tile_root / f"g{grid_size}_tile{idx}"
                tile_extract = tile_prefix.with_suffix(".osm.pbf")
                tile_graph = tile_prefix.with_suffix(".graphml")

                try:
                    has_extract = _extract_polygon_pbf(
                        osm_path,
                        tile_polygon,
                        tile_extract,
                    )
                    if not has_extract:
                        continue

                    _build_graph_with_limit(
                        tile_extract,
                        tile_polygon,
                        tile_graph,
                        max_mb,
                        location_id=f"{location_id}-g{grid_size}-{idx}",
                        allow_tiled_fallback=False,
                    )

                    if not tile_graph.exists() or tile_graph.stat().st_size <= 0:
                        continue

                    tile_g = load_graphml_robust(tile_graph)
                    if not isinstance(tile_g, nx.MultiDiGraph):
                        tile_g = nx.MultiDiGraph(tile_g)
                    merged = nx.compose(merged, tile_g)
                    built_tile_count += 1
                except Exception as exc:
                    if _looks_like_memory_error(exc):
                        logger.warning(
                            "Tile %d/%d failed at %dx%d grid due to memory pressure: %s",
                            idx,
                            len(tiles),
                            grid_size,
                            grid_size,
                            exc,
                        )
                        tile_fail_memory = True
                        last_memory_error = exc
                        break
                    raise
                finally:
                    with contextlib.suppress(FileNotFoundError):
                        tile_extract.unlink()
                    with contextlib.suppress(FileNotFoundError):
                        tile_extract.with_suffix(".geojson").unlink()
                    with contextlib.suppress(FileNotFoundError):
                        tile_graph.unlink()

            if tile_fail_memory:
                continue

            if built_tile_count <= 0 or merged.number_of_edges() <= 0:
                logger.warning(
                    "Tiled graph build produced no usable edges at %dx%d grid.",
                    grid_size,
                    grid_size,
                )
                continue

            merged = ox.truncate.truncate_graph_polygon(
                merged,
                routing_polygon,
                truncate_by_edge=True,
            )
            _prune_non_driveable_edges(merged)
            merged = _ensure_edge_lengths(merged)
            _sanitize_graph_for_graphml(merged)
            _atomic_save_graphml(merged, graph_path)
            return merged
    finally:
        shutil.rmtree(tile_root, ignore_errors=True)

    if last_memory_error is not None:
        msg = (
            "Graph build exceeded memory limits even with tiled fallback. "
            "Increase COVERAGE_GRAPH_MAX_MB or reduce area size."
        )
        raise RuntimeError(msg) from last_memory_error

    msg = "Tiled graph fallback did not produce a valid graph."
    raise RuntimeError(msg)


def _build_graph_with_limit(
    osm_path: Path,
    routing_polygon: Any,
    graph_path: Path,
    max_mb: int,
    *,
    location_id: str | None = None,
    allow_tiled_fallback: bool = True,
) -> nx.MultiDiGraph | None:
    if max_mb <= 0:
        return _build_graph_in_process(osm_path, routing_polygon, graph_path)

    try:
        _build_graph_in_subprocess(osm_path, routing_polygon, graph_path, max_mb)
    except Exception as exc:
        if not allow_tiled_fallback or not _looks_like_memory_error(exc):
            raise
        location_label = location_id or graph_path.stem
        logger.warning(
            "Graph build hit memory limit (%s). Switching to tiled fallback for %s.",
            exc,
            location_label,
        )
        return _build_graph_with_tiled_fallback(
            osm_path,
            routing_polygon,
            graph_path,
            max_mb,
            location_id=location_label,
        )
    else:
        return None


def _coerce_nodes_edges(network: tuple[Any, Any]) -> tuple[Any, Any] | None:
    nodes_gdf, edges_gdf = network

    def _has_columns(obj: Any) -> bool:
        return hasattr(obj, "columns")

    def _is_edges(obj: Any) -> bool:
        return _has_columns(obj) and "u" in obj.columns and "v" in obj.columns

    def _is_nodes(obj: Any) -> bool:
        return _has_columns(obj) and (
            ("x" in obj.columns and "y" in obj.columns)
            or ("lon" in obj.columns and "lat" in obj.columns)
        )

    if _is_nodes(nodes_gdf) and _is_edges(edges_gdf):
        return nodes_gdf, edges_gdf
    if _is_edges(nodes_gdf) and _is_nodes(edges_gdf):
        return edges_gdf, nodes_gdf
    return None


def _try_pyrosm_to_graph(
    osm: Any,
    nodes_gdf: Any,
    edges_gdf: Any,
) -> nx.MultiDiGraph | None:
    if not hasattr(osm, "to_graph"):
        return None
    try:
        graph = osm.to_graph(nodes_gdf, edges_gdf)
    except Exception:
        return None
    if isinstance(graph, nx.MultiDiGraph):
        return graph
    return None


def _normalize_pyrosm_gdfs(nodes_gdf: Any, edges_gdf: Any) -> tuple[Any, Any]:
    import pandas as pd

    nodes = nodes_gdf.copy()
    edges = edges_gdf.copy()

    if (
        ("x" not in nodes.columns or "y" not in nodes.columns)
        and "lon" in nodes.columns
        and "lat" in nodes.columns
    ):
        nodes["x"] = nodes["lon"]
        nodes["y"] = nodes["lat"]

    # OSMnx expects the nodes GeoDataFrame to be uniquely indexed by osmid.
    if nodes.index.name != "osmid" or not nodes.index.is_unique:
        if "osmid" in nodes.columns:
            nodes = nodes.set_index("osmid", drop=False)
        elif "id" in nodes.columns:
            # Pyrosm uses `id` for node ids. Keep values but normalize index name.
            nodes = nodes.set_index("id", drop=False)
            nodes.index.rename("osmid", inplace=True)
        elif nodes.index.name == "id" and nodes.index.is_unique:
            # Some pyrosm versions return nodes already indexed by `id` without a column.
            nodes.index.rename("osmid", inplace=True)

    if not nodes.index.is_unique:
        dup_count = int(nodes.index.duplicated(keep="first").sum())
        logger.warning(
            "Pyrosm nodes GeoDataFrame has %d duplicate node ids; dropping duplicates.",
            dup_count,
        )
        nodes = nodes[~nodes.index.duplicated(keep="first")].copy()

    # OSMnx expects edges to be uniquely indexed by (u, v, key).
    needs_edge_index = not isinstance(edges.index, pd.MultiIndex) or list(
        edges.index.names,
    ) != ["u", "v", "key"]

    if needs_edge_index:
        # Ensure u/v are present as columns so we can build an OSMnx-compatible
        # MultiIndex, even if the incoming dataframe used them as index levels.
        if "u" not in edges.columns or "v" not in edges.columns:
            edges = edges.reset_index()

        # Drop malformed edges (can't be represented in a (u, v, key) index).
        if "u" in edges.columns and "v" in edges.columns:
            bad_uv = edges["u"].isna() | edges["v"].isna()
            if bool(bad_uv.any()):
                dropped = int(bad_uv.sum())
                logger.warning(
                    "Pyrosm edges GeoDataFrame has %d rows with null u/v; dropping them.",
                    dropped,
                )
                edges = edges.loc[~bad_uv].copy()

        # If pyrosm didn't provide an edge key, create one per (u, v) so parallel
        # edges are preserved and index uniqueness is guaranteed.
        if "key" not in edges.columns:
            edges["key"] = edges.groupby(["u", "v"], sort=False).cumcount().astype(int)

        edges = edges.set_index(["u", "v", "key"])

    if not edges.index.is_unique:
        # A non-unique (u, v, key) will crash `ox.graph_from_gdfs`. Force a stable
        # per-(u, v) key assignment to preserve parallel edges.
        edges = edges.reset_index()
        edges["key"] = edges.groupby(["u", "v"], sort=False).cumcount().astype(int)
        edges = edges.set_index(["u", "v", "key"])

    if not edges.index.is_unique:
        dup_count = int(edges.index.duplicated(keep="first").sum())
        logger.warning(
            "Pyrosm edges GeoDataFrame still has %d duplicate edge ids after key normalization; dropping duplicates.",
            dup_count,
        )
        edges = edges[~edges.index.duplicated(keep="first")].copy()

    return nodes, edges


def _load_graph_from_extract(osm_path: Path, routing_polygon: Any) -> nx.MultiDiGraph:
    ox = _get_osmnx()
    _ensure_osmnx_useful_way_tags(ox)
    suffix = osm_path.suffix.lower()
    if suffix in {".osm", ".xml"}:
        G = ox.graph_from_xml(
            osm_path,
            simplify=True,
            retain_all=True,
        )
    elif suffix == ".pbf":
        G = _graph_from_pbf(osm_path)
    else:
        msg = (
            "OSM_DATA_PATH must point to an OSM extract (.osm, .xml, or .pbf) "
            "exported from your Valhalla/Nominatim data."
        )
        raise ValueError(msg)

    if not isinstance(G, nx.MultiDiGraph):
        G = nx.MultiDiGraph(G)
    G = ox.truncate.truncate_graph_polygon(
        G,
        routing_polygon,
        truncate_by_edge=True,
    )
    if G.number_of_edges() > 0:
        missing_length = any(
            "length" not in data for _, _, _, data in G.edges(keys=True, data=True)
        )
        if missing_length:
            G = ox.distance.add_edge_lengths(G)
    return G


def _validate_osm_path(osm_path: Path) -> None:
    if not osm_path.exists():
        msg = f"OSM data file not found: {osm_path}"
        raise FileNotFoundError(msg)
    if osm_path.suffix.lower() not in OSM_EXTENSIONS:
        msg = (
            "OSM_DATA_PATH must point to an OSM extract (.osm, .xml, or .pbf) "
            "exported from your Valhalla/Nominatim data."
        )
        raise ValueError(
            msg,
        )


async def preprocess_streets(
    location: dict,
    task_id: str | None = None,
) -> tuple[object, Path]:
    """
    Build and save the OSM graph for a single location.

    Args:
        location: Location dictionary containing _id, display_name, boundingbox/geojson.
        task_id: Optional task ID for logging context.

    Returns:
        Tuple of (graph, graphml_path) for the built network.
    """
    location_id = str(location.get("_id") or location.get("id") or "unknown")
    location_name = location.get("display_name", "Unknown Location")
    area_version = location.get("area_version")

    if task_id:
        logger.info(
            "Task %s: Preprocessing graph for %s (ID: %s)",
            task_id,
            location_name,
            location_id,
        )
    else:
        logger.info("Preprocessing graph for %s (ID: %s)", location_name, location_id)

    try:
        # 1. Get Polygon
        boundary_geom = (
            location.get("boundary")
            or location.get("geojson")
            or location.get("geometry")
        )
        if isinstance(boundary_geom, dict) and boundary_geom.get("type") == "Feature":
            boundary_geom = boundary_geom.get("geometry")
        if boundary_geom:
            polygon = shape(boundary_geom)
        else:
            bbox = location.get("bounding_box")
            if bbox and len(bbox) >= 4:
                polygon = box(
                    float(bbox[0]),
                    float(bbox[1]),
                    float(bbox[2]),
                    float(bbox[3]),
                )
            else:
                logger.warning("No valid boundary for %s. Skipping.", location_name)
                return None

        # 2. Buffer Polygon
        routing_polygon = buffer_polygon_for_routing(polygon, ROUTING_BUFFER_FT)

        # 3. Load Graph from local extract
        logger.info("Loading OSM graph from local extract for %s...", location_name)

        # Run synchronous ox operations in a thread pool to avoid blocking the event loop
        # distinct from the main thread if running in an async context
        loop = asyncio.get_running_loop()

        def _download_and_save():
            GRAPH_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
            osm_path_str = resolve_osm_data_path()
            if not osm_path_str:
                osm_path_str = require_osm_data_path()
            osm_path = Path(osm_path_str)
            logger.info("Using OSM extract: %s", osm_path)
            _validate_osm_path(osm_path)
            threshold_mb = _get_area_extract_threshold_mb()
            try:
                size_mb = osm_path.stat().st_size / (1024 * 1024)
            except OSError:
                size_mb = 0
            require_extract = (
                _is_area_extract_required()
                and threshold_mb > 0
                and size_mb >= threshold_mb
            )
            area_extract = _maybe_extract_area_pbf(
                osm_path,
                routing_polygon,
                _build_extract_cache_key(location_id, area_version),
                require_extract=require_extract,
                threshold_mb=threshold_mb,
            )
            if area_extract:
                osm_path = area_extract
                logger.info("Using area extract for graph build: %s", osm_path)

            # 4. Save to Disk
            file_path = GRAPH_STORAGE_DIR / f"{location_id}.graphml"
            graph = _build_graph_with_limit(
                osm_path,
                routing_polygon,
                file_path,
                _get_graph_memory_limit_mb(),
                location_id=location_id,
            )
            return graph, file_path

        graph, file_path = await loop.run_in_executor(None, _download_and_save)

    except Exception:
        logger.exception("Failed to process %s", location_name)
        # Re-raise to allow caller to handle error if needed
        raise
    else:
        logger.info("Graph built and saved for %s.", location_name)
        return graph, file_path


async def preprocess_all_graphs() -> None:
    """Main function to process all coverage areas."""
    from db.models import CoverageArea

    load_dotenv()

    # Ensure storage directory exists
    GRAPH_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Storage directory ensured at: %s", GRAPH_STORAGE_DIR.absolute())

    # Fetch all coverage areas
    logger.info("Fetching coverage areas from MongoDB...")
    areas = await CoverageArea.find_all().to_list()
    logger.info("Found %d coverage areas.", len(areas))

    for area in areas:
        loc_data = {
            "_id": str(area.id),
            "id": str(area.id),
            "display_name": area.display_name,
            "boundary": area.boundary,
            "bounding_box": area.bounding_box,
            "area_version": area.area_version,
        }

        await preprocess_streets(loc_data)

    logger.info("Preprocessing complete.")


if __name__ == "__main__":
    # We need to initialize db_manager or handle the async nature manually.
    # Since db.py exports collections that are already using the global db_manager,
    # and db_manager initializes lazily, we just need to run the async loop.
    # Add current directory to path to ensure imports work
    sys.path.insert(0, str(Path.cwd()))

    asyncio.run(preprocess_all_graphs())
