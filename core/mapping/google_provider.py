"""
Google Maps provider utilizing the Google Maps Platform APIs.
"""

from typing import Any

from core.exceptions import ExternalServiceException
from core.http.request import request_json
from core.http.session import get_session
from core.mapping.interfaces import Geocoder, MappingProvider, Router


def _decode_polyline5(encoded: str) -> list[list[float]]:
    """Decode a precision-5 polyline into [lon, lat] coordinate pairs."""
    coords: list[list[float]] = []
    index = 0
    lat = 0
    lng = 0
    length = len(encoded or "")

    while index < length:
        shift = 0
        result = 0
        while True:
            if index >= length:
                msg = "Invalid polyline encoding"
                raise ExternalServiceException(msg, {"shape_format": "polyline5"})
            byte = ord(encoded[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        dlat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += dlat

        shift = 0
        result = 0
        while True:
            if index >= length:
                msg = "Invalid polyline encoding"
                raise ExternalServiceException(msg, {"shape_format": "polyline5"})
            byte = ord(encoded[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        dlng = ~(result >> 1) if (result & 1) else (result >> 1)
        lng += dlng

        coords.append([lng / 1e5, lat / 1e5])

    return coords


class GoogleGeocoder(Geocoder):
    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    @staticmethod
    def _status(data: dict[str, Any] | None) -> str:
        if not isinstance(data, dict):
            return "UNKNOWN"
        return str(data.get("status") or "UNKNOWN")

    @staticmethod
    def _google_bbox_to_nominatim_bbox(viewport: dict[str, Any] | None) -> list[str] | None:
        if not isinstance(viewport, dict):
            return None
        northeast = viewport.get("northeast") or {}
        southwest = viewport.get("southwest") or {}
        try:
            north = float(northeast.get("lat"))
            east = float(northeast.get("lng"))
            south = float(southwest.get("lat"))
            west = float(southwest.get("lng"))
        except (TypeError, ValueError):
            return None
        return [str(south), str(north), str(west), str(east)]

    @staticmethod
    def _viewport_polygon(viewport: dict[str, Any] | None) -> dict[str, Any] | None:
        bbox = GoogleGeocoder._google_bbox_to_nominatim_bbox(viewport)
        if not bbox:
            return None
        south, north, west, east = map(float, bbox)
        return {
            "type": "Polygon",
            "coordinates": [
                [
                    [west, south],
                    [west, north],
                    [east, north],
                    [east, south],
                    [west, south],
                ],
            ],
        }

    async def reverse(
        self,
        lat: float,
        lon: float,
        *,
        zoom: int = 18,
    ) -> dict[str, Any] | None:
        session = await get_session()
        params = {"latlng": f"{lat},{lon}", "key": self._api_key}
        data = await request_json(
            "GET",
            "https://maps.googleapis.com/maps/api/geocode/json",
            session=session,
            params=params,
            service_name="Google reverse geocode",
        )
        status = self._status(data if isinstance(data, dict) else None)
        if status != "OK":
            if status == "ZERO_RESULTS":
                return None
            msg = f"Google reverse geocode error: {status}"
            raise ExternalServiceException(msg)

        # Approximate a Nominatim-like response
        results = data.get("results", [])
        if not results:
            return None

        best = results[0]
        address_components = best.get("address_components", [])

        address_dict = {}
        for comp in address_components:
            types = comp.get("types", [])
            val = comp.get("long_name")
            if "street_number" in types:
                address_dict["house_number"] = val
            elif "route" in types:
                address_dict["road"] = val
            elif "locality" in types:
                address_dict["city"] = val
            elif "administrative_area_level_1" in types:
                address_dict["state"] = val
            elif "country" in types:
                address_dict["country"] = val
            elif "postal_code" in types:
                address_dict["postcode"] = val

        # Some Fallbacks
        if "road" not in address_dict and address_components:
            # use the formatted address prefix
            formatted = best.get("formatted_address", "")
            if formatted:
                address_dict["road"] = formatted.split(",")[0]

        return {
            "address": address_dict,
            "display_name": best.get("formatted_address", ""),
            "lat": lat,
            "lon": lon,
        }

    async def search(
        self,
        query: str,
        *,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country_codes: str | None = "us",
        strict_bounds: bool = False,
    ) -> list[dict[str, Any]]:
        # Mapbox Geocoding-like search (used in setup wizard / search bars).
        session = await get_session()
        params: dict[str, Any] = {
            "query": query,
            "key": self._api_key,
        }
        if proximity:
            params["location"] = f"{proximity[1]},{proximity[0]}"
            params["radius"] = 50000  # 50km

        data = await request_json(
            "GET",
            "https://maps.googleapis.com/maps/api/place/textsearch/json",
            session=session,
            params=params,
            service_name="Google text search",
        )
        if not isinstance(data, dict):
            msg = "Google text search error: unexpected response"
            raise ExternalServiceException(msg)
        status = self._status(data)
        if status == "ZERO_RESULTS":
            return []
        if status != "OK":
            msg = f"Google text search error: {status}"
            raise ExternalServiceException(msg)

        results = data.get("results", [])[:limit]
        mapped_results = []
        for r in results:
            loc = r.get("geometry", {}).get("location", {})
            lat = loc.get("lat", 0)
            lng = loc.get("lng", 0)
            mapped_results.append(
                {
                    "place_name": r.get("formatted_address", r.get("name", "")),
                    "text": r.get("name", ""),
                    "center": [lng, lat],
                    "lat": lat,
                    "lon": lng,
                    "display_name": r.get("formatted_address", r.get("name", "")),
                    "source": "google",
                    "place_id": r.get("place_id"),
                }
            )
        return mapped_results

    async def search_raw(
        self,
        *,
        query: str,
        limit: int = 1,
        polygon_geojson: bool = False,
        addressdetails: bool = True,
    ) -> list[dict[str, Any]]:
        session = await get_session()
        params: dict[str, Any] = {
            "query": query,
            "key": self._api_key,
        }
        data = await request_json(
            "GET",
            "https://maps.googleapis.com/maps/api/place/textsearch/json",
            session=session,
            params=params,
            service_name="Google text search",
        )
        if not isinstance(data, dict):
            msg = "Google text search error: unexpected response"
            raise ExternalServiceException(msg)

        status = self._status(data)
        if status == "ZERO_RESULTS":
            return []
        if status != "OK":
            msg = f"Google text search error: {status}"
            raise ExternalServiceException(msg)

        mapped: list[dict[str, Any]] = []
        for result in (data.get("results") or [])[: max(1, limit)]:
            if not isinstance(result, dict):
                continue
            geometry = result.get("geometry") or {}
            location = geometry.get("location") or {}
            lat = location.get("lat")
            lng = location.get("lng")
            if lat is None or lng is None:
                continue
            viewport = geometry.get("viewport") or {}
            mapped.append(
                {
                    "display_name": result.get("formatted_address")
                    or result.get("name")
                    or "",
                    "name": result.get("name") or "",
                    "osm_id": result.get("place_id"),
                    "osm_type": "google_place",
                    "place_id": result.get("place_id"),
                    "lat": lat,
                    "lon": lng,
                    "boundingbox": self._google_bbox_to_nominatim_bbox(viewport),
                    "geojson": (
                        self._viewport_polygon(viewport)
                        if polygon_geojson
                        else None
                    ),
                    "address": {},
                    "importance": result.get("rating"),
                    "type": (result.get("types") or [None])[0],
                    "class": "place",
                    "source": "google",
                },
            )
        return mapped

    async def lookup_raw(
        self,
        *,
        osm_id: int | str,
        osm_type: str,
        polygon_geojson: bool = True,
        addressdetails: bool = True,
    ) -> list[dict[str, Any]]:
        place_id = str(osm_id or "").strip()
        if not place_id:
            return []
        normalized_type = str(osm_type or "").strip().lower()
        if normalized_type and normalized_type not in {"google_place", "google", "place"}:
            raise NotImplementedError(
                "Google provider can only lookup place IDs created by Google search.",
            )

        session = await get_session()
        params: dict[str, Any] = {
            "place_id": place_id,
            "fields": "place_id,name,formatted_address,geometry,address_component,types",
            "key": self._api_key,
        }
        data = await request_json(
            "GET",
            "https://maps.googleapis.com/maps/api/place/details/json",
            session=session,
            params=params,
            service_name="Google place details",
        )
        if not isinstance(data, dict):
            msg = "Google place details error: unexpected response"
            raise ExternalServiceException(msg)

        status = self._status(data)
        if status == "ZERO_RESULTS":
            return []
        if status != "OK":
            msg = f"Google place details error: {status}"
            raise ExternalServiceException(msg)

        result = data.get("result")
        if not isinstance(result, dict):
            return []

        geometry = result.get("geometry") or {}
        location = geometry.get("location") or {}
        lat = location.get("lat")
        lng = location.get("lng")
        viewport = geometry.get("viewport") or {}
        address_components = result.get("address_components") or []
        address: dict[str, Any] = {}
        for component in address_components:
            if not isinstance(component, dict):
                continue
            types = component.get("types") or []
            name = component.get("long_name")
            if not name:
                continue
            if "locality" in types:
                address["city"] = name
            elif "administrative_area_level_2" in types:
                address["county"] = name
            elif "administrative_area_level_1" in types:
                address["state"] = name
            elif "country" in types:
                address["country"] = name
            elif "postal_code" in types:
                address["postcode"] = name
            elif "route" in types:
                address["road"] = name
            elif "street_number" in types:
                address["house_number"] = name

        return [
            {
                "display_name": result.get("formatted_address")
                or result.get("name")
                or "",
                "name": result.get("name") or "",
                "osm_id": result.get("place_id") or place_id,
                "osm_type": "google_place",
                "place_id": result.get("place_id") or place_id,
                "lat": lat,
                "lon": lng,
                "boundingbox": self._google_bbox_to_nominatim_bbox(viewport),
                "geojson": (
                    self._viewport_polygon(viewport)
                    if polygon_geojson
                    else None
                ),
                "address": address if addressdetails else {},
                "type": (result.get("types") or [None])[0],
                "class": "place",
                "source": "google",
            },
        ]


class GoogleRouter(Router):
    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    async def route(
        self,
        locations: list[tuple[float, float]] | list[list[float]],
        *,
        costing: str = "auto",
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        if len(locations) < 2:
            raise ExternalServiceException(
                "Google route requires at least two locations."
            )

        origin = locations[0]
        destination = locations[-1]
        waypoints = locations[1:-1]

        origin_str = f"{origin[1]},{origin[0]}"
        dest_str = f"{destination[1]},{destination[0]}"

        params: dict[str, Any] = {
            "origin": origin_str,
            "destination": dest_str,
            "key": self._api_key,
        }

        if waypoints:
            params["waypoints"] = "|".join([f"{wp[1]},{wp[0]}" for wp in waypoints])

        session = await get_session()
        data = await request_json(
            "GET",
            "https://maps.googleapis.com/maps/api/directions/json",
            session=session,
            params=params,
            service_name="Google directions",
            timeout_s=timeout_s,
        )

        if not isinstance(data, dict) or data.get("status") != "OK":
            msg = f"Google route error: {data.get('status') if isinstance(data, dict) else 'Unknown'}"
            raise ExternalServiceException(msg)

        routes = data.get("routes", [])
        if not routes:
            return {"distance_meters": 0, "duration_seconds": 0}

        route = routes[0]
        legs = route.get("legs", [])

        total_dist_meters = sum(
            [leg.get("distance", {}).get("value", 0) for leg in legs]
        )
        total_time_seconds = sum(
            [leg.get("duration", {}).get("value", 0) for leg in legs]
        )

        # Polyline decoding
        encoded_polyline = route.get("overview_polyline", {}).get("points", "")
        geometry = None
        if encoded_polyline:
            coords = _decode_polyline5(encoded_polyline)
            geometry = {"type": "LineString", "coordinates": coords}

        return {
            "geometry": geometry,
            "distance_meters": total_dist_meters,
            "duration_seconds": total_time_seconds,
            "raw": data,
        }

    async def trace_route(
        self,
        shape: list[dict[str, float | int | str]],
        *,
        costing: str = "auto",
        use_timestamps: bool | None = None,
    ) -> dict[str, Any]:
        # Batch points. Google Snap to Roads limits to 100 points per request.
        # We need to split the shape into chunks of 100 if > 100.
        coords = []
        for pt in shape:
            lat = pt.get("lat")
            lon = pt.get("lon")
            if lat is not None and lon is not None:
                coords.append((lat, lon))

        if not coords:
            return {}

        session = await get_session()
        chunk_size = 100
        all_snapped_coords = []

        # Important: maintain the continuity across chunks by overlapping 1 point
        for i in range(0, len(coords), chunk_size - 1):
            chunk = coords[i : i + chunk_size]
            path_str = "|".join([f"{lat},{lon}" for lat, lon in chunk])
            params = {"path": path_str, "interpolate": "true", "key": self._api_key}
            data = await request_json(
                "GET",
                "https://roads.googleapis.com/v1/snapToRoads",
                session=session,
                params=params,
                service_name="Google snapToRoads",
            )

            if not isinstance(data, dict):
                msg = "Google snapToRoads error: unexpected response"
                raise ExternalServiceException(msg)

            snapped = data.get("snappedPoints", [])
            for pt in snapped:
                loc = pt.get("location", {})
                all_snapped_coords.append([loc.get("lng"), loc.get("lat")])

        # Dedupe coords (because of overlap and interpolation)
        deduped = []
        for pt in all_snapped_coords:
            if not deduped or deduped[-1] != pt:
                deduped.append(pt)

        geometry = {"type": "LineString", "coordinates": deduped} if deduped else None
        return {"geometry": geometry, "raw": {"snappedPoints": all_snapped_coords}}

    async def status(self) -> dict[str, Any]:
        return {"status": "running", "engine": "google"}


class GoogleProvider(MappingProvider):
    """Mapping provider utilizing Google Maps Platform APIs."""

    def __init__(self, api_key: str) -> None:
        self._geocoder = GoogleGeocoder(api_key)
        self._router = GoogleRouter(api_key)

    @property
    def geocoder(self) -> Geocoder:
        return self._geocoder

    @property
    def router(self) -> Router:
        return self._router
