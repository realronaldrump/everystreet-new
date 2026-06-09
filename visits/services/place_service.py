"""Business logic for custom place management."""

import logging
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

from shapely.geometry import Point, mapping

from db.models import Place
from db.schemas import DestinationBloomPlaceResponse, PlaceResponse
from visits.services.destination_clusters import (
    build_destination_cluster_boundary,
    extract_destination_coords,
)
from visits.services.place_preview_service import (
    PlacePreviewService,
    generate_preview_best_effort,
)

logger = logging.getLogger(__name__)


def _destination_bloom_update_query(
    *,
    transaction_ids: list[str],
    geometry: dict[str, Any],
) -> dict[str, Any]:
    return {
        "$or": [
            {"transactionId": {"$in": transaction_ids}},
            {
                "destinationGeoPoint": {
                    "$geoWithin": {
                        "$geometry": geometry,
                    },
                },
            },
        ],
    }


class PlaceService:
    """Service class for custom place operations."""

    @staticmethod
    def _place_to_response(place: Place, preview=None) -> PlaceResponse:
        """Convert a Place model to a PlaceResponse."""
        preview_image_url = None
        preview_bounds = None
        place_id = str(place.id)
        geometry_hash = PlacePreviewService.geometry_hash(place.geometry)
        if preview is not None and geometry_hash == preview.geometry_hash:
            preview_image_url = PlacePreviewService.preview_image_url(
                place_id,
                preview.geometry_hash,
            )
            preview_bounds = preview.bounds

        return PlaceResponse(
            id=place_id,
            name=place.name or "",
            geometry=place.geometry,
            previewImageUrl=preview_image_url,
            previewBounds=preview_bounds,
            created_at=place.created_at,
        )

    @staticmethod
    async def get_places() -> list[PlaceResponse]:
        """
        Get all custom places.

        Returns:
            List of PlaceResponse objects
        """
        places = await Place.find_all().to_list()
        place_ids = [str(place.id) for place in places]
        previews = await PlacePreviewService.get_previews_for_places(place_ids)
        return [
            PlaceService._place_to_response(place, previews.get(str(place.id)))
            for place in places
        ]

    @staticmethod
    async def create_place(name: str, geometry: dict[str, Any]) -> PlaceResponse:
        """
        Create a new custom place.

        Args:
            name: The name of the place
            geometry: GeoJSON geometry object

        Returns:
            Created place as PlaceResponse
        """
        now = datetime.now(UTC)
        place = Place(
            name=name,
            geometry=geometry,
            created_at=now,
            updated_at=now,
        )
        await place.insert()
        await generate_preview_best_effort(place)
        preview = await PlacePreviewService.get_preview(str(place.id))
        return PlaceService._place_to_response(place, preview)

    @staticmethod
    async def create_place_from_destination_bloom(
        name: str,
        transaction_ids: list[str],
    ) -> DestinationBloomPlaceResponse:
        """
        Create a Visits place from a destination bloom cluster and backfill trips.

        Args:
            name: User-provided place name
            transaction_ids: Seed trip transaction IDs from the clicked cluster

        Returns:
            Created place and backfill counts

        Raises:
            ValueError: If input is invalid or no seed trips can be resolved
        """
        cleaned_name = str(name or "").strip()
        cleaned_ids = [
            str(transaction_id).strip()
            for transaction_id in transaction_ids or []
            if str(transaction_id or "").strip()
        ]
        deduped_ids = list(dict.fromkeys(cleaned_ids))

        if not cleaned_name:
            msg = "Place name is required"
            raise ValueError(msg)
        if not deduped_ids:
            msg = "At least one transactionId is required"
            raise ValueError(msg)

        from db.models import Trip

        seed_trips = await Trip.find(
            {"transactionId": {"$in": deduped_ids}},
        ).to_list()
        if not seed_trips:
            msg = "No persisted trips found for the supplied transactionIds"
            raise ValueError(msg)

        points: list[tuple[float, float]] = []
        for trip in seed_trips:
            coords = extract_destination_coords(trip.model_dump())
            if coords is not None:
                points.append(coords)

        if not points:
            msg = "Selected trips do not contain usable destination coordinates"
            raise ValueError(msg)

        boundary_geom = build_destination_cluster_boundary(
            points=points, cell_size_m=250
        )
        now = datetime.now(UTC)
        place = Place(
            name=cleaned_name,
            geometry=mapping(boundary_geom),
            created_at=now,
            updated_at=now,
        )
        await place.insert()

        trip_collection = Trip.get_pymongo_collection()
        update_query = _destination_bloom_update_query(
            transaction_ids=deduped_ids,
            geometry=place.geometry,
        )
        update_doc = {
            "$set": {
                "destinationPlaceId": str(place.id),
                "destinationPlaceName": cleaned_name,
            },
        }
        try:
            result = await trip_collection.update_many(update_query, update_doc)
        except NotImplementedError:
            logger.info(
                "Falling back to bounded destination-bloom matching because the active Mongo backend does not support $geoWithin."
            )
            result = await PlaceService._fallback_destination_bloom_update_many(
                cleaned_name=cleaned_name,
                deduped_ids=deduped_ids,
                place=place,
                boundary_geom=boundary_geom,
            )

        await generate_preview_best_effort(place)
        preview = await PlacePreviewService.get_preview(str(place.id))
        return DestinationBloomPlaceResponse(
            place=PlaceService._place_to_response(place, preview),
            linkedTrips=int(getattr(result, "modified_count", 0) or 0),
            seedTrips=len(seed_trips),
        )

    @staticmethod
    async def _fallback_destination_bloom_update_many(
        *,
        cleaned_name: str,
        deduped_ids: list[str],
        place: Place,
        boundary_geom,
    ):
        """
        Apply a bounded Python fallback when the Mongo backend lacks $geoWithin.

        This path is intended for test/mock backends such as mongomock,
        where correctness matters more than query efficiency because the
        production code path uses Mongo's geospatial operator directly.
        """
        from db.models import Trip

        bbox_candidates = await Trip.find(
            {
                "$or": [
                    {"transactionId": {"$in": deduped_ids}},
                    {
                        "destinationGeoPoint": {
                            "$exists": True,
                            "$ne": None,
                        },
                    },
                ],
            },
        ).to_list()

        matched_transaction_ids: list[str] = []
        seen_transaction_ids: set[str] = set()
        for candidate in bbox_candidates:
            transaction_id = str(getattr(candidate, "transactionId", "") or "").strip()
            if not transaction_id or transaction_id in seen_transaction_ids:
                continue

            if transaction_id in deduped_ids:
                matched_transaction_ids.append(transaction_id)
                seen_transaction_ids.add(transaction_id)
                continue

            destination_geo = getattr(candidate, "destinationGeoPoint", None)
            coords = (
                destination_geo.get("coordinates")
                if isinstance(destination_geo, dict)
                else None
            )
            if (
                isinstance(coords, list)
                and len(coords) >= 2
                and isinstance(coords[0], int | float)
                and isinstance(coords[1], int | float)
                and boundary_geom.covers(Point(float(coords[0]), float(coords[1])))
            ):
                matched_transaction_ids.append(transaction_id)
                seen_transaction_ids.add(transaction_id)

        await Trip.get_pymongo_collection().update_many(
            {"transactionId": {"$in": matched_transaction_ids}},
            {
                "$set": {
                    "destinationPlaceId": str(place.id),
                    "destinationPlaceName": cleaned_name,
                },
            },
        )
        return SimpleNamespace(modified_count=len(matched_transaction_ids))

    @staticmethod
    async def delete_place(place_id: str) -> dict[str, str]:
        """
        Delete a custom place.

        Args:
            place_id: The place ID to delete

        Returns:
            Success message

        Raises:
            ValueError: If place_id is invalid
        """
        place = await Place.get(place_id)
        if place:
            await place.delete()
            await PlacePreviewService.delete_preview(place_id)
        return {
            "status": "success",
            "message": "Place deleted",
        }

    @staticmethod
    async def update_place(
        place_id: str,
        name: str | None = None,
        geometry: dict[str, Any] | None = None,
    ) -> PlaceResponse:
        """
        Update a custom place (name and/or geometry).

        Args:
            place_id: The place ID to update
            name: Optional new name
            geometry: Optional new geometry

        Returns:
            Updated place as PlaceResponse

        Raises:
            ValueError: If place not found or invalid
        """
        place = await Place.get(place_id)
        if not place:
            msg = "Place not found"
            raise ValueError(msg)

        if name is not None:
            place.name = name
        if geometry is not None:
            place.geometry = geometry
        place.updated_at = datetime.now(UTC)

        await place.save()
        if geometry is not None:
            await generate_preview_best_effort(place)
        preview = await PlacePreviewService.get_preview(str(place.id))
        return PlaceService._place_to_response(place, preview)

    @staticmethod
    async def get_place_by_id(place_id: str) -> PlaceResponse | None:
        """
        Get a place by ID.

        Args:
            place_id: The place ID

        Returns:
            PlaceResponse or None if not found

        Raises:
            ValueError: If place_id is invalid
        """
        place = await Place.get(place_id)
        if not place:
            return None
        preview = await PlacePreviewService.get_preview(str(place.id))
        return PlaceService._place_to_response(place, preview)

    @staticmethod
    async def backfill_place_previews(force: bool = False) -> dict[str, int]:
        """Generate missing or stale place previews."""
        places = await Place.find_all().to_list()
        summary = {
            "processed": 0,
            "generated": 0,
            "skipped": 0,
            "failed": 0,
        }

        for place in places:
            summary["processed"] += 1
            try:
                result = await PlacePreviewService.generate_or_refresh_preview(
                    place,
                    force=force,
                )
            except Exception:
                logger.exception("Failed to backfill preview for place %s", place.id)
                summary["failed"] += 1
                continue

            summary[result.status] += 1

        return summary
