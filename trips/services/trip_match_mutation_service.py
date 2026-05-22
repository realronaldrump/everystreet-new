"""Shared mutation path for historical trip map matching state."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal

from analytics.services.mobility_insights_service import MobilityInsightsService
from core.date_utils import get_current_utc_time, parse_timestamp
from core.spatial import extract_timestamps_for_coordinates
from core.trip_map_cache import bump_trip_map_revision
from db.models import Trip
from trips.pipeline import TripPipeline
from trips.services.matching import MapMatchingService, normalize_provider_policy
from trips.services.trip_map_geometry import apply_trip_map_path_fields

logger = logging.getLogger(__name__)

MatchOutcome = Literal["matched", "skipped", "failed"]


@dataclass(frozen=True)
class TripMatchMutationResult:
    outcome: MatchOutcome
    status: str | None
    changed: bool
    message: str | None = None
    provider: str | None = None
    fallback_used: bool = False
    mapbox_requests: int = 0
    attempts: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class _MatchInput:
    coords: list[list[float]]
    timestamps: list[int | None] | None
    mapbox_timestamps: list[int | None] | None = None


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
        self._clear_match_metadata(trip)
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
        provider_policy: str | None = None,
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
            mapbox_timestamps=match_input.mapbox_timestamps,
            provider_policy=normalize_provider_policy(provider_policy),
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
                match_result=result,
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
                match_result=result,
            )

        matched_geometry = matchings[0]["geometry"]
        quality_error = MapMatchingService.validate_matched_geometry_quality(
            match_input.coords,
            matched_geometry,
        )
        if quality_error:
            return await self.apply_match_status(
                trip,
                f"error:{quality_error}",
                outcome="failed",
                message=quality_error,
                clear_geometry=True,
                bump_revision=bump_revision,
                sync_mobility=sync_mobility,
                match_result=result,
            )

        return await self.apply_matched_geometry(
            trip,
            matched_geometry,
            match_result=result,
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
        match_result: dict[str, Any] | None = None,
    ) -> TripMatchMutationResult:
        if clear_geometry:
            trip.matchedGps = None
            trip.matchedMapPath = None
            trip.mobility_synced_at = None
        self._apply_match_metadata(trip, match_result)
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
            provider=getattr(trip, "matchProvider", None),
            fallback_used=bool(getattr(trip, "matchFallbackUsed", False)),
            mapbox_requests=int((match_result or {}).get("mapbox_requests") or 0),
            attempts=getattr(trip, "matchAttemptSummary", None),
        )

    async def apply_matched_geometry(
        self,
        trip: Trip,
        geometry: dict[str, Any],
        *,
        match_result: dict[str, Any] | None = None,
        bump_revision: bool = True,
        sync_mobility: bool = True,
    ) -> TripMatchMutationResult:
        trip.matchedGps = geometry
        trip.matchStatus = f"matched:{str(geometry.get('type', 'unknown')).lower()}"
        trip.matched_at = get_current_utc_time()
        self._apply_match_metadata(trip, match_result)
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
                provider=getattr(trip, "matchProvider", None),
                fallback_used=bool(getattr(trip, "matchFallbackUsed", False)),
                mapbox_requests=int((match_result or {}).get("mapbox_requests") or 0),
                attempts=getattr(trip, "matchAttemptSummary", None),
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
            provider=getattr(trip, "matchProvider", None),
            fallback_used=bool(getattr(trip, "matchFallbackUsed", False)),
            mapbox_requests=int((match_result or {}).get("mapbox_requests") or 0),
            attempts=getattr(trip, "matchAttemptSummary", None),
        )

    @staticmethod
    def _clear_match_metadata(trip: Trip) -> None:
        trip.matchProvider = None
        trip.matchFallbackUsed = None
        trip.matchConfidence = None
        trip.matchAttemptSummary = None

    def _apply_match_metadata(
        self,
        trip: Trip,
        match_result: dict[str, Any] | None,
    ) -> None:
        if not match_result:
            self._clear_match_metadata(trip)
            return
        trip.matchProvider = match_result.get("provider")
        trip.matchFallbackUsed = bool(match_result.get("fallback_used"))
        confidence = match_result.get("confidence")
        trip.matchConfidence = (
            float(confidence) if isinstance(confidence, int | float) else None
        )
        attempts = match_result.get("attempts")
        trip.matchAttemptSummary = attempts if isinstance(attempts, list) else None

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

        trip_data = trip.model_dump()
        timestamps = extract_timestamps_for_coordinates(coords, trip_data)
        mapbox_timestamps = self._extract_unix_timestamps_for_coordinates(
            coords,
            trip_data,
        )
        return _MatchInput(
            coords=coords,
            timestamps=timestamps,
            mapbox_timestamps=mapbox_timestamps,
        ), None

    @staticmethod
    def _extract_unix_timestamps_for_coordinates(
        coordinates: list[list[float]],
        trip_data: dict[str, Any],
    ) -> list[int | None] | None:
        def normalize_timestamp(value: Any) -> int | None:
            if isinstance(value, str):
                parsed = parse_timestamp(value)
                return int(parsed.timestamp()) if parsed else None
            if hasattr(value, "timestamp"):
                return int(value.timestamp())
            if isinstance(value, int | float):
                current = int(value)
                if current > 10_000_000_000:
                    return current // 1000
                return current
            return None

        coordinate_records = trip_data.get("coordinates", [])
        if coordinate_records and len(coordinate_records) == len(coordinates):
            timestamps = [
                normalize_timestamp(record.get("timestamp"))
                if isinstance(record, dict)
                else None
                for record in coordinate_records
            ]
            if all(timestamp is not None for timestamp in timestamps):
                return timestamps

        start_ts = normalize_timestamp(trip_data.get("startTime"))
        end_ts = normalize_timestamp(trip_data.get("endTime"))
        if start_ts is None or end_ts is None or end_ts < start_ts:
            return None
        if len(coordinates) < 2:
            return None

        duration = end_ts - start_ts
        return [
            int(start_ts + (duration * (idx / (len(coordinates) - 1))))
            for idx in range(len(coordinates))
        ]

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
