from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from shapely.geometry import mapping, shape

from core.coverage_clip import (
    CoverageClipError,
    clip_line_geometry,
    resolve_coverage_clip_context,
)
from core.mapping.factory import get_geocoder
from core.spatial import extract_line_geometry
from db.models import CoverageArea, CoverageState, Street

if TYPE_CHECKING:
    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)


class _NominatimLookupClient:
    async def lookup_raw(self, **kwargs: Any) -> list[dict[str, Any]]:
        geocoder = await get_geocoder()
        return await geocoder.lookup_raw(**kwargs)


class SearchService:
    """Search helpers for geocoding and street lookup."""

    _nominatim_client = _NominatimLookupClient()

    @staticmethod
    def _normalize_query_text(value: str | None) -> str:
        if not value:
            return ""
        return " ".join(str(value).strip().lower().split())

    @staticmethod
    def _geocode_result_key(result: dict[str, Any]) -> str:
        osm_id = result.get("osm_id")
        osm_type = str(result.get("osm_type") or "").strip().lower()
        if osm_id is not None and osm_type:
            return f"osm:{osm_type}:{osm_id}"

        center = result.get("center")
        if isinstance(center, list) and len(center) == 2:
            try:
                lon = round(float(center[0]), 5)
                lat = round(float(center[1]), 5)
            except (TypeError, ValueError):
                pass
            else:
                name = SearchService._normalize_query_text(
                    str(result.get("text") or result.get("place_name") or ""),
                )
                return f"coord:{lon}:{lat}:{name}"

        fallback = SearchService._normalize_query_text(
            str(result.get("display_name") or result.get("place_name") or ""),
        )
        return f"raw:{fallback}"

    @staticmethod
    def _score_geocode_result(query: str, result: dict[str, Any]) -> float:
        query_text = SearchService._normalize_query_text(query)
        name = SearchService._normalize_query_text(
            str(result.get("text") or result.get("place_name") or ""),
        )
        subtitle = SearchService._normalize_query_text(
            str(result.get("place_name") or ""),
        )

        score = 0.0
        if name and query_text:
            if name == query_text:
                score += 120.0
            elif name.startswith(query_text):
                score += 90.0
            elif query_text in name:
                score += 70.0

        if query_text and subtitle and query_text in subtitle:
            score += 35.0

        raw_importance = result.get("importance", 0.0)
        try:
            importance = max(0.0, min(float(raw_importance), 1.0))
        except (TypeError, ValueError):
            importance = 0.0
        score += importance * 20.0

        feature_class = str(result.get("class") or "").strip().lower()
        if feature_class in {"amenity", "shop", "tourism", "office", "leisure"}:
            score += 10.0

        return score

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

        query_text = query.strip()
        logger.debug("Geocoding search for: %s", query_text)

        proximity = None
        if proximity_lon is not None and proximity_lat is not None:
            proximity = (proximity_lon, proximity_lat)

        primary_limit = max(limit, 10)
        geocoder = await get_geocoder()
        primary_results = await geocoder.search(
            query_text,
            limit=primary_limit,
            proximity=proximity,
            strict_bounds=False,
        )

        merged: dict[str, dict[str, Any]] = {}
        for result in primary_results:
            key = SearchService._geocode_result_key(result)
            merged[key] = result

        if proximity and len(merged) < limit:
            fallback_results = await geocoder.search(
                query_text,
                limit=primary_limit,
                proximity=None,
                strict_bounds=False,
            )
            for result in fallback_results:
                key = SearchService._geocode_result_key(result)
                if key not in merged:
                    merged[key] = result

        ranked_results = sorted(
            merged.values(),
            key=lambda result: SearchService._score_geocode_result(query_text, result),
            reverse=True,
        )
        results = ranked_results[:limit]

        logger.info("Found %d geocode results for query: %s", len(results), query_text)
        return {"results": results, "query": query_text}

    @staticmethod
    async def search_streets(
        query: str,
        coverage_area_id: PydanticObjectId | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        if not query or len(query.strip()) < 2:
            raise HTTPException(
                status_code=400,
                detail="Query must be at least 2 characters",
            )

        if coverage_area_id is None:
            return []

        new_area = await CoverageArea.get(coverage_area_id)
        if new_area is None:
            logger.warning("Coverage area not found: %s", coverage_area_id)
            return []

        location_name = new_area.display_name

        driven_segment_ids = set()
        async for state in CoverageState.find(
            CoverageState.area_id == coverage_area_id,
            CoverageState.status == "driven",
        ):
            driven_segment_ids.add(state.segment_id)

        street_groups: dict[str, dict[str, Any]] = {}
        async for street in Street.find(
            Street.area_id == coverage_area_id,
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
        coverage_area_id: PydanticObjectId | None = None,
        clip_to_coverage: bool = False,
    ) -> dict[str, Any]:
        clipped = False

        try:
            lookup_results = await SearchService._nominatim_client.lookup_raw(
                osm_id=osm_id,
                osm_type=osm_type,
                polygon_geojson=True,
                addressdetails=True,
            )
        except NotImplementedError:
            return {"feature": None, "available": False, "clipped": False}
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
            line_geometry = extract_line_geometry(shape(raw_geometry))
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

        if clip_to_coverage:
            if coverage_area_id is None:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "coverage_area_id is required when clip_to_coverage is true."
                    ),
                )

            area = await CoverageArea.get(coverage_area_id)
            if area is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Coverage area not found: {coverage_area_id}",
                )

            try:
                clip_context = resolve_coverage_clip_context(
                    clip_requested=True,
                    area=area,
                    area_id=str(coverage_area_id),
                )
            except CoverageClipError as exc:
                raise HTTPException(
                    status_code=422,
                    detail=str(exc),
                ) from exc

            line_geometry = clip_line_geometry(line_geometry, clip_context)
            clipped = True

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
