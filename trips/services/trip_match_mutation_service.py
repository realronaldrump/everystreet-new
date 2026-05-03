"""Shared mutation path for historical trip map matching state."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal

from analytics.services.mobility_insights_service import MobilityInsightsService
from core.date_utils import get_current_utc_time
from core.spatial import extract_timestamps_for_coordinates
from core.trip_map_cache import bump_trip_map_revision
from db.models import Trip
from trips.pipeline import TripPipeline
from trips.services.matching import MapMatchingService
from trips.services.trip_map_geometry import apply_trip_map_path_fields

logger = logging.getLogger(__name__)

MatchOutcome = Literal["matched", "skipped", "failed"]


@dataclass(frozen=True)
class TripMatchMutationResult:
    outcome: MatchOutcome
    status: str | None
    changed: bool
    message: str | None = None


@dataclass(frozen=True)
class _MatchInput:
    coords: list[list[float]]
    timestamps: list[int | None] | None


class HistoricalTripMatchMutationService:
    """Apply match/unmatch/rematch mutations to persisted historical trips."""

    def __init__(self, map_matching_service: MapMatchingService | None = None) -> None:
        self._map_matching_service = map_matching_service or MapMatchingService()

    async def clear_match(
        self,
        trip: Trip,
        *,
        bump_revision: bool = True,
        sync_mobility: bool = True,
    ) -> TripMatchMutationResult:
        trip.matchedGps = None
        trip.matchedMapPath = None
        trip.matchStatus = None
        trip.matched_at = None
        trip.mobility_synced_at = None
        await self._save_trip(
            trip,
            bump_revision=bump_revision,
            sync_mobility=sync_mobility,
            sync_context="unmatching",
        )
        return TripMatchMutationResult(
            outcome="skipped",
            status=None,
            changed=True,
        )

    async def rematch_trip(
        self,
        trip: Trip,
        *,
        bump_revision: bool = True,
        sync_mobility: bool = True,
    ) -> TripMatchMutationResult:
        match_input, skipped_status = self._build_match_input(trip)
        if skipped_status is not None or match_input is None:
            return await self.apply_match_status(
                trip,
                skipped_status or "skipped:no-gps",
                outcome="skipped",
                clear_geometry=True,
                bump_revision=bump_revision,
                sync_mobility=sync_mobility,
            )

        result = await self._map_matching_service.map_match_coordinates(
            match_input.coords,
            match_input.timestamps,
        )
        if result.get("code") != "Ok":
            message = str(result.get("message") or "Unknown error").strip()
            return await self.apply_match_status(
                trip,
                f"error:{message or 'Unknown error'}",
                outcome="failed",
                message=message or "Unknown error",
                clear_geometry=True,
                bump_revision=bump_revision,
                sync_mobility=sync_mobility,
            )

        matchings = result.get("matchings", [])
        if not matchings or not matchings[0].get("geometry"):
            return await self.apply_match_status(
                trip,
                "error:no-geometry",
                outcome="failed",
                message="Map matching returned no geometry",
                clear_geometry=True,
                bump_revision=bump_revision,
                sync_mobility=sync_mobility,
            )

        return await self.apply_matched_geometry(
            trip,
            matchings[0]["geometry"],
            bump_revision=bump_revision,
            sync_mobility=sync_mobility,
        )

    async def apply_match_status(
        self,
        trip: Trip,
        status: str,
        *,
        outcome: MatchOutcome,
        message: str | None = None,
        clear_geometry: bool = True,
        bump_revision: bool = True,
        sync_mobility: bool = False,
    ) -> TripMatchMutationResult:
        if clear_geometry:
            trip.matchedGps = None
            trip.matchedMapPath = None
            trip.mobility_synced_at = None
        trip.matchStatus = status
        trip.matched_at = get_current_utc_time()
        await self._save_trip(
            trip,
            bump_revision=bump_revision,
            sync_mobility=sync_mobility,
            sync_context="updating match status",
        )
        return TripMatchMutationResult(
            outcome=outcome,
            status=trip.matchStatus,
            changed=True,
            message=message,
        )

    async def apply_matched_geometry(
        self,
        trip: Trip,
        geometry: dict[str, Any],
        *,
        bump_revision: bool = True,
        sync_mobility: bool = True,
    ) -> TripMatchMutationResult:
        trip.matchedGps = geometry
        trip.matchStatus = f"matched:{str(geometry.get('type', 'unknown')).lower()}"
        trip.matched_at = get_current_utc_time()
        trip.mobility_synced_at = None
        TripPipeline.sanitize_trip_document_geospatial_fields(trip)
        if not getattr(trip, "matchedGps", None):
            trip.matchStatus = "error:sanitization-failed"
            trip.matchedMapPath = None
            await self._save_trip(
                trip,
                bump_revision=bump_revision,
                sync_mobility=sync_mobility,
                sync_context="saving sanitized match failure",
            )
            return TripMatchMutationResult(
                outcome="failed",
                status=trip.matchStatus,
                changed=True,
                message="Matched geometry failed sanitization",
            )

        await self._save_trip(
            trip,
            bump_revision=bump_revision,
            sync_mobility=sync_mobility,
            sync_context="map matching",
        )
        return TripMatchMutationResult(
            outcome="matched",
            status=trip.matchStatus,
            changed=True,
        )

    def _build_match_input(self, trip: Trip) -> tuple[_MatchInput | None, str | None]:
        gps_data = trip.gps
        if not gps_data or not isinstance(gps_data, dict):
            return None, "skipped:no-gps"

        gps_type = gps_data.get("type")
        coords = gps_data.get("coordinates", [])

        if gps_type == "Point":
            return None, "skipped:single-point"
        if gps_type != "LineString":
            return None, f"skipped:unsupported-gps-type:{gps_type}"
        if not isinstance(coords, list) or len(coords) < 2:
            return None, "skipped:insufficient-coordinates"

        timestamps = extract_timestamps_for_coordinates(coords, trip.model_dump())
        return _MatchInput(coords=coords, timestamps=timestamps), None

    async def _save_trip(
        self,
        trip: Trip,
        *,
        bump_revision: bool,
        sync_mobility: bool,
        sync_context: str,
    ) -> None:
        TripPipeline.sanitize_trip_document_geospatial_fields(trip)
        apply_trip_map_path_fields(trip)
        await trip.save()
        if bump_revision:
            await bump_trip_map_revision()
        if sync_mobility:
            await self._sync_mobility(trip, context=sync_context)

    @staticmethod
    async def _sync_mobility(trip: Trip, *, context: str) -> None:
        try:
            await MobilityInsightsService.sync_trip(trip)
        except Exception:
            logger.exception(
                "Failed to sync mobility profile after %s for trip %s",
                context,
                trip.transactionId,
            )


__all__ = [
    "HistoricalTripMatchMutationService",
    "TripMatchMutationResult",
]
