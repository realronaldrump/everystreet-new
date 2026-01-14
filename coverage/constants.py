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
MATCH_BUFFER_FEET = 40.0  # Buffer around trip line (increased for GPS drift)
MATCH_BUFFER_METERS = MATCH_BUFFER_FEET * 0.3048
MIN_OVERLAP_FEET = 10.0  # Minimum overlap to count as driven (reduced for accuracy)
MIN_OVERLAP_METERS = MIN_OVERLAP_FEET * 0.3048
MIN_GPS_GAP_METERS = 500.0  # Split trip lines when GPS gaps exceed this (increased)
MAX_GPS_GAP_METERS = 2000.0  # Cap the adaptive gap threshold
GPS_GAP_MULTIPLIER = 10.0  # Scale factor for adaptive gap detection
SHORT_SEGMENT_OVERLAP_RATIO = 0.4  # Require 40% of very short segments (reduced)

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
# Backfill Optimization
# =============================================================================
BACKFILL_TRIP_BATCH_SIZE = 500  # Number of trips to process per batch (increased)
BACKFILL_CONCURRENT_TRIPS = 50  # Max concurrent trip processing (increased)
BACKFILL_BULK_WRITE_SIZE = 1000  # Max operations per bulk write (increased)

# =============================================================================
# Retry/Rebuild Configuration
# =============================================================================
MAX_INGESTION_RETRIES = 3
RETRY_BASE_DELAY_SECONDS = 60  # 60s, 120s, 240s exponential backoff
OSM_REFRESH_DAYS = 90  # Auto-rebuild after 90 days
