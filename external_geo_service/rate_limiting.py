"""
Rate limiting utilities for external API calls.
"""

import asyncio

from aiolimiter import AsyncLimiter

# Mapbox allows 300 requests per minute - be conservative at 280
mapbox_rate_limiter = AsyncLimiter(280, 60)

# Semaphore for concurrent map matching requests
map_match_semaphore = asyncio.Semaphore(10)
