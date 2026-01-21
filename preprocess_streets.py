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
import logging
import sys
from pathlib import Path
from typing import Any

import networkx as nx
from dotenv import load_dotenv
from shapely.geometry import box, shape

from config import require_osm_data_path
from routes.constants import GRAPH_STORAGE_DIR, ROUTING_BUFFER_FT
from routes.geometry import _buffer_polygon_for_routing
from street_coverage.osm_filters import get_driveable_highway

logger = logging.getLogger(__name__)

OSM_EXTENSIONS = {".osm", ".xml", ".pbf"}


def _get_osmnx():
    import osmnx as ox

    return ox


def _graph_from_pbf(osm_path: Path) -> nx.MultiDiGraph:
    ox = _get_osmnx()
    try:
        from pyrosm import OSM
    except ImportError as exc:
        msg = "pyrosm is required to load .pbf extracts. Install it to use OSM_DATA_PATH with .pbf."
        raise RuntimeError(msg) from exc

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

    try:
        nodes_gdf, edges_gdf = osm.get_network(network_type="driving", nodes=True)
        nodes_edges = _coerce_nodes_edges((nodes_gdf, edges_gdf))
        if nodes_edges is None:
            msg = "Pyrosm returned unexpected network data for .pbf extraction."
            raise RuntimeError(msg)
        nodes_gdf, edges_gdf = nodes_edges
        graph = _try_pyrosm_to_graph(osm, nodes_gdf, edges_gdf)
        if graph is not None:
            return graph
        nodes_gdf, edges_gdf = _normalize_pyrosm_gdfs(nodes_gdf, edges_gdf)
        return ox.graph_from_gdfs(nodes_gdf, edges_gdf)
    except Exception as exc:
        msg = "Unable to build a driving network graph from the .pbf extract."
        raise RuntimeError(msg) from exc


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

    if "x" not in nodes.columns or "y" not in nodes.columns:
        if "lon" in nodes.columns and "lat" in nodes.columns:
            nodes["x"] = nodes["lon"]
            nodes["y"] = nodes["lat"]

    if nodes.index.name not in {"osmid", "id"} or not nodes.index.is_unique:
        if "id" in nodes.columns:
            nodes = nodes.set_index("id")
        elif "osmid" in nodes.columns:
            nodes = nodes.set_index("osmid")

    if not isinstance(edges.index, pd.MultiIndex) or edges.index.names[:2] != [
        "u",
        "v",
    ]:
        if "key" not in edges.columns:
            edges["key"] = 0
        edges = edges.set_index(["u", "v", "key"])

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
        routing_polygon = _buffer_polygon_for_routing(polygon, ROUTING_BUFFER_FT)

        # 3. Load Graph from local extract
        logger.info("Loading OSM graph from local extract for %s...", location_name)

        # Run synchronous ox operations in a thread pool to avoid blocking the event loop
        # distinct from the main thread if running in an async context
        loop = asyncio.get_running_loop()

        def _download_and_save():
            ox = _get_osmnx()
            GRAPH_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
            osm_path = Path(require_osm_data_path())
            if not osm_path.exists():
                msg = f"OSM data file not found: {osm_path}"
                raise FileNotFoundError(msg)
            if osm_path.suffix.lower() not in OSM_EXTENSIONS:
                msg = (
                    "OSM_DATA_PATH must point to an OSM extract (.osm, .xml, or .pbf) "
                    "exported from your Valhalla/Nominatim data."
                )
                raise ValueError(msg)
            G = _load_graph_from_extract(osm_path, routing_polygon)
            non_driveable = [
                (u, v, k)
                for u, v, k, data in G.edges(keys=True, data=True)
                if get_driveable_highway(data.get("highway")) is None
            ]
            if non_driveable:
                G.remove_edges_from(non_driveable)
                G.remove_nodes_from(list(nx.isolates(G)))
            # 4. Save to Disk
            file_path = GRAPH_STORAGE_DIR / f"{location_id}.graphml"
            ox.save_graphml(G, filepath=file_path)
            return G, file_path

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
    from street_coverage.models import CoverageArea

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
