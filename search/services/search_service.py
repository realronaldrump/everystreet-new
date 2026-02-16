from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from shapely.geometry import LineString, MultiLineString, mapping, shape
from shapely.geometry.base import BaseGeometry

from core.clients.nominatim import GeocodingService
from core.http.nominatim import NominatimClient
from db.models import CoverageArea, CoverageState, Street

if TYPE_CHECKING:
    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)


class SearchService:
    """Search helpers for geocoding and street lookup."""

    _geo_service = GeocodingService()
    _nominatim_client = NominatimClient()

    @staticmethod
    def _to_line_geometry(
        geometry: BaseGeometry | None,
    ) -> LineString | MultiLineString | None:
        if geometry is None or geometry.is_empty:
            return None

        geom_type = geometry.geom_type
        if geom_type == "LineString":
            return geometry
        if geom_type == "MultiLineString":
            return geometry
        if geom_type != "GeometryCollection":
            return None

        line_parts: list[LineString] = []
        for part in geometry.geoms:
            normalized = SearchService._to_line_geometry(part)
            if normalized is None:
                continue
            if normalized.geom_type == "LineString":
                line_parts.append(normalized)
            elif normalized.geom_type == "MultiLineString":
                line_parts.extend(list(normalized.geoms))

        if not line_parts:
            return None
        if len(line_parts) == 1:
            return line_parts[0]
        return MultiLineString([list(line.coords) for line in line_parts])

    @staticmethod
    async def geocode_search(
        query: str,
        limit: int,
        proximity_lon: float | None = None,
        proximity_lat: float | None = None,
    ) -> dict[str, Any]:
        if not query or len(query.strip()) < 2:
            raise HTTPException(
                status_code=400,
                detail="Query must be at least 2 characters",
            )

        logger.debug("Geocoding search for: %s", query)

        proximity = None
        if proximity_lon is not None and proximity_lat is not None:
            proximity = (proximity_lon, proximity_lat)

        results = await SearchService._geo_service.forward_geocode(
            query,
            limit,
            proximity,
        )

        logger.info("Found %d results for query: %s", len(results), query)
        return {"results": results, "query": query}

    @staticmethod
    async def search_streets(
        query: str,
        location_id: PydanticObjectId | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        if not query or len(query.strip()) < 2:
            raise HTTPException(
                status_code=400,
                detail="Query must be at least 2 characters",
            )

        new_area = await CoverageArea.get(location_id) if location_id else None
        if not new_area:
            logger.warning("Coverage area not found: %s", location_id)
            return []

        location_name = new_area.display_name

        driven_segment_ids = set()
        async for state in CoverageState.find(
            CoverageState.area_id == location_id,
            CoverageState.status == "driven",
        ):
            driven_segment_ids.add(state.segment_id)

        street_groups: dict[str, dict[str, Any]] = {}
        async for street in Street.find(
            Street.area_id == location_id,
            Street.area_version == new_area.area_version,
            Street.street_name != None,  # noqa: E711
        ):
            name = street.street_name
            if not name or query.lower() not in name.lower():
                continue

            if name not in street_groups:
                street_groups[name] = {
                    "geometries": [],
                    "highway": street.highway_type,
                    "total_length": 0.0,
                    "segment_count": 0,
                    "driven_count": 0,
                }

            street_groups[name]["geometries"].append(street.geometry)
            street_groups[name]["total_length"] += street.length_miles * 5280
            street_groups[name]["segment_count"] += 1
            if street.segment_id in driven_segment_ids:
                street_groups[name]["driven_count"] += 1

        features = []
        for street_name, data in list(street_groups.items())[:limit]:
            coordinates = [
                geom.get("coordinates", [])
                for geom in data["geometries"]
                if geom.get("type") == "LineString"
            ]

            if coordinates:
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "MultiLineString",
                            "coordinates": coordinates,
                        },
                        "properties": {
                            "street_name": street_name,
                            "location": location_name,
                            "highway": data["highway"],
                            "segment_count": data["segment_count"],
                            "total_length": data["total_length"],
                            "driven_count": data["driven_count"],
                        },
                    },
                )

        logger.debug(
            "Found %d unique streets matching '%s' in %s",
            len(features),
            query,
            location_name,
        )
        return features

    @staticmethod
    async def resolve_street_geometry(
        osm_id: int | str,
        osm_type: str,
        location_id: PydanticObjectId | None = None,
        clip_to_area: bool = True,
    ) -> dict[str, Any]:
        clipped = False

        try:
            lookup_results = await SearchService._nominatim_client.lookup_raw(
                osm_id=osm_id,
                osm_type=osm_type,
                polygon_geojson=True,
                addressdetails=True,
            )
        except Exception:
            logger.warning(
                "Street geometry lookup failed for osm_id=%s osm_type=%s",
                osm_id,
                osm_type,
                exc_info=True,
            )
            return {"feature": None, "available": False, "clipped": False}

        if not lookup_results:
            return {"feature": None, "available": False, "clipped": False}

        raw_geometry = lookup_results[0].get("geojson")
        if not isinstance(raw_geometry, dict):
            return {"feature": None, "available": False, "clipped": False}

        try:
            line_geometry = SearchService._to_line_geometry(shape(raw_geometry))
        except Exception:
            logger.warning(
                "Invalid geometry payload from Nominatim for osm_id=%s osm_type=%s",
                osm_id,
                osm_type,
                exc_info=True,
            )
            return {"feature": None, "available": False, "clipped": False}

        if line_geometry is None:
            return {"feature": None, "available": False, "clipped": False}

        if location_id and clip_to_area:
            area = await CoverageArea.get(location_id)
            boundary = area.boundary if area else None
            if isinstance(boundary, dict) and boundary:
                boundary_geojson = (
                    boundary.get("geometry")
                    if str(boundary.get("type")).lower() == "feature"
                    else boundary
                )
                try:
                    if isinstance(boundary_geojson, dict):
                        clipped_geometry = line_geometry.intersection(shape(boundary_geojson))
                        line_geometry = SearchService._to_line_geometry(clipped_geometry)
                        clipped = True
                except Exception:
                    logger.warning(
                        "Failed to clip street geometry to area boundary for location_id=%s",
                        location_id,
                        exc_info=True,
                    )

        if line_geometry is None:
            return {"feature": None, "available": False, "clipped": clipped}

        try:
            osm_id_value = int(osm_id)
        except (TypeError, ValueError):
            osm_id_value = None

        feature = {
            "type": "Feature",
            "geometry": mapping(line_geometry),
            "properties": {
                "osm_id": osm_id_value,
                "osm_type": str(osm_type).lower(),
                "source": "nominatim_lookup",
            },
        }
        return {"feature": feature, "available": True, "clipped": clipped}


__all__ = ["SearchService"]
