from __future__ import annotations

import logging
from typing import Any

from beanie import PydanticObjectId
from fastapi import HTTPException

from geo_service import GeocodingService
from street_coverage.models import CoverageArea, CoverageState, Street

logger = logging.getLogger(__name__)


class SearchService:
    """Search helpers for geocoding and street lookup."""

    _geo_service = GeocodingService()

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


__all__ = ["SearchService"]
