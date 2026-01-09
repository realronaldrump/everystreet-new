"""RoutingService for on-demand route generation.

Generates optimal routes for covering undriven streets in an area.
Uses an LRU cache for routing graphs to avoid rebuilding on every request.
"""

import logging
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any

import networkx as nx
from bson import ObjectId
from shapely.geometry import LineString, Point, shape

from db import (
    aggregate_with_retry,
    areas_collection,
    coverage_state_collection,
    find_one_with_retry,
    streets_v2_collection,
)
from coverage_models.coverage_state import CoverageStatus
from coverage_models.job_status import JobType
from services.job_manager import job_manager

logger = logging.getLogger(__name__)

# LRU cache for routing graphs
MAX_CACHED_GRAPHS = 10


class RoutingGraphCache:
    """LRU cache for area routing graphs."""

    def __init__(self, maxsize: int = MAX_CACHED_GRAPHS):
        self._cache: OrderedDict[str, tuple[int, nx.Graph]] = OrderedDict()
        self._maxsize = maxsize

    def get(self, area_id: str, version: int) -> nx.Graph | None:
        """Get cached graph if it exists and version matches."""
        key = area_id
        if key in self._cache:
            cached_version, graph = self._cache[key]
            if cached_version == version:
                # Move to end (most recently used)
                self._cache.move_to_end(key)
                return graph
            else:
                # Version mismatch, invalidate
                del self._cache[key]
        return None

    def put(self, area_id: str, version: int, graph: nx.Graph) -> None:
        """Cache a graph, evicting oldest if at capacity."""
        key = area_id
        if key in self._cache:
            del self._cache[key]
        elif len(self._cache) >= self._maxsize:
            # Remove oldest (first item)
            self._cache.popitem(last=False)
        self._cache[key] = (version, graph)

    def invalidate(self, area_id: str) -> None:
        """Invalidate cached graph for an area."""
        if area_id in self._cache:
            del self._cache[area_id]

    def clear(self) -> None:
        """Clear all cached graphs."""
        self._cache.clear()


# Global cache instance
_graph_cache = RoutingGraphCache()


