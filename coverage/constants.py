"""Constants for street coverage calculation.

Default values, batch sizes, and other configuration constants.
"""

# Batch processing configuration
MAX_TRIPS_PER_BATCH = 500
BATCH_PROCESS_DELAY = 0.01
MAX_UPDATE_BATCH_SIZE = 10000
MAX_TRIP_IDS_TO_STORE = 50000

# Buffer defaults (in meters)
# 50 feet = 50 * 0.3048 meters
DEFAULT_MATCH_BUFFER_METERS = 50.0 * 0.3048
# 15 feet = 15 * 0.3048 meters
DEFAULT_MIN_MATCH_LENGTH_METERS = 15.0 * 0.3048

# Conversion constants
FEET_TO_METERS = 0.3048
METERS_TO_MILES = 0.000621371
DEGREES_TO_METERS = 111139.0
