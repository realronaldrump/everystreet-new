"""Geometry and coordinate processing utilities.

This module contains optimized functions for processing coordinates, validating
geometry data, and performing common geospatial calculations used across
the application.
"""

import json
import logging
import math
from functools import lru_cache
from typing import Any, List, Optional, Tuple, Union

logger = logging.getLogger(__name__)

# Constants for coordinate validation and processing
MIN_LONGITUDE = -180.0
MAX_LONGITUDE = 180.0
MIN_LATITUDE = -90.0
MAX_LATITUDE = 90.0

# Earth radius constants for different units
EARTH_RADIUS_METERS = 6371000.0
EARTH_RADIUS_MILES = 3958.8
EARTH_RADIUS_KM = 6371.0

# Pre-computed conversion factors
RADIANS_PER_DEGREE = math.pi / 180.0
METERS_TO_MILES_FACTOR = 1609.34
MILES_TO_METERS_FACTOR = 1609.34
KM_TO_METERS_FACTOR = 1000.0


@lru_cache(maxsize=5000)
def validate_coordinate(lon: float, lat: float) -> bool:
    """Validate a single coordinate pair with caching.
    
    Args:
        lon: Longitude value
        lat: Latitude value
        
    Returns:
        bool: True if coordinate is valid
    """
    return (MIN_LONGITUDE <= lon <= MAX_LONGITUDE and 
            MIN_LATITUDE <= lat <= MAX_LATITUDE)


