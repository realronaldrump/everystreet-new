import networkx as nx
from typing import List, Dict, Tuple
import osmnx as ox
from shapely.geometry import Point, LineString
import logging

logger = logging.getLogger(__name__)

class RouteOptimizer:
    def __init__(self):
        self.graph = None
        self.undriven_edges = set()
        self.driven_edges = set()

    def create_graph_from_streets(self, streets_geojson: dict, driven_segments: List[dict]) -> None:
        """Convert street GeoJSON into a NetworkX graph"""
        try:
            # Create an empty directed graph
            self.graph = nx.DiGraph()
            
            # Process each street segment
            for feature in streets_geojson['features']:
                coords = feature['geometry']['coordinates']
                street_id = feature['properties']['id']
                name = feature['properties'].get('name', 'Unknown Street')
                length = feature['properties'].get('length', 0)
                is_driven = feature['properties'].get('driven', False)
                
                # Create nodes for start and end points
                start_node = tuple(coords[0])
                end_node = tuple(coords[-1])
                
                # Add nodes and edge to graph
                self.graph.add_edge(
                    start_node, 
                    end_node,
                    street_id=street_id,
                    name=name,
                    length=length,
                    is_driven=is_driven
                )
                
                # Track driven/undriven edges
                edge = (start_node, end_node)
                if is_driven:
                    self.driven_edges.add(edge)
                else:
                    self.undriven_edges.add(edge)
                    
            logger.info(f"Created graph with {self.graph.number_of_nodes()} nodes and {self.graph.number_of_edges()} edges")
            
        except Exception as e:
            logger.error(f"Error creating graph: {str(e)}")
            raise

    def find_optimal_route(self, start_point: Tuple[float, float]) -> Dict:
        """Find optimal route to cover undriven streets"""
        try:
            # Find nearest node to start point
            start_node = self._find_nearest_node(start_point)
            
            # Modified Chinese Postman Problem solution
            route = self._solve_modified_cpp(start_node)
            
            # Convert route to GeoJSON
            route_geojson = self._route_to_geojson(route)
            
            # Calculate statistics
            stats = self._calculate_route_stats(route)
            
            return {
                'route': route_geojson,
                'statistics': stats,
                'turn_by_turn': self._generate_turn_by_turn(route)
            }
            
        except Exception as e:
            logger.error(f"Error finding optimal route: {str(e)}")
            raise

    def _find_nearest_node(self, point: Tuple[float, float]) -> Tuple[float, float]:
        """Find the nearest node in the graph to a given point"""
        min_dist = float('inf')
        nearest_node = None
        
        for node in self.graph.nodes():
            dist = ((node[0] - point[0])**2 + (node[1] - point[1])**2)**0.5
            if dist < min_dist:
                min_dist = dist
                nearest_node = node
                
        return nearest_node

    def _solve_modified_cpp(self, start_node: Tuple[float, float]) -> List:
        """Modified Chinese Postman Problem solver prioritizing undriven streets"""
        # Create a subgraph of undriven edges
        undriven_graph = self.graph.edge_subgraph(self.undriven_edges)
        
        # Find connected components
        components = list(nx.weakly_connected_components(undriven_graph))
        
        # Initialize final route
        complete_route = []
        current_node = start_node
        
        # Process each component
        for component in components:
            # Find shortest path to component
            entry_node = min(
                component,
                key=lambda x: nx.shortest_path_length(
                    self.graph, 
                    current_node, 
                    x, 
                    weight='length'
                )
            )
            
            # Add path to component
            path_to_component = nx.shortest_path(
                self.graph,
                current_node,
                entry_node,
                weight='length'
            )
            complete_route.extend(path_to_component[:-1])
            
            # Solve CPP for component
            component_route = self._solve_component_cpp(
                self.graph.subgraph(component),
                entry_node
            )
            complete_route.extend(component_route)
            
            current_node = complete_route[-1]
            
        return complete_route

    def _solve_component_cpp(self, graph: nx.DiGraph, start_node: Tuple[float, float]) -> List:
        """Solve CPP for a single component"""
        # Create an Eulerian circuit if possible
        eulerian_circuit = list(nx.eulerian_circuit(graph, source=start_node))
        return [node for edge in eulerian_circuit for node in edge]

    def _route_to_geojson(self, route: List) -> dict:
        """Convert route to GeoJSON format"""
        features = []
        
        for i in range(len(route) - 1):
            start = route[i]
            end = route[i + 1]
            
            edge_data = self.graph.get_edge_data(start, end)
            
            feature = {
                'type': 'Feature',
                'geometry': {
                    'type': 'LineString',
                    'coordinates': [start, end]
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

    def _calculate_route_stats(self, route: List) -> Dict:
        """Calculate route statistics"""
        total_distance = 0
        undriven_distance = 0
        
        for i in range(len(route) - 1):
            start = route[i]
            end = route[i + 1]
            edge_data = self.graph.get_edge_data(start, end)
            
            distance = edge_data.get('length', 0)
            total_distance += distance
            
            if not edge_data.get('is_driven', False):
                undriven_distance += distance
                
        return {
            'total_distance': total_distance,
            'undriven_distance': undriven_distance,
            'estimated_time': total_distance / 35  # Assuming 35 mph average speed
        }

    def _generate_turn_by_turn(self, route: List) -> List[Dict]:
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
            
            directions.append({
                'street_name': edge_data.get('name', 'Unknown Street'),
                'distance': edge_data.get('length', 0),
                'turn': turn_direction,
                'is_driven': edge_data.get('is_driven', False)
            })
            
        return directions

    def _calculate_turn_angle(self, p1, p2, p3) -> float:
        """Calculate the angle between three points"""
        import math
        
        angle1 = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
        angle2 = math.atan2(p3[1] - p2[1], p3[0] - p2[0])
        
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
        elif 20 < angle <= 150:
            return "Turn right"
        elif -150 <= angle < -20:
            return "Turn left"
        else:
            return "Make a U-turn"