class RoutingService:
    """Generates optimal routes for covering undriven streets."""

    def __init__(self):
        self.cache = _graph_cache

    async def generate_route(
        self,
        area_id: str,
        start_point: tuple[float, float] | None = None,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        """Generate an optimal route for undriven streets.

        Args:
            area_id: Area ID to generate route for
            start_point: Optional (lon, lat) starting point
            job_id: Optional job ID for progress tracking

        Returns:
            Dict with route GeoJSON and metadata
        """
        area_oid = ObjectId(area_id)

        # Get area
        area_doc = await find_one_with_retry(
            areas_collection,
            {"_id": area_oid},
        )

        if not area_doc:
            raise ValueError(f"Area {area_id} not found")

        if area_doc.get("status") != "ready":
            raise ValueError(f"Area not ready for routing (status: {area_doc.get('status')})")

        area_version = area_doc.get("current_version", 1)
        display_name = area_doc.get("display_name", area_id)

        logger.info("Generating route for area %s (version %d)", display_name, area_version)

        job_oid = ObjectId(job_id) if job_id else None

        if job_oid:
            await job_manager.start_job(
                job_oid,
                stage="building_graph",
                message="Building routing graph...",
            )

        # Get or build routing graph
        graph = self.cache.get(area_id, area_version)
        if graph is None:
            graph = await self._build_routing_graph(area_id, area_version, job_oid)
            self.cache.put(area_id, area_version, graph)

        if job_oid:
            await job_manager.update_job(
                job_oid,
                stage="finding_undriven",
                percent=40,
                message="Finding undriven segments...",
            )

        # Get undriven segment IDs
        undriven_segments = await self._get_undriven_segments(area_id, area_version)

        if not undriven_segments:
            if job_oid:
                await job_manager.complete_job(
                    job_oid,
                    message="No undriven segments found!",
                    metrics={"undriven_count": 0},
                )
            return {
                "route": None,
                "message": "All streets have been driven!",
                "undriven_count": 0,
            }

        if job_oid:
            await job_manager.update_job(
                job_oid,
                stage="computing_route",
                percent=60,
                message=f"Computing route for {len(undriven_segments)} undriven segments...",
            )

        # Compute route
        route_coords = await self._compute_route(
            graph=graph,
            undriven_segments=undriven_segments,
            start_point=start_point,
            area_id=area_id,
            area_version=area_version,
        )

        if not route_coords:
            if job_oid:
                await job_manager.fail_job(job_oid, "Failed to compute route")
            raise ValueError("Failed to compute route")

        # Build GeoJSON response
        route_geojson = {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": route_coords,
            },
            "properties": {
                "area_id": area_id,
                "area_name": display_name,
                "undriven_count": len(undriven_segments),
                "point_count": len(route_coords),
                "generated_at": datetime.now(UTC).isoformat(),
            },
        }

        if job_oid:
            await job_manager.complete_job(
                job_oid,
                message=f"Route generated with {len(route_coords)} points",
                metrics={
                    "undriven_count": len(undriven_segments),
                    "point_count": len(route_coords),
                },
            )

        logger.info(
            "Generated route for %s: %d undriven segments, %d points",
            display_name,
            len(undriven_segments),
            len(route_coords),
        )

        return {
            "route": route_geojson,
            "undriven_count": len(undriven_segments),
            "point_count": len(route_coords),
        }

    async def _build_routing_graph(
        self,
        area_id: str,
        area_version: int,
        job_oid: ObjectId | None = None,
    ) -> nx.Graph:
        """Build a NetworkX graph from street segments.

        Creates a graph where:
        - Nodes are street endpoints
        - Edges are street segments with length weights
        """
        area_oid = ObjectId(area_id)

        # Fetch all driveable streets for this area/version
        pipeline = [
            {
                "$match": {
                    "area_id": area_oid,
                    "area_version": area_version,
                    "undriveable": {"$ne": True},
                }
            },
            {
                "$project": {
                    "segment_id": 1,
                    "geometry": 1,
                    "segment_length_m": 1,
                }
            },
        ]

        streets = await aggregate_with_retry(streets_v2_collection, pipeline)

        if not streets:
            raise ValueError("No driveable streets found for routing")

        if job_oid:
            await job_manager.update_job(
                job_oid,
                percent=20,
                message=f"Building graph from {len(streets)} street segments...",
            )

        # Build graph
        G = nx.Graph()

        for street in streets:
            segment_id = street["segment_id"]
            geometry = street.get("geometry", {})
            length = street.get("segment_length_m", 100)

            coords = geometry.get("coordinates", [])
            if len(coords) < 2:
                continue

            # Use start and end points as nodes
            start = tuple(coords[0])
            end = tuple(coords[-1])

            # Round coordinates to avoid floating point issues
            start = (round(start[0], 6), round(start[1], 6))
            end = (round(end[0], 6), round(end[1], 6))

            # Add edge with segment info
            G.add_edge(
                start,
                end,
                segment_id=segment_id,
                length=length,
                geometry=coords,
            )

        logger.info(
            "Built routing graph: %d nodes, %d edges",
            G.number_of_nodes(),
            G.number_of_edges(),
        )

        return G

    async def _get_undriven_segments(
        self,
        area_id: str,
        area_version: int,
    ) -> set[str]:
        """Get set of undriven segment IDs."""
        area_oid = ObjectId(area_id)

        pipeline = [
            {
                "$match": {
                    "area_id": area_oid,
                    "area_version": area_version,
                    "status": CoverageStatus.UNDRIVEN.value,
                }
            },
            {"$project": {"segment_id": 1, "_id": 0}},
        ]

        results = await aggregate_with_retry(coverage_state_collection, pipeline)
        return {doc["segment_id"] for doc in results}

    async def _compute_route(
        self,
        graph: nx.Graph,
        undriven_segments: set[str],
        start_point: tuple[float, float] | None,
        area_id: str,
        area_version: int,
    ) -> list[list[float]]:
        """Compute an efficient route through undriven segments.

        Uses a greedy nearest-neighbor approach with some optimization.
        """
        # Find edges that are undriven
        undriven_edges = []
        for u, v, data in graph.edges(data=True):
            if data.get("segment_id") in undriven_segments:
                undriven_edges.append((u, v, data))

        if not undriven_edges:
            return []

        # Find starting node
        if start_point:
            start_node = self._find_nearest_node(graph, start_point)
        else:
            # Use first undriven edge's start
            start_node = undriven_edges[0][0]

        # Greedy nearest-neighbor route
        route_coords = []
        visited_edges = set()
        current_node = start_node

        # Add starting point
        route_coords.append(list(current_node))

        while len(visited_edges) < len(undriven_edges):
            # Find nearest unvisited undriven edge
            best_edge = None
            best_distance = float("inf")
            best_path = None

            for u, v, data in undriven_edges:
                edge_key = (min(u, v), max(u, v))
                if edge_key in visited_edges:
                    continue

                # Try path to either endpoint
                for target in [u, v]:
                    try:
                        if current_node == target:
                            path = [current_node]
                            dist = 0
                        else:
                            path = nx.shortest_path(
                                graph,
                                current_node,
                                target,
                                weight="length",
                            )
                            dist = nx.shortest_path_length(
                                graph,
                                current_node,
                                target,
                                weight="length",
                            )

                        if dist < best_distance:
                            best_distance = dist
                            best_edge = (u, v, data)
                            best_path = path
                    except nx.NetworkXNoPath:
                        continue

            if best_edge is None:
                # No more reachable edges
                break

            u, v, data = best_edge
            edge_key = (min(u, v), max(u, v))
            visited_edges.add(edge_key)

            # Add path to edge
            if best_path and len(best_path) > 1:
                for node in best_path[1:]:
                    route_coords.append(list(node))

            # Add the edge geometry
            edge_geometry = data.get("geometry", [])
            target = v if best_path and best_path[-1] == u else u

            # Ensure we traverse the edge in the right direction
            if best_path and best_path[-1] == v:
                # We arrived at v, traverse u->v
                for coord in edge_geometry:
                    route_coords.append(coord)
                current_node = u if edge_geometry[-1] == list(u) else v
            else:
                # We arrived at u, traverse v->u (reversed)
                for coord in reversed(edge_geometry):
                    route_coords.append(coord)
                current_node = v if edge_geometry[0] == list(v) else u

            # Update current node to the other end of the edge
            if current_node == u:
                current_node = v
            else:
                current_node = u

        # Deduplicate consecutive points
        deduped = []
        for coord in route_coords:
            if not deduped or coord != deduped[-1]:
                deduped.append(coord)

        return deduped

    def _find_nearest_node(
        self,
        graph: nx.Graph,
        point: tuple[float, float],
    ) -> tuple[float, float]:
        """Find the nearest graph node to a point."""
        min_dist = float("inf")
        nearest = None

        for node in graph.nodes():
            dist = ((node[0] - point[0]) ** 2 + (node[1] - point[1]) ** 2) ** 0.5
            if dist < min_dist:
                min_dist = dist
                nearest = node

        return nearest or point

    def invalidate_cache(self, area_id: str) -> None:
        """Invalidate cached graph for an area."""
        self.cache.invalidate(area_id)

    def clear_cache(self) -> None:
        """Clear all cached graphs."""
        self.cache.clear()


# Singleton instance
routing_service = RoutingService()


def generate_gpx(route_geojson: dict[str, Any], area_name: str) -> str:
    """Generate GPX XML from route GeoJSON.

    Args:
        route_geojson: GeoJSON Feature with LineString geometry
        area_name: Area name for GPX metadata

    Returns:
        GPX XML string
    """
    coords = route_geojson.get("geometry", {}).get("coordinates", [])

    gpx_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="EveryStreet">',
        "  <metadata>",
        f"    <name>Coverage Route - {area_name}</name>",
        f"    <time>{datetime.now(UTC).isoformat()}</time>",
        "  </metadata>",
        "  <trk>",
        f"    <name>{area_name} Coverage Route</name>",
        "    <trkseg>",
    ]

    for coord in coords:
        lon, lat = coord[0], coord[1]
        gpx_lines.append(f'      <trkpt lat="{lat}" lon="{lon}"></trkpt>')

    gpx_lines.extend(
        [
            "    </trkseg>",
            "  </trk>",
            "</gpx>",
        ]
    )

    return "\n".join(gpx_lines)
