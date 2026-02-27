"""
Fixed coverage constants - no user configuration.

All values are fixed to ensure consistent behavior across the application.
Users cannot customize these values.
"""

# =============================================================================
# Street Segmentation (FIXED)
# =============================================================================
# Segments follow natural graph edges (intersection to intersection).
# Only edges exceeding MAX_SEGMENT_LENGTH_METERS are split into sub-segments.
MAX_SEGMENT_LENGTH_METERS = 500.0  # ~1640ft — split longer edges for practicality

# =============================================================================
# Trip Matching (FIXED)
# =============================================================================
# Map-matched trips: tighter buffer since geometry is snapped to roads
MATCH_BUFFER_FEET = 30.0  # Buffer around map-matched trip line
MATCH_BUFFER_METERS = MATCH_BUFFER_FEET * 0.3048

# Raw GPS trips: slightly smaller buffer to penalize unmatched geometry
RAW_GPS_BUFFER_FEET = 25.0
RAW_GPS_BUFFER_METERS = RAW_GPS_BUFFER_FEET * 0.3048

MIN_OVERLAP_FEET = 25.0  # Absolute minimum overlap floor (for very short segments)
MIN_OVERLAP_METERS = MIN_OVERLAP_FEET * 0.3048
MIN_GPS_GAP_METERS = 500.0  # Split trip lines when GPS gaps exceed this (increased)
MAX_GPS_GAP_METERS = 2000.0  # Cap the adaptive gap threshold
GPS_GAP_MULTIPLIER = 10.0  # Scale factor for adaptive gap detection
COVERAGE_OVERLAP_RATIO = 0.50  # Require 50% of segment length to be covered

# Raw GPS requires stricter overlap to reduce false positives from GPS drift
RAW_GPS_OVERLAP_RATIO = 0.75

# Bearing alignment: max angle difference (degrees) between trip and street segment
# to count as a valid match. Prevents crediting parallel roads.
MAX_BEARING_DIFF_DEGREES = 45.0

# Segment length categories for tiered overlap requirements
SHORT_SEGMENT_THRESHOLD_METERS = 15.0  # Segments shorter than this need 75% overlap
MEDIUM_SEGMENT_THRESHOLD_METERS = 50.0  # Segments shorter than this need 60% overlap
SHORT_SEGMENT_OVERLAP_RATIO = 0.75
MEDIUM_SEGMENT_OVERLAP_RATIO = 0.60

# =============================================================================
# Unit Conversions
# =============================================================================
from core.constants import METERS_TO_MILES  # noqa: E402

MILES_TO_METERS = 1609.344

# =============================================================================
# Processing Limits
# =============================================================================
BATCH_SIZE = 1000
MAX_VIEWPORT_FEATURES = 5000

# =============================================================================
# Backfill Optimization (Configurable for memory-constrained systems)
# =============================================================================
# Lower defaults to reduce memory pressure; override via environment variables


def _get_int_env(name: str, default: int) -> int:
    """Get an integer from environment variable with default."""
    import os

    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return max(int(raw), 1)
    except ValueError:
        return default


# Number of trips to process per batch (reduced from 500 to 100 for memory safety)
BACKFILL_TRIP_BATCH_SIZE = _get_int_env("COVERAGE_TRIP_BATCH_SIZE", 100)

# Max operations per bulk write (reduced from 1000 to 500)
BACKFILL_BULK_WRITE_SIZE = _get_int_env("COVERAGE_BULK_WRITE_SIZE", 500)

# Max segments to load into memory for spatial indexing (fail-safe for large areas)
MAX_SEGMENTS_IN_MEMORY = _get_int_env("COVERAGE_MAX_SEGMENTS", 100000)


# =============================================================================
# Retry/Rebuild Configuration
# =============================================================================
MAX_INGESTION_RETRIES = 3
RETRY_BASE_DELAY_SECONDS = 60  # 60s, 120s, 240s exponential backoff