def validate_coordinates_fast(coordinates: List[List[float]], sample_size: int = 10) -> Tuple[bool, Optional[str]]:
    """Fast coordinate validation with sampling for large datasets.
    
    Args:
        coordinates: List of [longitude, latitude] coordinate pairs
        sample_size: Number of coordinates to sample for validation
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not coordinates or not isinstance(coordinates, list):
        return False, "Coordinates must be a non-empty list"
    
    if len(coordinates) < 2:
        return False, "At least 2 coordinate pairs required"
    
    # Sample coordinates for validation to improve performance
    sample_indices = range(0, len(coordinates), max(1, len(coordinates) // sample_size))
    
    for i in sample_indices:
        if i >= len(coordinates):
            break
            
        coord = coordinates[i]
        if not isinstance(coord, list) or len(coord) < 2:
            return False, f"Invalid coordinate format at index {i}"
        
        try:
            lon, lat = float(coord[0]), float(coord[1])
            if not validate_coordinate(lon, lat):
                return False, f"Invalid coordinate values at index {i}: [{lon}, {lat}]"
        except (ValueError, TypeError):
            return False, f"Non-numeric coordinate values at index {i}"
    
    return True, None


def parse_gps_data(gps_data: Union[str, dict]) -> Tuple[Optional[dict], Optional[str]]:
    """Parse and validate GPS data from string or dict format.
    
    Args:
        gps_data: GPS data as string or dictionary
        
    Returns:
        Tuple of (parsed_gps_data, error_message)
    """
    if not gps_data:
        return None, "GPS data is empty"
    
    try:
        if isinstance(gps_data, str):
            parsed = json.loads(gps_data)
        elif isinstance(gps_data, dict):
            parsed = gps_data
        else:
            return None, "GPS data must be string or dictionary"
        
        # Validate required fields
        if not isinstance(parsed, dict):
            return None, "GPS data must be a dictionary"
        
        if "type" not in parsed:
            return None, "GPS data missing 'type' field"
        
        if "coordinates" not in parsed:
            return None, "GPS data missing 'coordinates' field"
        
        coordinates = parsed["coordinates"]
        if not isinstance(coordinates, list):
            return None, "GPS coordinates must be a list"
        
        # Fast validation for different geometry types
        if parsed["type"] == "LineString":
            is_valid, error = validate_coordinates_fast(coordinates)
            if not is_valid:
                return None, f"Invalid LineString coordinates: {error}"
        elif parsed["type"] == "Point":
            if len(coordinates) < 2:
                return None, "Point coordinates must have at least 2 values"
            if not validate_coordinate(coordinates[0], coordinates[1]):
                return None, f"Invalid Point coordinates: {coordinates}"
        
        return parsed, None
        
    except json.JSONDecodeError as e:
        return None, f"Invalid JSON format: {str(e)}"
    except Exception as e:
        return None, f"Error parsing GPS data: {str(e)}"


@lru_cache(maxsize=3000)
def haversine_distance(
    lon1: float, lat1: float, lon2: float, lat2: float, unit: str = "meters"
) -> float:
    """Calculate haversine distance between two points with caching.
    
    Args:
        lon1, lat1: First point coordinates
        lon2, lat2: Second point coordinates
        unit: Distance unit ('meters', 'miles', 'km')
        
    Returns:
        Distance in specified unit
    """
    # Early return for identical points
    if lon1 == lon2 and lat1 == lat2:
        return 0.0
    
    # Get radius for unit
    radius_map = {
        "meters": EARTH_RADIUS_METERS,
        "miles": EARTH_RADIUS_MILES,
        "km": EARTH_RADIUS_KM,
    }
    
    radius = radius_map.get(unit)
    if radius is None:
        raise ValueError(f"Invalid unit: {unit}. Use 'meters', 'miles', or 'km'")
    
    # Convert to radians using pre-computed factor
    lon1_rad = lon1 * RADIANS_PER_DEGREE
    lat1_rad = lat1 * RADIANS_PER_DEGREE
    lon2_rad = lon2 * RADIANS_PER_DEGREE
    lat2_rad = lat2 * RADIANS_PER_DEGREE
    
    # Haversine formula optimized
    dlon = lon2_rad - lon1_rad
    dlat = lat2_rad - lat1_rad
    
    sin_dlat_2 = math.sin(dlat * 0.5)
    sin_dlon_2 = math.sin(dlon * 0.5)
    
    a = (sin_dlat_2 * sin_dlat_2 + 
         math.cos(lat1_rad) * math.cos(lat2_rad) * sin_dlon_2 * sin_dlon_2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    
    return radius * c


def calculate_total_distance(
    coordinates: List[List[float]], 
    unit: str = "miles",
    skip_invalid: bool = True
) -> float:
    """Calculate total distance along a coordinate path with optimizations.
    
    Args:
        coordinates: List of [longitude, latitude] coordinate pairs
        unit: Distance unit for result
        skip_invalid: Whether to skip invalid coordinates
        
    Returns:
        Total distance in specified unit
    """
    if not coordinates or len(coordinates) < 2:
        return 0.0
    
    total_distance = 0.0
    valid_pairs = 0
    
    for i in range(len(coordinates) - 1):
        try:
            coord1 = coordinates[i]
            coord2 = coordinates[i + 1]
            
            # Fast validation and extraction
            if (len(coord1) >= 2 and len(coord2) >= 2 and
                isinstance(coord1[0], (int, float)) and isinstance(coord1[1], (int, float)) and
                isinstance(coord2[0], (int, float)) and isinstance(coord2[1], (int, float))):
                
                lon1, lat1 = coord1[0], coord1[1]
                lon2, lat2 = coord2[0], coord2[1]
                
                # Skip identical consecutive points
                if lon1 != lon2 or lat1 != lat2:
                    distance = haversine_distance(lon1, lat1, lon2, lat2, unit)
                    total_distance += distance
                    valid_pairs += 1
                    
        except (TypeError, ValueError, IndexError) as e:
            if not skip_invalid:
                logger.warning(f"Skipping coordinate pair {i} due to error: {e}")
            continue
    
    return total_distance


def simplify_coordinates(
    coordinates: List[List[float]],
    tolerance: float = 0.0001,
    preserve_topology: bool = True
) -> List[List[float]]:
    """Simplify coordinate array using Douglas-Peucker algorithm.
    
    Args:
        coordinates: List of coordinate pairs
        tolerance: Simplification tolerance in degrees
        preserve_topology: Whether to preserve topology
        
    Returns:
        Simplified coordinate list
    """
    if len(coordinates) <= 2:
        return coordinates
    
    # Simple implementation of Douglas-Peucker
    def perpendicular_distance(point, line_start, line_end):
        """Calculate perpendicular distance from point to line."""
        if line_start == line_end:
            return haversine_distance(point[0], point[1], line_start[0], line_start[1])
        
        # Vector from line_start to line_end
        line_vec = [line_end[0] - line_start[0], line_end[1] - line_start[1]]
        # Vector from line_start to point
        point_vec = [point[0] - line_start[0], point[1] - line_start[1]]
        
        # Calculate perpendicular distance
        line_len_sq = line_vec[0]**2 + line_vec[1]**2
        if line_len_sq == 0:
            return haversine_distance(point[0], point[1], line_start[0], line_start[1])
        
        t = max(0, min(1, (point_vec[0] * line_vec[0] + point_vec[1] * line_vec[1]) / line_len_sq))
        projection = [line_start[0] + t * line_vec[0], line_start[1] + t * line_vec[1]]
        
        return haversine_distance(point[0], point[1], projection[0], projection[1])
    
    def douglas_peucker(coords, tolerance):
        """Recursive Douglas-Peucker simplification."""
        if len(coords) <= 2:
            return coords
        
        # Find the point with maximum distance from line
        max_dist = 0
        max_index = 0
        
        for i in range(1, len(coords) - 1):
            dist = perpendicular_distance(coords[i], coords[0], coords[-1])
            if dist > max_dist:
                max_dist = dist
                max_index = i
        
        # If max distance is greater than tolerance, recursively simplify
        if max_dist > tolerance:
            # Recursively simplify both parts
            left_part = douglas_peucker(coords[:max_index + 1], tolerance)
            right_part = douglas_peucker(coords[max_index:], tolerance)
            
            # Combine results (remove duplicate point at junction)
            return left_part[:-1] + right_part
        else:
            # All points are within tolerance, return just endpoints
            return [coords[0], coords[-1]]
    
    return douglas_peucker(coordinates, tolerance)


def get_bounding_box(coordinates: List[List[float]]) -> Optional[Tuple[float, float, float, float]]:
    """Calculate bounding box for coordinate array.
    
    Args:
        coordinates: List of coordinate pairs
        
    Returns:
        Tuple of (min_lon, min_lat, max_lon, max_lat) or None if invalid
    """
    if not coordinates:
        return None
    
    try:
        lons = [coord[0] for coord in coordinates if len(coord) >= 2]
        lats = [coord[1] for coord in coordinates if len(coord) >= 2]
        
        if not lons or not lats:
            return None
        
        return (min(lons), min(lats), max(lons), max(lats))
    except (IndexError, TypeError):
        return None


def create_linestring_geojson(coordinates: List[List[float]], properties: Optional[dict] = None) -> dict:
    """Create a GeoJSON LineString feature from coordinates.
    
    Args:
        coordinates: List of coordinate pairs
        properties: Optional properties dictionary
        
    Returns:
        GeoJSON feature dictionary
    """
    return {
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": coordinates
        },
        "properties": properties or {}
    }


def create_point_geojson(coordinate: List[float], properties: Optional[dict] = None) -> dict:
    """Create a GeoJSON Point feature from coordinate.
    
    Args:
        coordinate: [longitude, latitude] coordinate pair
        properties: Optional properties dictionary
        
    Returns:
        GeoJSON feature dictionary
    """
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": coordinate
        },
        "properties": properties or {}
    }


def batch_process_coordinates(
    coordinates_list: List[List[List[float]]],
    operation: callable,
    batch_size: int = 100,
    **kwargs
) -> List[Any]:
    """Process multiple coordinate arrays in batches for memory efficiency.
    
    Args:
        coordinates_list: List of coordinate arrays
        operation: Function to apply to each coordinate array
        batch_size: Number of coordinate arrays to process at once
        **kwargs: Additional arguments to pass to operation
        
    Returns:
        List of operation results
    """
    results = []
    
    for i in range(0, len(coordinates_list), batch_size):
        batch = coordinates_list[i:i + batch_size]
        
        for coords in batch:
            try:
                result = operation(coords, **kwargs)
                results.append(result)
            except Exception as e:
                logger.warning(f"Error processing coordinate batch: {e}")
                results.append(None)
    
    return results 