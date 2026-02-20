from pathlib import Path

# Distance constants in FEET (user preference: imperial units)
FEET_PER_METER = 3.28084
MAX_SEGMENTS = 50000
ROUTING_BUFFER_FT = 6500.0  # ~2000m - buffer to include connecting highways/roads
MAX_ROUTE_GAP_FT = 10000.0  # ~3000m (~1.9 miles) - max allowed gap between route points
MAX_DEADHEAD_RATIO_WARN = 6.0
MAX_DEADHEAD_RATIO_ERROR = 10.0
# Deadhead ratio becomes meaningless when required work is tiny. Use a floor (meters)
# when evaluating ratio thresholds to avoid hard-failing valid "last few segments" runs.
DEADHEAD_RATIO_REQUIRED_DISTANCE_FLOOR_M = 5000.0  # ~3.1 miles
MIN_SEGMENT_COVERAGE_RATIO = 0.9
MAX_OSM_MATCH_DISTANCE_FT = 1640.0  # ~500m - max distance for OSM ID matching
# Spatial fallback should never blindly match a segment to a far-away edge.
MAX_SPATIAL_MATCH_DISTANCE_FT = 1640.0  # keep consistent with OSM ID threshold

# Optional Valhalla trace_route fallback for hard-to-match segments.
VALHALLA_TRACE_FALLBACK_MAX_SEGMENTS = 250

# If the solver skips required segments (typically due to disconnected graph components),
# treat it as a quality issue. Warn on any skip; error if it's meaningfully large.
MAX_SKIPPED_REQ_RATIO_ERROR = 0.02  # 2%
MAX_SKIPPED_REQ_COUNT_ERROR = 50
GRAPH_STORAGE_DIR = Path("data/graphs")

# 2-opt local search configuration
LOCAL_SEARCH_TIME_BUDGET_S = 30
LOCAL_SEARCH_MIN_REQS = 10  # skip for tiny routes

# Zone decomposition for large areas
ZONE_DECOMPOSITION_THRESHOLD = 2000
ZONE_MAX_SIZE = 1500

# Gap-filling threshold (bridge discontinuities with Valhalla)
GAP_FILL_THRESHOLD_FT = 200.0
