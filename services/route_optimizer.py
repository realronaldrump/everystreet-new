import networkx as nx
from typing import List, Dict, Tuple
import osmnx as ox
from shapely.geometry import Point, LineString
import logging

logger = logging.getLogger(__name__)


class RouteOptimizer:
    def __init__(self):
        """Initialize the route optimizer"""
        self.graph = None
        self.driven_edges = set()
        self.undriven_edges = set()

    def create_graph_from_streets(self, streets_geojson: dict, driven_segments: List[dict]) -> None:
        """Convert street GeoJSON into a NetworkX graph"""
        try:
            # Create an empty directed graph
            self.graph = nx.DiGraph()

            # Create a set of driven street IDs from the matched trips
            driven_street_ids = set()
            for trip in driven_segments:
                # Handle different possible data structures
                if isinstance(trip, dict):
                    if 'properties' in trip and 'street_id' in trip['properties']:
                        driven_street_ids.add(trip['properties']['street_id'])
                    elif 'street_id' in trip:
                        driven_street_ids.add(trip['street_id'])
                    elif '_id' in trip:
                        driven_street_ids.add(trip['_id'])

            logger.debug(
                f"Found {len(driven_street_ids)} driven street segments")

            # Process each street segment
            for feature in streets_geojson['features']:
                street_id = feature['properties'].get('id')
                name = feature['properties'].get('name', 'Unknown Street')
                length = feature['properties'].get('length', 0)
                coords = feature['geometry']['coordinates']

                # Determine if the street has been driven
                is_driven = street_id in driven_street_ids

                # Convert coordinates from [lon, lat] to (lat, lon)
                normalized_coords = [
                    self._normalize_coordinates(coord) for coord in coords]
                start_node = normalized_coords[0]
                end_node = normalized_coords[-1]

                # Add edge to graph
                self.graph.add_edge(
                    start_node,
                    end_node,
                    street_id=street_id,
                    name=name,
                    length=length,
                    is_driven=is_driven,
                    geometry=normalized_coords  # Store full geometry for later use
                )

                # Track driven/undriven edges
                edge = (start_node, end_node)
                if is_driven:
                    self.driven_edges.add(edge)
                else:
                    self.undriven_edges.add(edge)

            # Check connectivity after graph is created
            self._check_graph_connectivity()

            logger.info(
                f"Created graph with {self.graph.number_of_nodes()} nodes and {self.graph.number_of_edges()} edges")
            logger.debug(
                f"Driven edges: {len(self.driven_edges)}, Undriven edges: {len(self.undriven_edges)}")

        except Exception as e:
            logger.error(f"Error creating graph: {str(e)}")
            raise

    def find_optimal_route(self, start_point: Tuple[float, float]) -> Dict:
        """Find optimal route to cover undriven streets"""
        try:
            # Normalize input coordinates and find nearest node
            start_point = self._normalize_coordinates(start_point)
            start_node = self._find_nearest_node(start_point)

            # Get all components
            components = list(nx.weakly_connected_components(self.graph))
            routes = []

            # Process each component separately
            for component in components:
                if not any(not self.graph[u][v].get('driven', False)
                           for u, v in self.graph.subgraph(component).edges()):
                    continue

                subgraph = self.graph.subgraph(component).copy()

                # Find nearest node in this component
                component_start = min(
                    component,
                    key=lambda n: self._calculate_distance(n, start_point)
                )

                component_route = self._solve_modified_cpp(
                    subgraph, component_start)
                if component_route and len(component_route) > 1:
                    routes.append(component_route)

            # Combine routes optimally
            combined_route = self._combine_component_routes(routes, start_node)

            # Convert route to GeoJSON
            route_geojson = self._route_to_geojson(combined_route)

            # Calculate statistics
            stats = self._calculate_route_stats(combined_route)

            return {
                'route': route_geojson,
                'statistics': stats,
                'turn_by_turn': self._generate_turn_by_turn(combined_route)
            }

        except Exception as e:
            logger.error(f"Error finding optimal route: {str(e)}")
            raise

    def _normalize_coordinates(self, point: Tuple[float, float]) -> Tuple[float, float]:
        """Ensure coordinates are in the correct format (latitude, longitude)"""
        if isinstance(point, (list, tuple)) and len(point) == 2:
            # If coordinates are in [longitude, latitude] format, swap them
            return (point[1], point[0])
        return point

    def _denormalize_coordinates(self, point: Tuple[float, float]) -> Tuple[float, float]:
        """Convert coordinates back to [longitude, latitude] format for GeoJSON"""
        return (point[1], point[0])

    def _calculate_distance(self, point1: Tuple[float, float], point2: Tuple[float, float]) -> float:
        """Calculate Euclidean distance between two points"""
        return ((point1[0] - point2[0])**2 + (point1[1] - point2[1])**2)**0.5

    def _find_nearest_node(self, point: Tuple[float, float]) -> Tuple[float, float]:
        """Find the nearest node in the graph to a given point"""
        if not self.graph:
            raise ValueError("Graph not initialized")

        min_dist = float('inf')
        nearest_node = None

        for node in self.graph.nodes():
            dist = self._calculate_distance(node, point)
            if dist < min_dist:
                min_dist = dist
                nearest_node = node

        return nearest_node

    def _solve_modified_cpp(self, graph: nx.DiGraph, start_node: Tuple[float, float]) -> List[Tuple[float, float]]:
        """Modified Chinese Postman Problem solution for a single component"""
        try:
            # Find undriven edges in this component
            undriven_edges = [(u, v) for u, v in graph.edges()
                              if not graph[u][v].get('driven', False)]

            if not undriven_edges:
                return [start_node]

            # Create a working copy of the graph
            working_graph = graph.copy()

            # Add reverse edges where needed to ensure connectivity
            for u, v in list(working_graph.edges()):
                if not working_graph.has_edge(v, u):
                    edge_data = working_graph[u][v].copy()
                    working_graph.add_edge(v, u, **edge_data)

            # Find nearest undriven edge entry point
            try:
                entry_node = min(
                    set(n for edge in undriven_edges for n in edge),
                    key=lambda x: nx.shortest_path_length(
                        working_graph, start_node, x, weight='length'
                    )
                )
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                entry_node = start_node

            # Create Eulerian circuit starting from entry point
            circuit = self._create_eulerian_circuit(
                working_graph, entry_node, undriven_edges)

            return circuit

        except Exception as e:
            logger.error(f"Error in modified CPP: {str(e)}")
            return [start_node]

    def _create_eulerian_circuit(self, graph: nx.DiGraph, start_node: Tuple[float, float],
                                 undriven_edges: List[Tuple[Tuple[float, float], Tuple[float, float]]]) -> List[Tuple[float, float]]:
        """Create Eulerian circuit starting from a given node"""
        try:
            # Get the connected component containing the start node
            component = nx.node_connected_component(
                graph.to_undirected(), start_node)

            # Filter undriven edges to only those in the current component
            undriven_edges_in_component = [
                edge for edge in undriven_edges
                if edge[0] in component and edge[1] in component
            ]

            if not undriven_edges_in_component:
                return [start_node]

            # Create subgraph of the component and ensure it's connected
            subgraph = graph.subgraph(component).copy()

            # Add necessary edges to make the graph Eulerian-capable
            odd_degree_nodes = [n for n in subgraph.nodes()
                                if subgraph.degree(n) % 2 != 0]

            if odd_degree_nodes:
                # Add minimum weight edges to make graph Eulerian
                while odd_degree_nodes:
                    u = odd_degree_nodes[0]
                    # Find closest other odd-degree node
                    v = min(odd_degree_nodes[1:],
                            key=lambda x: self._calculate_distance(u, x))
                    # Add both directions to maintain balance
                    subgraph.add_edge(
                        u, v, weight=self._calculate_distance(u, v))
                    subgraph.add_edge(
                        v, u, weight=self._calculate_distance(u, v))
                    odd_degree_nodes.remove(u)
                    odd_degree_nodes.remove(v)

            try:
                # Try to find Eulerian circuit
                circuit = list(nx.eulerian_circuit(
                    subgraph, source=start_node))
                return [node for edge in circuit for node in edge]
            except nx.NetworkXError:
                # Fallback to greedy path finding
                path = []
                current = start_node
                remaining_edges = set(undriven_edges_in_component)

                while remaining_edges:
                    try:
                        # Find nearest undriven edge
                        next_edge = min(remaining_edges,
                                        key=lambda e: nx.shortest_path_length(
                                            subgraph, current, e[0], weight='length'
                                        ))
                        # Find path to next edge
                        connecting_path = nx.shortest_path(
                            subgraph, current, next_edge[0], weight='length'
                        )
                        # Don't duplicate nodes
                        path.extend(connecting_path[:-1])
                        path.extend([next_edge[0], next_edge[1]])
                        current = next_edge[1]
                        remaining_edges.remove(next_edge)
                    except (nx.NetworkXNoPath, ValueError):
                        # If we can't reach the next edge, remove it and continue
                        remaining_edges.pop()

                return path

        except Exception as e:
            logger.error(f"Error creating Eulerian circuit: {str(e)}")
            return [start_node]

    def _route_to_geojson(self, route: List[Tuple[float, float]]) -> dict:
        """Convert route to GeoJSON format"""
        features = []

        for i in range(len(route) - 1):
            start = route[i]
            end = route[i + 1]

            edge_data = self.graph.get_edge_data(start, end)
            if not edge_data:
                continue

            # Convert coordinates back to [longitude, latitude] for GeoJSON
            geometry = [self._denormalize_coordinates(coord)
                        for coord in edge_data.get('geometry', [start, end])]

            feature = {
                'type': 'Feature',
                'geometry': {
                    'type': 'LineString',
                    'coordinates': geometry
                },
                'properties': {
                    'name': edge_data.get('name', 'Unknown Street'),
                    'length': edge_data.get('length', 0),
                    'is_driven': edge_data.get('is_driven', False),
                    'sequence_number': i
                }
            }
            features.append(feature)

        return {
            'type': 'FeatureCollection',
            'features': features
        }

    def _calculate_route_stats(self, route: List[Tuple[float, float]]) -> Dict:
        """Calculate route statistics"""
        total_distance = 0
        undriven_distance = 0

        for i in range(len(route) - 1):
            start = route[i]
            end = route[i + 1]
            edge_data = self.graph.get_edge_data(start, end)

            if edge_data:
                distance = edge_data.get('length', 0)
                total_distance += distance

                if not edge_data.get('is_driven', False):
                    undriven_distance += distance

        return {
            'total_distance': total_distance,
            'undriven_distance': undriven_distance,
            'estimated_time': total_distance / 35  # Assuming 35 mph average speed
        }

    def _generate_turn_by_turn(self, route: List[Tuple[float, float]]) -> List[Dict]:
        """Generate turn-by-turn directions"""
        directions = []

        for i in range(len(route) - 1):
            start = route[i]
            end = route[i + 1]

            if i < len(route) - 2:
                next_end = route[i + 2]
                turn_angle = self._calculate_turn_angle(start, end, next_end)
                turn_direction = self._get_turn_direction(turn_angle)
            else:
                turn_direction = "Arrive"

            edge_data = self.graph.get_edge_data(start, end)
            if edge_data:
                directions.append({
                    'street_name': edge_data.get('name', 'Unknown Street'),
                    'distance': edge_data.get('length', 0),
                    'turn': turn_direction,
                    'is_driven': edge_data.get('is_driven', False)
                })

        return directions

    def _calculate_turn_angle(self, p1: Tuple[float, float], p2: Tuple[float, float],
                              p3: Tuple[float, float]) -> float:
        """Calculate the angle between three points"""
        import math

        angle1 = math.atan2(p2[0] - p1[0], p2[1] - p1[1])
        angle2 = math.atan2(p3[0] - p2[0], p3[1] - p2[1])

        angle = math.degrees(angle2 - angle1)

        if angle > 180:
            angle -= 360
        elif angle < -180:
            angle += 360

        return angle

    def _get_turn_direction(self, angle: float) -> str:
        """Convert angle to turn direction"""
        if -20 <= angle <= 20:
            return "Continue straight"
        if 20 < angle <= 150:
            return "Turn right"
        if -150 <= angle < -20:
            return "Turn left"
        return "Make a U-turn"

    def _check_graph_connectivity(self) -> None:
        """Check graph connectivity and log information about components"""
        if not self.graph:
            logger.warning("Graph not initialized")
            return

        components = list(nx.weakly_connected_components(self.graph))
        logger.info(f"Graph has {len(components)} weakly connected components")

        for i, component in enumerate(components):
            logger.info(f"Component {i+1} has {len(component)} nodes")

        if len(components) > 1:
            logger.warning(
                f"Graph has {len(components)} disconnected components - "
                "complete coverage may require multiple trips"
            )

    def _combine_component_routes(self, routes: List[List[Tuple[float, float]]],
                                  start_node: Tuple[float, float]) -> List[Tuple[float, float]]:
        """Combine routes from different components optimally"""
        if not routes:
            return [start_node]

        # Sort routes by distance from start node to first node of each route
        routes.sort(key=lambda route: self._calculate_distance(
            route[0], start_node))

        combined_route = [start_node]
        for route in routes:
            if route[0] != combined_route[-1]:
                # Add transition point
                combined_route.append(route[0])
            combined_route.extend(route[1:])

        return combined_route
