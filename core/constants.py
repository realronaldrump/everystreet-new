"""Global constants for the core package.

This module contains shared constants used across the application core.
"""

from typing import Final

# HTTP Client Constants
HTTP_CONNECTION_LIMIT: Final[int] = 10
HTTP_TIMEOUT_CONNECT: Final[float] = 10.0
HTTP_TIMEOUT_SOCK_READ: Final[float] = 60.0
HTTP_TIMEOUT_TOTAL: Final[float] = 300.0

# Distance Conversion
METERS_TO_MILES: Final[float] = 0.000621371
