"""External Geo Service Module.

This module provides the ExternalGeoService class that handles all external
geolocation API calls (Mapbox and Nominatim) for geocoding and map matching,
following the Single Responsibility Principle.
"""

import asyncio
import logging
from typing import Any

import aiohttp
import pyproj
from aiolimiter import AsyncLimiter

from date_utils import parse_timestamp
from geometry_service import GeometryService
from utils import get_session, reverse_geocode_mapbox, reverse_geocode_nominatim

logger = logging.getLogger(__name__)

# Mapbox allows 300 requests per minute - be conservative at 280
mapbox_rate_limiter = AsyncLimiter(280, 60)
# Semaphore for concurrent map matching requests
map_match_semaphore = asyncio.Semaphore(10)


class ExternalGeoService:
    """Service for external geocoding and map matching APIs.

    Handles all external API calls to Mapbox and Nominatim for geocoding
    and map matching operations.
    """

    def __init__(self, mapbox_token: str | None = None):
        """Initialize the geo service.

        Args:
            mapbox_token: Optional Mapbox access token for geocoding and map matching
        """
        self.mapbox_token = mapbox_token
        self.utm_proj = None

    async def reverse_geocode(
        self,
        lat: float,
        lon: float,
    ) -> dict[str, Any] | None:
        """Reverse geocode coordinates using Mapbox or Nominatim fallback.

        Args:
            lat: Latitude
            lon: Longitude

        Returns:
            Geocoding result dictionary or None if failed
        """
        result = None

        if self.mapbox_token:
            async with mapbox_rate_limiter:
                result = await reverse_geocode_mapbox(
                    lat,
                    lon,
                    self.mapbox_token,
                )

        # Fallback to Nominatim if Mapbox failed or not configured
        if not result:
            result = await reverse_geocode_nominatim(lat, lon)

        return result

    def parse_geocode_response(
        self,
        response: dict[str, Any],
        coordinates: list[float],
    ) -> dict[str, Any]:
        """Parse geocoding response into structured location schema.

        Args:
            response: Raw geocoding API response
            coordinates: [lon, lat] coordinates

        Returns:
            Structured location data
        """
        structured = self.get_empty_location_schema()
        structured["coordinates"]["lng"] = coordinates[0]
        structured["coordinates"]["lat"] = coordinates[1]

        # Handle Mapbox response format
        if self.mapbox_token and "place_name" in response:
            structured["formatted_address"] = response.get("place_name", "")

            for ctx in response.get("context", []):
                if "id" in ctx:
                    if ctx["id"].startswith("postcode"):
                        structured["address_components"]["postal_code"] = ctx.get(
                            "text", ""
                        )
                    elif ctx["id"].startswith("place"):
                        structured["address_components"]["city"] = ctx.get("text", "")
                    elif ctx["id"].startswith("region"):
                        structured["address_components"]["state"] = ctx.get("text", "")
                    elif ctx["id"].startswith("country"):
                        structured["address_components"]["country"] = ctx.get(
                            "text", ""
                        )

            if "text" in response:
                structured["address_components"]["street"] = response.get("text", "")
            if "address" in response:
                structured["address_components"]["street_number"] = response.get(
                    "address", ""
                )

        # Handle Nominatim response format
        elif "display_name" in response:
            structured["formatted_address"] = response.get("display_name", "")

            if "address" in response:
                addr = response["address"]
                component_mapping = {
                    "house_number": "street_number",
                    "road": "street",
                    "city": "city",
                    "town": "city",
                    "village": "city",
                    "county": "county",
                    "state": "state",
                    "postcode": "postal_code",
                    "country": "country",
                }

                for nominatim_key, our_key in component_mapping.items():
                    if nominatim_key in addr:
                        structured["address_components"][our_key] = addr[nominatim_key]

        return structured

    @staticmethod
    def get_empty_location_schema() -> dict[str, Any]:
        """Get empty location schema structure.

        Returns:
            Empty location schema dictionary
        """
        return {
            "formatted_address": "",
            "address_components": {
                "street_number": "",
                "street": "",
                "city": "",
                "county": "",
                "state": "",
                "postal_code": "",
                "country": "",
            },
            "coordinates": {
                "lat": 0.0,
                "lng": 0.0,
            },
        }

    @staticmethod
    async def forward_geocode_nominatim(
        query: str,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country_codes: str = "us",
    ) -> list[dict[str, Any]]:
        """Forward geocode a query using Nominatim (OSM) API.

        Args:
            query: Search query string
            limit: Maximum number of results
            proximity: Optional (longitude, latitude) tuple to bias results
            country_codes: Comma-separated country codes to limit results

        Returns:
            List of normalized geocoding results
        """
        params: dict[str, Any] = {
            "q": query,
            "format": "json",
            "limit": limit,
            "addressdetails": 1,
            "countrycodes": country_codes,
        }

        if proximity:
            lon, lat = proximity
            params["viewbox"] = f"{lon - 2},{lat + 2},{lon + 2},{lat - 2}"
            params["bounded"] = 1
        else:
            params["viewbox"] = "-125,49,-66,24"

        headers = {"User-Agent": "EveryStreet/1.0"}
        session = await get_session()

        try:
            async with session.get(
                "https://nominatim.openstreetmap.org/search",
                params=params,
                headers=headers,
                timeout=10,
            ) as response:
                response.raise_for_status()
                results = await response.json()

                normalized = []
                for result in results:
                    normalized.append(
                        {
                            "place_name": result.get("display_name", ""),
                            "center": [float(result["lon"]), float(result["lat"])],
                            "place_type": [result.get("type", "unknown")],
                            "text": result.get("name", ""),
                            "osm_id": result.get("osm_id"),
                            "osm_type": result.get("osm_type"),
                            "type": result.get("type"),
                            "lat": result.get("lat"),
                            "lon": result.get("lon"),
                            "display_name": result.get("display_name"),
                            "address": result.get("address", {}),
                            "importance": result.get("importance", 0),
                            "bbox": result.get("boundingbox"),
                        }
                    )
                return normalized
        except Exception as e:
            logger.warning("Nominatim forward geocoding error: %s", e)
            return []

    async def forward_geocode_mapbox(
        self,
        query: str,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country: str = "US",
    ) -> list[dict[str, Any]]:
        """Forward geocode a query using Mapbox Geocoding API.

        Args:
            query: Search query string
            limit: Maximum number of results
            proximity: Optional (longitude, latitude) tuple to bias results
            country: Country code to limit results

        Returns:
            List of normalized geocoding results
        """
        if not self.mapbox_token:
            logger.warning("Mapbox token not configured for forward geocoding")
            return []

        import urllib.parse

        encoded_query = urllib.parse.quote(query)
        url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{encoded_query}.json"
        params: dict[str, Any] = {
            "access_token": self.mapbox_token,
            "limit": limit,
            "country": country,
        }

        if proximity:
            params["proximity"] = f"{proximity[0]},{proximity[1]}"
        else:
            params["proximity"] = "-99.9018,31.9686"

        session = await get_session()

        try:
            async with (
                mapbox_rate_limiter,
                session.get(url, params=params, timeout=10) as response,
            ):
                response.raise_for_status()
                data = await response.json()

                results = []
                for feature in data.get("features", []):
                    results.append(
                        {
                            "place_name": feature.get("place_name", ""),
                            "center": feature.get("center", []),
                            "place_type": feature.get("place_type", []),
                            "text": feature.get("text", ""),
                            "bbox": feature.get("bbox"),
                            "context": feature.get("context", []),
                        }
                    )
                return results
        except Exception as e:
            logger.warning("Mapbox forward geocoding error: %s", e)
            return []

    async def forward_geocode(
        self,
        query: str,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        prefer_mapbox: bool | None = None,
    ) -> list[dict[str, Any]]:
        """Forward geocode with automatic fallback (Mapbox → Nominatim).

        Args:
            query: Search query string
            limit: Maximum number of results
            proximity: Optional (longitude, latitude) tuple to bias results
            prefer_mapbox: If True, use Mapbox; if False, use Nominatim;
                          if None, use Mapbox if token is configured

        Returns:
            List of normalized geocoding results
        """
        use_mapbox = self.mapbox_token and (
            prefer_mapbox is None or prefer_mapbox is True
        )

        if use_mapbox:
            results = await self.forward_geocode_mapbox(query, limit, proximity)
            if results:
                return results
            # Fallback to Nominatim if Mapbox returns empty
            logger.info("Mapbox returned no results, falling back to Nominatim")

        return await self.forward_geocode_nominatim(query, limit, proximity)

    async def map_match_coordinates(
        self,
        coordinates: list[list[float]],
        timestamps: list[int | None] | None = None,
        chunk_size: int = 100,
        overlap: int = 15,
        max_retries: int = 3,
        min_sub_chunk: int = 20,
        jump_threshold_m: float = 200.0,
    ) -> dict[str, Any]:
        """Map match coordinates using the Mapbox API.

        Args:
            coordinates: List of [lon, lat] coordinates
            timestamps: Optional list of Unix timestamps
            chunk_size: Maximum coordinates per API request (max 100)
            overlap: Overlap between chunks for better stitching
            max_retries: Maximum retries for failed chunks
            min_sub_chunk: Minimum coordinates for recursive splitting
            jump_threshold_m: Threshold for detecting jumps in meters

        Returns:
            Dictionary with map matching results
        """
        if not self.mapbox_token:
            return {
                "code": "Error",
                "message": "No Mapbox token configured for map matching.",
            }

        if len(coordinates) < 2:
            return {
                "code": "Error",
                "message": "At least two coordinates are required for map matching.",
            }

        if not self.utm_proj:
            self._initialize_projections(coordinates)

        session = await get_session()
        return await self._process_map_matching(
            session,
            coordinates,
            timestamps,
            chunk_size,
            overlap,
            max_retries,
            min_sub_chunk,
            jump_threshold_m,
        )

    def _initialize_projections(self, coords: list[list[float]]) -> None:
        """Initialize projections for map matching.

        Args:
            coords: Coordinates to determine UTM zone
        """
        lats = [c[1] for c in coords]
        lons = [c[0] for c in coords]
        center_lat = sum(lats) / len(lats)
        center_lon = sum(lons) / len(lons)

        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"

        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84",
        )

    async def _process_map_matching(
        self,
        session: aiohttp.ClientSession,
        coordinates: list[list[float]],
        all_timestamps: list[int | None] | None,
        chunk_size: int,
        overlap: int,
        max_retries: int,
        min_sub_chunk: int,
        jump_threshold_m: float,
    ) -> dict[str, Any]:
        """Process map matching with chunking and stitching.

        Args:
            session: aiohttp session
            coordinates: Coordinates to match
            all_timestamps: Optional timestamps
            chunk_size: Size of each chunk
            overlap: Overlap between chunks
            max_retries: Max retry attempts
            min_sub_chunk: Min chunk size for splitting
            jump_threshold_m: Jump detection threshold

        Returns:
            Map matching result dictionary
        """

        async def call_mapbox_api(
            coords: list[list[float]],
            timestamps_chunk: list[int | None] | None = None,
        ) -> dict[str, Any]:
            """Call Mapbox Map Matching API using POST."""
            coordinates_data = self._build_coordinates_data(coords, timestamps_chunk)
            radiuses = self._calculate_adaptive_radiuses(coords, timestamps_chunk)
            request_body = {"coordinates": coordinates_data, "radiuses": radiuses}

            params = {
                "access_token": self.mapbox_token,
                "geometries": "geojson",
                "overview": "full",
                "tidy": "true",
                "steps": "false",
            }

            return await self._execute_mapbox_request(session, params, request_body)

        async def match_chunk(
            chunk_coords: list[list[float]],
            chunk_timestamps: list[int | None] | None = None,
            depth: int = 0,
        ) -> list[list[float]] | None:
            """Match a chunk of coordinates."""
            if not self._is_valid_chunk(chunk_coords):
                return []

            matched_coords = await self._try_match_chunk(
                chunk_coords, chunk_timestamps, call_mapbox_api
            )
            if matched_coords is not None:
                return matched_coords

            # Try recursive splitting if allowed
            if depth < max_retries and len(chunk_coords) > min_sub_chunk:
                return await self._match_chunk_recursive(
                    chunk_coords, chunk_timestamps, depth, match_chunk
                )

            return None

        # Split coordinates into chunks
        chunk_indices = self._create_chunk_indices(coordinates, chunk_size, overlap)
        logger.info(
            "Splitting %d coords into %d chunks", len(coordinates), len(chunk_indices)
        )

        # Process chunks and stitch results
        final_matched = await self._process_and_stitch_chunks(
            coordinates, all_timestamps, chunk_indices, match_chunk
        )
        if isinstance(final_matched, dict):  # Error dict
            return final_matched

        # Detect and fix jumps
        final_matched = await self._fix_route_jumps(
            final_matched, jump_threshold_m, match_chunk
        )

        logger.info("Final matched coords: %d points", len(final_matched))

        return self._create_matching_result(final_matched)

    @staticmethod
    def _build_coordinates_data(
        coords: list[list[float]],
        timestamps_chunk: list[int | None] | None,
    ) -> list[list[float | int]]:
        """Build coordinate data with optional timestamps."""
        coordinates_data = []
        for i, (lon, lat) in enumerate(coords):
            coord = [lon, lat]
            if (
                timestamps_chunk
                and i < len(timestamps_chunk)
                and timestamps_chunk[i] is not None
            ):
                coord.append(timestamps_chunk[i])
            coordinates_data.append(coord)
        return coordinates_data

    def _calculate_adaptive_radiuses(
        self,
        coords: list[list[float]],
        timestamps_chunk: list[int | None] | None,
    ) -> list[int]:
        """Calculate adaptive radiuses based on timestamps and distances."""
        radiuses = []
        for i, coord in enumerate(coords):
            if i == 0:
                radiuses.append(25)
                continue

            # Try timestamp-based radius first
            if self._has_valid_timestamps(timestamps_chunk, i):
                time_diff = abs(timestamps_chunk[i] - timestamps_chunk[i - 1])
                radiuses.append(50 if time_diff > 0 else 25)
            else:
                # Fallback to distance-based radius
                prev_coord = coords[i - 1]
                distance = GeometryService.haversine_distance(
                    prev_coord[0], prev_coord[1], coord[0], coord[1], unit="meters"
                )
                radiuses.append(50 if distance > 100 else 25)

        return radiuses

    @staticmethod
    def _has_valid_timestamps(
        timestamps_chunk: list[int | None] | None, index: int
    ) -> bool:
        """Check if valid timestamps exist for current and previous index."""
        return (
            timestamps_chunk is not None
            and index > 0
            and timestamps_chunk[index] is not None
            and timestamps_chunk[index - 1] is not None
        )

    async def _execute_mapbox_request(
        self,
        session: aiohttp.ClientSession,
        params: dict,
        request_body: dict,
    ) -> dict[str, Any]:
        """Execute Mapbox API request with retries."""
        base_url = "https://api.mapbox.com/matching/v5/mapbox/driving"
        max_attempts = 5
        min_backoff = 2

        async with map_match_semaphore:
            for attempt in range(1, max_attempts + 1):
                async with mapbox_rate_limiter:
                    pass

                try:
                    async with session.post(
                        base_url, params=params, json=request_body
                    ) as response:
                        result = await self._handle_mapbox_response(
                            response, attempt, max_attempts, min_backoff
                        )
                        if result is not None:
                            return result
                except Exception as e:
                    if attempt < max_attempts:
                        await asyncio.sleep(min_backoff * (2 ** (attempt - 1)))
                        continue
                    return {"code": "Error", "message": f"Mapbox API error: {e!s}"}

            return {"code": "Error", "message": "All retry attempts failed"}

    async def _handle_mapbox_response(
        self,
        response: aiohttp.ClientResponse,
        attempt: int,
        max_attempts: int,
        min_backoff: int,
    ) -> dict[str, Any] | None:
        """Handle different response status codes from Mapbox API."""
        if response.status == 429:
            return await self._handle_rate_limit(
                response, attempt, max_attempts, min_backoff
            )

        if 400 <= response.status < 500:
            error_text = await response.text()
            return {
                "code": "Error",
                "message": f"Mapbox API error: {response.status}",
                "details": error_text,
            }

        if response.status >= 500:
            if attempt < max_attempts:
                await asyncio.sleep(min_backoff * (2 ** (attempt - 1)))
                return None
            return {
                "code": "Error",
                "message": f"Mapbox server error: {response.status}",
            }

        response.raise_for_status()
        return await response.json()

    @staticmethod
    async def _handle_rate_limit(
        response: aiohttp.ClientResponse,
        attempt: int,
        max_attempts: int,
        min_backoff: int,
    ) -> dict[str, Any] | None:
        """Handle rate limit responses."""
        retry_after = response.headers.get("Retry-After")
        wait = float(retry_after) if retry_after else min_backoff * (2 ** (attempt - 1))
        if attempt < max_attempts:
            await asyncio.sleep(wait)
            return None
        return {
            "code": "Error",
            "message": "Too Many Requests (exceeded max attempts)",
        }

    @staticmethod
    def _is_valid_chunk(chunk_coords: list[list[float]]) -> bool:
        """Validate chunk size."""
        if len(chunk_coords) < 2:
            return False
        if len(chunk_coords) > 100:
            logger.error("match_chunk received >100 coords unexpectedly.")
            return False
        return True

    async def _try_match_chunk(
        self,
        chunk_coords: list[list[float]],
        chunk_timestamps: list[int | None] | None,
        call_mapbox_api,
    ) -> list[list[float]] | None:
        """Try to match a chunk using Mapbox API."""
        try:
            data = await call_mapbox_api(chunk_coords, chunk_timestamps)
            if data.get("code") == "Ok" and data.get("matchings"):
                return data["matchings"][0]["geometry"]["coordinates"]

            msg = data.get("message", "Mapbox API error (code != Ok)")
            logger.warning("Mapbox chunk error: %s", msg)

            # Try filtering invalid coordinates
            if "invalid coordinates" in msg.lower():
                return await self._retry_with_filtered_coords(
                    chunk_coords, call_mapbox_api
                )

        except Exception as exc:
            logger.warning("Unexpected error in mapbox chunk: %s", str(exc))

        return None

    async def _retry_with_filtered_coords(
        self,
        chunk_coords: list[list[float]],
        call_mapbox_api,
    ) -> list[list[float]] | None:
        """Retry matching after filtering invalid coordinates."""
        filtered = [
            c for c in chunk_coords if GeometryService.validate_coordinate_pair(c)[0]
        ]
        if len(filtered) >= 2 and len(filtered) < len(chunk_coords):
            # Recursively try with filtered coords (depth doesn't increment for this)
            result = await self._try_match_chunk(filtered, None, call_mapbox_api)
            return result
        return None

    @staticmethod
    async def _match_chunk_recursive(
        chunk_coords: list[list[float]],
        chunk_timestamps: list[int | None] | None,
        depth: int,
        match_chunk,
    ) -> list[list[float]] | None:
        """Recursively split and match chunks."""
        mid = len(chunk_coords) // 2
        first_ts = chunk_timestamps[:mid] if chunk_timestamps else None
        second_ts = chunk_timestamps[mid:] if chunk_timestamps else None

        matched_first = await match_chunk(chunk_coords[:mid], first_ts, depth + 1)
        matched_second = await match_chunk(chunk_coords[mid:], second_ts, depth + 1)

        if matched_first is not None and matched_second is not None:
            # Remove duplicate point at junction
            if (
                matched_first
                and matched_second
                and matched_first[-1] == matched_second[0]
            ):
                matched_second = matched_second[1:]
            return matched_first + matched_second

        return None

    @staticmethod
    def _create_chunk_indices(
        coordinates: list[list[float]],
        chunk_size: int,
        overlap: int,
    ) -> list[tuple[int, int]]:
        """Create chunk indices with overlap."""
        n = len(coordinates)
        chunk_indices = []
        start_idx = 0
        while start_idx < n:
            end_idx = min(start_idx + chunk_size, n)
            chunk_indices.append((start_idx, end_idx))
            if end_idx == n:
                break
            start_idx = end_idx - overlap
        return chunk_indices

    @staticmethod
    async def _process_and_stitch_chunks(
        coordinates: list[list[float]],
        all_timestamps: list[int | None] | None,
        chunk_indices: list[tuple[int, int]],
        match_chunk,
    ) -> list[list[float]] | dict[str, Any]:
        """Process all chunks and stitch them together."""
        final_matched: list[list[float]] = []

        for idx, (start_i, end_i) in enumerate(chunk_indices, 1):
            chunk_coords = coordinates[start_i:end_i]
            chunk_ts = (
                all_timestamps[start_i:end_i]
                if all_timestamps and len(all_timestamps) == len(coordinates)
                else None
            )

            result = await match_chunk(chunk_coords, chunk_ts, depth=0)
            if result is None:
                return {
                    "code": "Error",
                    "message": f"Chunk {idx} of {len(chunk_indices)} failed map matching.",
                }

            if not final_matched:
                final_matched = result
            else:
                # Remove duplicate point at junction
                if final_matched[-1] == result[0]:
                    result = result[1:]
                final_matched.extend(result)

        return final_matched

    async def _fix_route_jumps(
        self,
        coords: list[list[float]],
        threshold_m: float,
        match_chunk,
    ) -> list[list[float]]:
        """Detect and fix jumps in the route."""
        for _ in range(2):
            jumps = self._detect_jumps(coords, threshold_m)
            if not jumps:
                break

            coords = await self._repair_jumps(coords, jumps, match_chunk)

        return coords

    @staticmethod
    def _detect_jumps(coords: list[list[float]], threshold: float) -> list[int]:
        """Detect jumps larger than threshold in the route."""
        suspicious = []
        for i in range(len(coords) - 1):
            dist = GeometryService.haversine_distance(
                coords[i][0],
                coords[i][1],
                coords[i + 1][0],
                coords[i + 1][1],
                unit="meters",
            )
            if dist > threshold:
                suspicious.append(i)
        return suspicious

    @staticmethod
    async def _repair_jumps(
        coords: list[list[float]],
        jumps: list[int],
        match_chunk,
    ) -> list[list[float]]:
        """Repair detected jumps by rematching local areas."""
        new_coords = coords[:]
        offset = 0

        for j_idx in jumps:
            i = j_idx + offset
            if i < 1 or i >= len(new_coords) - 1:
                continue

            sub_coords = new_coords[i - 1 : i + 2]
            if len(sub_coords) < 2:
                continue

            local_match = await match_chunk(sub_coords, None, depth=0)
            if local_match and len(local_match) >= 2:
                new_coords = new_coords[: i - 1] + local_match + new_coords[i + 2 :]
                offset += len(local_match) - 3

        return new_coords

    @staticmethod
    def _create_matching_result(coords: list[list[float]]) -> dict[str, Any]:
        """Create final matching result dictionary."""
        geometry = GeometryService.geometry_from_coordinate_pairs(
            coords,
            allow_point=False,
            dedupe=False,
            validate=False,
        )
        if geometry is None:
            return {
                "code": "Error",
                "message": "Map matching produced insufficient coordinates.",
            }

        return {"code": "Ok", "matchings": [{"geometry": geometry}]}

    @staticmethod
    def extract_timestamps_for_coordinates(
        coordinates: list[list[float]],
        trip_data: dict[str, Any],
    ) -> list[int | None]:
        """Extract timestamps for coordinates, interpolating if necessary.

        Args:
            coordinates: List of [lon, lat] coordinates
            trip_data: Trip data containing optional timestamp info

        Returns:
            List of Unix timestamps or None values
        """
        timestamps: list[int | None] = []

        # Try to extract from coordinates field
        trip_coords = trip_data.get("coordinates", [])
        if trip_coords and len(trip_coords) == len(coordinates):
            for coord_obj in trip_coords:
                if isinstance(coord_obj, dict) and "timestamp" in coord_obj:
                    ts = coord_obj["timestamp"]
                    if isinstance(ts, str):
                        parsed = parse_timestamp(ts)
                        timestamps.append(int(parsed.timestamp()) if parsed else None)
                    elif hasattr(ts, "timestamp"):
                        timestamps.append(int(ts.timestamp()))
                    elif isinstance(ts, int | float):
                        timestamps.append(int(ts))
                    else:
                        timestamps.append(None)
                else:
                    timestamps.append(None)

            if any(t is not None for t in timestamps):
                return timestamps

        # Fallback: interpolate from start/end times
        start_time = trip_data.get("startTime")
        end_time = trip_data.get("endTime")

        if start_time and end_time:
            if isinstance(start_time, str):
                start_time = parse_timestamp(start_time)
            if isinstance(end_time, str):
                end_time = parse_timestamp(end_time)

            if start_time and end_time:
                start_ts = int(start_time.timestamp())
                end_ts = int(end_time.timestamp())
                duration = end_ts - start_ts

                if len(coordinates) > 1:
                    for i in range(len(coordinates)):
                        ratio = i / (len(coordinates) - 1)
                        timestamps.append(start_ts + int(duration * ratio))
                else:
                    timestamps.append(start_ts)

                return timestamps

        return [None] * len(coordinates)
