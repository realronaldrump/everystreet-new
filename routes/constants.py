from pathlib import Path

# Distance constants in FEET (user preference: imperial units)
FEET_PER_METER = 3.28084
MAX_SEGMENTS = 5000
ROUTING_BUFFER_FT = 6500.0  # ~2000m - buffer to include connecting highways/roads
MAX_ROUTE_GAP_FT = 10000.0  # ~3000m (~1.9 miles) - max allowed gap between route points
MAX_DEADHEAD_RATIO_WARN = 6.0
MAX_DEADHEAD_RATIO_ERROR = 10.0
MIN_SEGMENT_COVERAGE_RATIO = 0.9
MAX_OSM_MATCH_DISTANCE_FT = 1640.0  # ~500m - max distance for OSM ID matching
GRAPH_STORAGE_DIR = Path("data/graphs")
