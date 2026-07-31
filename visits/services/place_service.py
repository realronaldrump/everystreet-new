"""Business logic for custom place management."""

import logging
from datetime import UTC, datetime
from typing import Any

from shapely.geometry import mapping

from db.models import Place, RecurringRoute, Trip
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
        preview_image_urls = {}
        preview_bounds = None
        place_id = str(place.id)
        geometry_hash = PlacePreviewService.geometry_hash(place.geometry)
        if preview is not None and geometry_hash == preview.geometry_hash:
            preview_image_urls = {
                theme: PlacePreviewService.preview_image_url(
                    place_id,
                    preview.geometry_hash,
                    theme,
                )
                for theme in PlacePreviewService.preview_themes()
                if PlacePreviewService.get_theme_image(preview, theme) is not None
            }
            preview_image_url = preview_image_urls.get(
                "dark"
            ) or preview_image_urls.get("light")
            preview_bounds = preview.bounds

        return PlaceResponse(
            id=place_id,
            name=place.name or "",
            geometry=place.geometry,
            previewImageUrl=preview_image_url,
            previewImageUrls=preview_image_urls,
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
        result = await trip_collection.update_many(update_query, update_doc)

        await generate_preview_best_effort(place)
        preview = await PlacePreviewService.get_preview(str(place.id))
        return DestinationBloomPlaceResponse(
            place=PlaceService._place_to_response(place, preview),
            linkedTrips=int(getattr(result, "modified_count", 0) or 0),
            seedTrips=len(seed_trips),
        )

    @staticmethod
    async def _clear_place_references(place_id: str) -> tuple[int, int]:
        """
        Drop references to a place that is going away.

        Trips carry the place id and its name; recurring routes carry it
        at either end, and the route signature is derived from those ids.
        Left behind, they point at a place that no longer exists.
        """
        trip_result = await Trip.get_pymongo_collection().update_many(
            {"destinationPlaceId": place_id},
            {"$set": {"destinationPlaceId": None, "destinationPlaceName": None}},
        )
        route_result = await RecurringRoute.get_pymongo_collection().update_many(
            {"$or": [{"start_place_id": place_id}, {"end_place_id": place_id}]},
            [
                {
                    "$set": {
                        "start_place_id": {
                            "$cond": [
                                {"$eq": ["$start_place_id", place_id]},
                                None,
                                "$start_place_id",
                            ],
                        },
                        "end_place_id": {
                            "$cond": [
                                {"$eq": ["$end_place_id", place_id]},
                                None,
                                "$end_place_id",
                            ],
                        },
                    },
                },
            ],
        )
        return (
            int(getattr(trip_result, "modified_count", 0) or 0),
            int(getattr(route_result, "modified_count", 0) or 0),
        )

    @staticmethod
    async def delete_place(place_id: str) -> dict[str, Any]:
        """
        Delete a custom place and everything that pointed at it.

        Args:
            place_id: The place ID to delete

        Returns:
            Success message with the number of cleared references

        Raises:
            ValueError: If place_id is invalid
        """
        place = await Place.get(place_id)
        if not place:
            return {
                "status": "success",
                "message": "Place deleted",
                "trips_updated": 0,
                "routes_updated": 0,
            }

        trips_updated, routes_updated = await PlaceService._clear_place_references(
            place_id,
        )
        await place.delete()
        await PlacePreviewService.delete_preview(place_id)

        route_refresh = None
        if routes_updated:
            # Route signatures include the place ids, so the affected
            # templates need rebuilding from the remaining trip data.
            from trips.services.inactive_trip_service import InactiveTripService

            try:
                route_refresh = await InactiveTripService.queue_recurring_routes_refresh()
            except Exception:
                logger.exception(
                    "Failed to queue recurring route rebuild after deleting place %s",
                    place_id,
                )

        return {
            "status": "success",
            "message": "Place deleted",
            "trips_updated": trips_updated,
            "routes_updated": routes_updated,
            "route_refresh": route_refresh,
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
