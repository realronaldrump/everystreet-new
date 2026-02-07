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
import json
import logging
import os
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any

import networkx as nx
from dotenv import load_dotenv
from shapely.geometry import box, mapping, shape

from config import get_osm_extracts_path, require_osm_data_path, resolve_osm_data_path
from core.spatial import buffer_polygon_for_routing
from routing.constants import GRAPH_STORAGE_DIR, ROUTING_BUFFER_FT
from street_coverage.osm_filters import get_driveable_highway

logger = logging.getLogger(__name__)

OSM_EXTENSIONS = {".osm", ".xml", ".pbf"}
DEFAULT_AREA_EXTRACT_THRESHOLD_MB = 256
# Lowered from 4096 to reduce memory pressure on constrained systems
DEFAULT_GRAPH_MEMORY_LIMIT_MB = 2048
_TRUE_LITERALS = {"true", "t", "1", "yes", "y", "on"}
_FALSE_LITERALS = {"false", "f", "0", "no", "n", "off"}


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
    """Detect available system memory in MB. Returns None if unable to detect."""
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


def _write_geojson(path: Path, geometry: Any) -> None:
    feature = {"type": "Feature", "properties": {}, "geometry": mapping(geometry)}
    data = {"type": "FeatureCollection", "features": [feature]}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _maybe_extract_area_pbf(
    source_path: Path,
    routing_polygon: Any,
    location_id: str,
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
    area_pbf = area_dir / f"{location_id}.osm.pbf"
    area_geojson = area_dir / f"{location_id}.geojson"
    if area_pbf.exists() and area_pbf.stat().st_size > 0:
        logger.info("Using cached area extract: %s", area_pbf)
        return area_pbf

    _write_geojson(area_geojson, routing_polygon)
    # Use .tmp.osm.pbf (not .osm.pbf.tmp) - osmium detects format from extension
    tmp_pbf = area_dir / f"{location_id}.tmp.osm.pbf"
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


def _get_osmnx():
    import osmnx as ox

    return ox


def _coerce_osmnx_bool(value: Any) -> bool | None:
    # OSMnx's GraphML loader only accepts "True"/"False" (or bool) for bool attrs.
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
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


def _build_graph_in_process(
    osm_path: Path,
    routing_polygon: Any,
    graph_path: Path,
) -> nx.MultiDiGraph:
    ox = _get_osmnx()
    G = _load_graph_from_extract(osm_path, routing_polygon)
    if not isinstance(G, nx.MultiDiGraph):
        G = nx.MultiDiGraph(G)
    non_driveable = [
        (u, v, k)
        for u, v, k, data in G.edges(keys=True, data=True)
        if get_driveable_highway(data.get("highway")) is None
    ]
    if non_driveable:
        G.remove_edges_from(non_driveable)
        G.remove_nodes_from(list(nx.isolates(G)))

    _sanitize_graph_for_graphml(G)
    ox.save_graphml(G, filepath=graph_path)
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
            Path(osm_path_str), routing_polygon, Path(graph_path_str)
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


def _build_graph_with_limit(
    osm_path: Path,
    routing_polygon: Any,
    graph_path: Path,
    max_mb: int,
) -> nx.MultiDiGraph | None:
    if max_mb <= 0:
        return _build_graph_in_process(osm_path, routing_polygon, graph_path)

    _build_graph_in_subprocess(osm_path, routing_polygon, graph_path, max_mb)
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
        edges.index.names
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
        raise FileNotFoundError(f"OSM data file not found: {osm_path}")
    if osm_path.suffix.lower() not in OSM_EXTENSIONS:
        raise ValueError(
            "OSM_DATA_PATH must point to an OSM extract (.osm, .xml, or .pbf) "
            "exported from your Valhalla/Nominatim data."
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
                location_id,
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
