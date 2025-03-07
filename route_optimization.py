"""
Route optimization module.
Implements Chinese Postman algorithm to find the most efficient route
that covers all streets in a designated area.
"""

import logging
import networkx as nx
import osmnx as ox
from typing import List, Dict, Any, Tuple, Optional, Set
import json
from shapely.geometry import LineString, Point, mapping, shape
from shapely.ops import transform
import pyproj
import rtree
from collections import defaultdict

from db import streets_collection, coverage_metadata_collection, trips_collection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


class RouteOptimizer:
    def __init__(self, location: Dict[str, Any]):
        """
        Initialize the route optimizer with a location.

        Args:
            location: Dictionary containing location information including display_name and boundingbox
        """
        self.location = location
        self.graph = None
        self.streets_index = rtree.index.Index()
        self.streets_lookup = {}
        self.utm_proj = None
        self.project_to_utm = None
        self.project_to_wgs84 = None
        self.covered_segments = set()
        self.initialize_projections()

    def initialize_projections(self):
        """Initialize projection transformers for accurate distance calculations"""
        center_lat, center_lon = self._get_location_center()
        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"

        WGS84 = pyproj.CRS("EPSG:4326")
        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84"
        )

        self.project_to_utm = pyproj.Transformer.from_crs(
            WGS84, self.utm_proj, always_xy=True
        ).transform

        self.project_to_wgs84 = pyproj.Transformer.from_crs(
            self.utm_proj, WGS84, always_xy=True
        ).transform

    def _get_location_center(self) -> Tuple[float, float]:
        """Get the center coordinates of the location"""
        if "boundingbox" in self.location:
            bbox = self.location["boundingbox"]
            return (float(bbox[0]) + float(bbox[1])) / 2, (
                float(bbox[2]) + float(bbox[3])
            ) / 2
        return 0.0, 0.0

    async def load_covered_segments(self) -> None:
        """
        Load the segments that have already been covered from the database
        """
        display_name = self.location.get("display_name", "")
        coverage_data = await coverage_metadata_collection.find_one(
            {"location.display_name": display_name}
        )

        if coverage_data and "streets_data" in coverage_data:
            streets_data = coverage_data["streets_data"]
            if streets_data and "features" in streets_data:
                for feature in streets_data["features"]:
                    if feature.get("properties", {}).get("driven", False):
                        seg_id = feature.get("properties", {}).get("segment_id")
                        if seg_id:
                            self.covered_segments.add(seg_id)

        logger.info(
            f"Loaded {len(self.covered_segments)} covered segments for {display_name}"
        )

    async def build_network_from_streets(self, undriven_only: bool = False) -> bool:
        """
        Build a network graph from the street segments in the database.

        Args:
            undriven_only: If True, only include undriven streets in the graph

        Returns:
            bool: True if successful, False otherwise
        """
        try:
            logger.info("Building network graph from streets data...")

            # Load covered segments if focusing on undriven streets
            if undriven_only:
                await self.load_covered_segments()

            # Fetch streets for the location
            display_name = self.location.get("display_name", "")
            streets = await streets_collection.find(
                {"properties.location": display_name}
            ).to_list(length=None)

            if not streets:
                logger.warning(f"No streets found for location: {display_name}")
                return False

            # Create a directed graph (will be converted to undirected for CPP)
            G = nx.DiGraph()

            # Create spatial index for node snapping
            node_index = rtree.index.Index()
            node_positions = {}  # Maps node ID to coordinates
            node_counter = 0

            # First pass: collect all nodes (street endpoints) and build spatial index
            logger.info("First pass: collecting street endpoints...")

            for street in streets:
                try:
                    geom = shape(street["geometry"])

                    # Skip non-LineString geometries
                    if geom.geom_type != "LineString":
                        continue

                    # Skip already driven streets if undriven_only is True
                    if (
                        undriven_only
                        and street["properties"].get("segment_id")
                        in self.covered_segments
                    ):
                        continue

                    # Get all points in the geometry
                    coords = list(geom.coords)

                    # Add first and last point to the node index
                    for point in [coords[0], coords[-1]]:
                        # Check if there's an existing node nearby (snapping)
                        nearest_node = self._find_nearby_node(
                            point, node_index, node_positions, max_distance=0.0001
                        )

                        if nearest_node is None:
                            # Create a new node
                            node_id = f"n{node_counter}"
                            node_counter += 1
                            node_positions[node_id] = point
                            node_index.insert(
                                node_id, (point[0], point[1], point[0], point[1])
                            )

                except Exception as e:
                    logger.error(f"Error processing street endpoints: {e}")

            logger.info(
                f"Collected {len(node_positions)} unique nodes from {len(streets)} street segments"
            )

            # Second pass: create edges between nodes
            skipped_segments = 0
            processed_segments = 0

            logger.info("Second pass: creating street edges...")

            for street in streets:
                try:
                    geom = shape(street["geometry"])
                    street_id = street["properties"].get("segment_id")
                    street_name = street["properties"].get("name", "Unnamed Street")

                    # Skip non-LineString geometries
                    if geom.geom_type != "LineString":
                        continue

                    # Skip already driven streets if undriven_only is True
                    if undriven_only and street_id in self.covered_segments:
                        skipped_segments += 1
                        continue

                    processed_segments += 1

                    # Transform to UTM for accurate length calculation
                    geom_utm = transform(self.project_to_utm, geom)
                    length = geom_utm.length

                    # Extract street attributes
                    highway_type = street["properties"].get("highway", "road")
                    is_oneway = street["properties"].get("oneway", False)

                    # Get the start and end points of the street
                    coords = list(geom.coords)
                    start_point = coords[0]
                    end_point = coords[-1]

                    # Find the nearest nodes (with snapping)
                    start_node = self._find_nearby_node(
                        start_point, node_index, node_positions
                    )
                    end_node = self._find_nearby_node(
                        end_point, node_index, node_positions
                    )

                    if start_node is None or end_node is None:
                        logger.warning(f"Could not find nodes for street {street_id}")
                        continue

                    # Add nodes to the graph with their coordinates
                    if start_node not in G:
                        G.add_node(
                            start_node,
                            x=node_positions[start_node][0],
                            y=node_positions[start_node][1],
                        )

                    if end_node not in G:
                        G.add_node(
                            end_node,
                            x=node_positions[end_node][0],
                            y=node_positions[end_node][1],
                        )

                    # Add edge with attributes
                    G.add_edge(
                        start_node,
                        end_node,
                        id=street_id,
                        name=street_name,
                        length=length,
                        geometry=mapping(geom),
                        is_covered=street_id in self.covered_segments,
                        highway=highway_type,
                        oneway=is_oneway,
                    )

                    # For non-oneway streets, add the reverse edge as well
                    if not is_oneway:
                        G.add_edge(
                            end_node,
                            start_node,
                            id=f"{street_id}-rev",
                            name=street_name,
                            length=length,
                            geometry=mapping(geom),
                            is_covered=street_id in self.covered_segments,
                            highway=highway_type,
                            oneway=is_oneway,
                        )

                    # Index the street for spatial queries
                    current_idx = len(self.streets_lookup)
                    self.streets_index.insert(current_idx, geom.bounds)
                    self.streets_lookup[current_idx] = {
                        "id": street_id,
                        "name": street_name,
                        "length": length,
                        "geometry": street["geometry"],
                        "is_covered": street_id in self.covered_segments,
                        "highway": highway_type,
                    }

                except Exception as e:
                    logger.error(f"Error processing street segment: {e}")

            if undriven_only:
                logger.info(
                    f"Built graph with {processed_segments} undriven streets (skipped {skipped_segments} driven streets)"
                )

                if processed_segments == 0:
                    logger.warning("No undriven streets found in the selected area")
                    return False
            else:
                logger.info(f"Built graph with {len(self.streets_lookup)} streets")

            logger.info(
                f"Graph has {G.number_of_nodes()} nodes and {G.number_of_edges()} edges"
            )

            # Ensure the graph is connected
            largest_cc = max(nx.weakly_connected_components(G), key=len)
            G = G.subgraph(largest_cc).copy()
            logger.info(
                f"Largest connected component has {G.number_of_nodes()} nodes and {G.number_of_edges()} edges"
            )

            self.graph = G
            return True

        except Exception as e:
            logger.error(f"Error building network from streets: {e}")
            return False

    def _find_nearby_node(self, point, node_index, node_positions, max_distance=0.0001):
        """
        Find an existing node near the given point for snapping.

        Args:
            point: The point coordinates (lon, lat)
            node_index: Spatial index of nodes
            node_positions: Dictionary mapping node IDs to coordinates
            max_distance: Maximum distance for snapping in degrees

        Returns:
            Node ID if a nearby node is found, None otherwise
        """
        # Define a small search box around the point
        search_box = (
            point[0] - max_distance,
            point[1] - max_distance,
            point[0] + max_distance,
            point[1] + max_distance,
        )

        # Find nodes in the search box
        nearby_nodes = list(node_index.intersection(search_box))

        if not nearby_nodes:
            return None

        # Find the closest node
        closest_node = None
        min_distance = float("inf")

        for node_id in nearby_nodes:
            node_point = node_positions[node_id]
            dist = (
                (point[0] - node_point[0]) ** 2 + (point[1] - node_point[1]) ** 2
            ) ** 0.5

            if dist < min_distance:
                min_distance = dist
                closest_node = node_id

        return closest_node

    def ensure_graph_connectivity(self) -> bool:
        """
        Ensure the graph is connected by adding necessary edges between disconnected components.
        Returns True if successful, False otherwise.
        """
        if not self.graph:
            return False

        try:
            # Convert to undirected for connectivity analysis
            undirected = self.graph.to_undirected()

            # Find connected components
            components = list(nx.connected_components(undirected))

            if len(components) <= 1:
                logger.info("Graph is already connected")
                return True

            logger.info(
                f"Graph has {len(components)} disconnected components. Connecting them..."
            )

            # Sort components by size (largest first)
            components.sort(key=len, reverse=True)

            # Start with the largest component
            main_component = components[0]

            # Connect each other component to the main one
            for i, component in enumerate(components[1:], 1):
                # Find the closest nodes between the main component and this component
                min_distance = float("inf")
                closest_pair = None

                for main_node in main_component:
                    main_x = self.graph.nodes[main_node]["x"]
                    main_y = self.graph.nodes[main_node]["y"]

                    for other_node in component:
                        other_x = self.graph.nodes[other_node]["x"]
                        other_y = self.graph.nodes[other_node]["y"]

                        # Calculate Euclidean distance
                        dist = (
                            (main_x - other_x) ** 2 + (main_y - other_y) ** 2
                        ) ** 0.5

                        if dist < min_distance:
                            min_distance = dist
                            closest_pair = (main_node, other_node)

                if closest_pair:
                    main_node, other_node = closest_pair

                    # Add connecting edges in both directions
                    self.graph.add_edge(
                        main_node,
                        other_node,
                        id=f"connector_{i}_a",
                        name="Connector",
                        length=min_distance,
                        is_connector=True,
                        is_covered=False,
                        highway="connector",
                    )

                    self.graph.add_edge(
                        other_node,
                        main_node,
                        id=f"connector_{i}_b",
                        name="Connector",
                        length=min_distance,
                        is_connector=True,
                        is_covered=False,
                        highway="connector",
                    )

                    # Update main component with nodes from this component
                    main_component.update(component)

            # Verify connectivity
            undirected = self.graph.to_undirected()
            if nx.is_connected(undirected):
                logger.info("Successfully connected all components")
                return True
            else:
                logger.warning("Failed to connect all components")
                return False

        except Exception as e:
            logger.error(f"Error ensuring graph connectivity: {e}")
            return False

    def compute_optimal_route(
        self,
        start_point: Optional[Tuple[float, float]] = None,
        undriven_only: bool = False,
    ) -> Dict[str, Any]:
        """
        Compute the optimal route using Chinese Postman algorithm.

        Args:
            start_point: Optional starting point coordinates (lon, lat)
            undriven_only: If True, prioritize undriven streets

        Returns:
            Dictionary containing the optimized route and metadata
        """
        if not self.graph:
            logger.error(
                "Graph not initialized. Call build_network_from_streets first."
            )
            return {"error": "Graph not initialized"}

        try:
            # Ensure graph is connected
            if not self.ensure_graph_connectivity():
                return {
                    "error": "Unable to create a connected route - the street network has disconnected segments"
                }

            # Convert to undirected graph for Chinese Postman
            undirected_graph = self.graph.to_undirected()

            # Find node closest to start_point if provided
            start_node = None
            if start_point:
                # Find closest node to the starting point
                closest_dist = float("inf")
                for node, data in undirected_graph.nodes(data=True):
                    dist = (
                        (data["x"] - start_point[0]) ** 2
                        + (data["y"] - start_point[1]) ** 2
                    ) ** 0.5
                    if dist < closest_dist:
                        closest_dist = dist
                        start_node = node

                logger.info(
                    f"Selected start node {start_node} at distance {closest_dist:.2f} from requested start point"
                )

            # Find Eulerian circuit (Chinese Postman route)
            logger.info("Computing Eulerian circuit (Chinese Postman route)...")

            # If graph is not Eulerian, add necessary edges
            if not nx.is_eulerian(undirected_graph):
                # Find odd-degree nodes
                odd_nodes = [
                    node
                    for node, degree in undirected_graph.degree()
                    if degree % 2 == 1
                ]

                # Find shortest paths between odd-degree nodes
                augmented_edges = []

                if len(odd_nodes) > 0:
                    logger.info(
                        f"Found {len(odd_nodes)} odd-degree nodes, computing shortest paths..."
                    )

                    # Create pairs of odd nodes (this is a matching problem)
                    # For simplicity, we'll use a greedy approach to match them
                    odd_node_pairs = []
                    remaining_nodes = odd_nodes.copy()

                    while len(remaining_nodes) >= 2:
                        node1 = remaining_nodes.pop(0)

                        # Find closest odd node to node1
                        min_dist = float("inf")
                        closest_node = None

                        for node2 in remaining_nodes:
                            try:
                                path_length = nx.shortest_path_length(
                                    undirected_graph, node1, node2, weight="length"
                                )
                                if path_length < min_dist:
                                    min_dist = path_length
                                    closest_node = node2
                            except nx.NetworkXNoPath:
                                continue

                        if closest_node:
                            odd_node_pairs.append((node1, closest_node))
                            remaining_nodes.remove(closest_node)
                        else:
                            logger.warning(
                                f"Could not find a path to match odd node {node1}"
                            )

                    # Add shortest paths between odd node pairs to make graph Eulerian
                    for u, v in odd_node_pairs:
                        try:
                            # Find shortest path
                            path = nx.shortest_path(
                                undirected_graph, u, v, weight="length"
                            )
                            for i in range(len(path) - 1):
                                augmented_edges.append(
                                    (
                                        path[i],
                                        path[i + 1],
                                        undirected_graph[path[i]][path[i + 1]][
                                            "length"
                                        ],
                                    )
                                )
                        except nx.NetworkXNoPath:
                            logger.warning(f"No path found between nodes {u} and {v}")

                # Add augmented edges to make the graph Eulerian
                for u, v, length in augmented_edges:
                    if not undirected_graph.has_edge(u, v):
                        undirected_graph.add_edge(
                            u, v, length=length, is_augmented=True
                        )

            # Find Eulerian circuit
            try:
                if start_node:
                    circuit = list(
                        nx.eulerian_circuit(undirected_graph, source=start_node)
                    )
                else:
                    circuit = list(nx.eulerian_circuit(undirected_graph))
            except nx.NetworkXError as e:
                logger.error(f"Failed to find Eulerian circuit: {e}")
                return {"error": f"Failed to compute optimal route: {str(e)}"}

            # Convert circuit to a route
            route = []
            total_length = 0
            edge_count = 0
            undriven_edge_count = 0
            driven_edge_count = 0
            connector_count = 0

            for u, v in circuit:
                # Get edge data
                edge_data = undirected_graph[u][v]

                # Skip augmented edges in final route if needed
                if edge_data.get("is_augmented", False):
                    continue

                # Get node coordinates
                u_data = undirected_graph.nodes[u]
                v_data = undirected_graph.nodes[v]

                # Extract edge information
                if self.graph.has_edge(u, v):
                    original_edge = self.graph[u][v]
                elif self.graph.has_edge(v, u):
                    original_edge = self.graph[v][u]
                else:
                    continue

                street_id = original_edge.get("id", "")
                street_name = original_edge.get("name", "Unnamed Street")
                edge_length = original_edge.get("length", 0)
                geometry = original_edge.get("geometry", None)
                is_covered = original_edge.get("is_covered", False)
                is_connector = original_edge.get("is_connector", False)
                highway_type = original_edge.get("highway", "unknown")

                # Track counts
                if is_connector:
                    connector_count += 1
                elif is_covered:
                    driven_edge_count += 1
                else:
                    undriven_edge_count += 1

                # Create a LineString from start to end if geometry is missing
                if not geometry:
                    line = LineString(
                        [(u_data["x"], u_data["y"]), (v_data["x"], v_data["y"])]
                    )
                    geometry = mapping(line)

                # Add to route
                route.append(
                    {
                        "street_id": street_id,
                        "street_name": street_name,
                        "start": [u_data["x"], u_data["y"]],
                        "end": [v_data["x"], v_data["y"]],
                        "length": edge_length,
                        "geometry": geometry,
                        "is_covered": is_covered,
                        "is_connector": is_connector,
                        "highway": highway_type,
                    }
                )

                total_length += edge_length
                edge_count += 1

            logger.info(
                f"Computed optimal route with {edge_count} segments and total length {total_length:.2f} meters"
            )
            logger.info(
                f"Route includes {undriven_edge_count} undriven streets, {driven_edge_count} driven streets, and {connector_count} connectors"
            )

            # Calculate total undriven length
            undriven_length = sum(
                segment["length"]
                for segment in route
                if not segment["is_covered"] and not segment["is_connector"]
            )
            driven_length = sum(
                segment["length"]
                for segment in route
                if segment["is_covered"] and not segment["is_connector"]
            )
            connector_length = sum(
                segment["length"] for segment in route if segment["is_connector"]
            )

            return {
                "route": route,
                "total_length": total_length,
                "segment_count": edge_count,
                "total_length_miles": total_length * 0.000621371,
                "undriven_segments": undriven_edge_count,
                "driven_segments": driven_edge_count,
                "connector_segments": connector_count,
                "undriven_length": undriven_length,
                "undriven_length_miles": undriven_length * 0.000621371,
                "driven_length": driven_length,
                "driven_length_miles": driven_length * 0.000621371,
                "connector_length": connector_length,
                "connector_length_miles": connector_length * 0.000621371,
            }

        except Exception as e:
            logger.error(f"Error computing optimal route: {e}")
            return {"error": str(e)}

    def generate_route_geojson(self, route_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert route data to GeoJSON format for visualization

        Args:
            route_data: Route data from compute_optimal_route

        Returns:
            GeoJSON representation of the route
        """
        if "error" in route_data:
            return {"error": route_data["error"]}

        route = route_data.get("route", [])
        if not route:
            return {"error": "Empty route"}

        features = []
        for i, segment in enumerate(route):
            geometry = segment.get("geometry")
            if not geometry:
                continue

            feature = {
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "id": segment["street_id"],
                    "name": segment["street_name"],
                    "length": segment["length"],
                    "sequence": i + 1,
                    "is_covered": segment.get("is_covered", False),
                    "is_connector": segment.get("is_connector", False),
                    "highway": segment.get("highway", "unknown"),
                },
            }
            features.append(feature)

        return {
            "type": "FeatureCollection",
            "features": features,
            "metadata": {
                "total_length": route_data["total_length"],
                "total_length_miles": route_data["total_length_miles"],
                "segment_count": route_data["segment_count"],
                "undriven_segments": route_data["undriven_segments"],
                "driven_segments": route_data["driven_segments"],
                "connector_segments": route_data["connector_segments"],
                "undriven_length": route_data["undriven_length"],
                "undriven_length_miles": route_data["undriven_length_miles"],
                "driven_length": route_data["driven_length"],
                "driven_length_miles": route_data["driven_length_miles"],
                "connector_length": route_data["connector_length"],
                "connector_length_miles": route_data["connector_length_miles"],
            },
        }

    async def generate_navigation_instructions(
        self, route_data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Generate turn-by-turn navigation instructions for the route

        Args:
            route_data: Route data from compute_optimal_route

        Returns:
            List of navigation instructions
        """
        route = route_data.get("route", [])
        if not route:
            return []

        instructions = []
        prev_street_name = None
        distance_on_street = 0
        segment_count = 0

        for i, segment in enumerate(route):
            current_street_name = segment["street_name"]

            # If this is a new street or the last segment
            if current_street_name != prev_street_name or i == len(route) - 1:
                if prev_street_name and segment_count > 0:
                    # Add completed street to instructions
                    instructions.append(
                        {
                            "instruction": f"Drive on {prev_street_name}",
                            "distance": distance_on_street,
                            "distance_miles": distance_on_street * 0.000621371,
                            "segments": segment_count,
                            "street_name": prev_street_name,
                            "is_covered": route[i - 1].get("is_covered", False),
                            "is_connector": route[i - 1].get("is_connector", False),
                        }
                    )

                # Reset for new street
                distance_on_street = segment["length"]
                segment_count = 1
                prev_street_name = current_street_name
            else:
                # Continue on same street
                distance_on_street += segment["length"]
                segment_count += 1

        # Add any final segment not added in the loop
        if prev_street_name and segment_count > 0 and len(instructions) == 0:
            instructions.append(
                {
                    "instruction": f"Drive on {prev_street_name}",
                    "distance": distance_on_street,
                    "distance_miles": distance_on_street * 0.000621371,
                    "segments": segment_count,
                    "street_name": prev_street_name,
                    "is_covered": route[-1].get("is_covered", False),
                    "is_connector": route[-1].get("is_connector", False),
                }
            )

        return instructions

    async def get_directions_to_start(
        self, start_point: Tuple[float, float], current_location: Tuple[float, float]
    ) -> Dict[str, Any]:
        """
        Get directions from current location to the start point of the route

        Args:
            start_point: Starting point of the route (lon, lat)
            current_location: Current location of the user (lon, lat)

        Returns:
            Dictionary with direction information
        """
        try:
            # Use OSMnx to get the directions
            G = ox.graph_from_point(
                (current_location[1], current_location[0]),  # osmnx uses lat, lon
                dist=5000,  # 5km radius
                network_type="drive",
            )

            # Find nearest nodes to start and end points
            start_node = ox.distance.nearest_nodes(
                G, current_location[0], current_location[1]
            )
            end_node = ox.distance.nearest_nodes(G, start_point[0], start_point[1])

            # Calculate shortest path
            route = nx.shortest_path(G, start_node, end_node, weight="length")

            # Extract coordinates
            path_coords = []
            for node in route:
                x = G.nodes[node]["x"]
                y = G.nodes[node]["y"]
                path_coords.append([x, y])

            # Calculate distance
            distance = 0
            for i in range(len(route) - 1):
                u, v = route[i], route[i + 1]
                distance += G.edges[u, v, 0].get("length", 0)

            return {
                "distance": distance,
                "distance_miles": distance * 0.000621371,
                "coordinates": path_coords,
                "success": True,
            }

        except Exception as e:
            logger.error(f"Error generating directions to start: {e}")
            return {"success": False, "error": str(e)}


async def optimize_route_for_location(
    location: Dict[str, Any],
    start_point: Optional[Tuple[float, float]] = None,
    undriven_only: bool = False,
    current_location: Optional[Tuple[float, float]] = None,
) -> Dict[str, Any]:
    """
    Generate an optimized route for a location.

    Args:
        location: Location dictionary
        start_point: Optional starting point coordinates (lon, lat)
        undriven_only: If True, only include undriven streets
        current_location: Current location for navigation to start point

    Returns:
        Optimized route data
    """
    try:
        optimizer = RouteOptimizer(location)
        success = await optimizer.build_network_from_streets(
            undriven_only=undriven_only
        )

        if not success:
            if undriven_only:
                return {"error": "No undriven streets found in the selected area"}
            else:
                return {"error": "Failed to build network from streets"}

        route_data = optimizer.compute_optimal_route(
            start_point, undriven_only=undriven_only
        )

        if "error" in route_data:
            return route_data

        geojson = optimizer.generate_route_geojson(route_data)
        instructions = await optimizer.generate_navigation_instructions(route_data)

        result = {
            "route_data": route_data,
            "geojson": geojson,
            "instructions": instructions,
        }

        # Add directions to start point if both current location and start point are provided
        if current_location and start_point:
            directions = await optimizer.get_directions_to_start(
                start_point, current_location
            )
            result["directions_to_start"] = directions

        return result
    except Exception as e:
        logger.error(f"Error optimizing route: {e}")
        return {"error": str(e)}


# Export the RouteOptimizer class
__all__ = ["RouteOptimizer", "optimize_route_for_location"]
