"""
Fixed coverage constants - no user configuration.

All values are fixed to ensure consistent behavior across the application.
Users cannot customize these values.
"""

# =============================================================================
# Street Segmentation (FIXED)
# =============================================================================
SEGMENT_LENGTH_FEET = 150.0
SEGMENT_LENGTH_METERS = SEGMENT_LENGTH_FEET * 0.3048

# =============================================================================
# Trip Matching (FIXED)
# =============================================================================
MATCH_BUFFER_FEET = 25.0  # Buffer around trip line
MATCH_BUFFER_METERS = MATCH_BUFFER_FEET * 0.3048
MIN_OVERLAP_FEET = 15.0  # Minimum overlap to count as driven
MIN_OVERLAP_METERS = MIN_OVERLAP_FEET * 0.3048

# =============================================================================
# Unit Conversions
# =============================================================================
FEET_TO_METERS = 0.3048
METERS_TO_FEET = 1.0 / FEET_TO_METERS
METERS_TO_MILES = 0.000621371
MILES_TO_METERS = 1609.344
DEGREES_TO_METERS = 111139.0

# =============================================================================
# Processing Limits
# =============================================================================
BATCH_SIZE = 1000
MAX_VIEWPORT_FEATURES = 5000
MAX_CONCURRENT_DB_OPS = 25
BATCH_PROCESS_DELAY = 0.01

# =============================================================================
# Retry/Rebuild Configuration
# =============================================================================
MAX_INGESTION_RETRIES = 3
RETRY_BASE_DELAY_SECONDS = 60  # 60s, 120s, 240s exponential backoff
OSM_REFRESH_DAYS = 90  # Auto-rebuild after 90 days
