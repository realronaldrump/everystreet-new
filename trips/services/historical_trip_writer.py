"""Historical trip persistence for Bouncie-owned ingest paths."""

from __future__ import annotations

from dataclasses import dataclass, field
from inspect import signature
from typing import Any

from db.models import Trip
from trips.pipeline import ProcessingHistoryEntry, TripPipeline, TripProcessingRequest


@dataclass(frozen=True)
class HistoricalTripWrite:
    """Everything needed to write one historical trip."""

    raw_data: dict[str, Any]
    do_map_match: bool
    do_geocode: bool
    do_coverage: bool
    force_map_match: bool = False
    prevalidated_data: dict[str, Any] | None = None
    prevalidated_history: list[ProcessingHistoryEntry] = field(default_factory=list)
    prevalidated_state: str | None = None
    sync_mobility: bool = True


class BouncieHistoricalTripWriter:
    """
    Persistence seam for the Mongo historical trips collection.

    Live webhook trips do not cross this seam. Historical writes are intentionally
    Bouncie-owned so the caller does not choose the persisted source.
    """

    def __init__(self, pipeline: TripPipeline | None = None) -> None:
        self._pipeline = pipeline or TripPipeline()

    async def write(self, request: HistoricalTripWrite) -> Trip | None:
        processing_request = TripProcessingRequest.bouncie_ingest(
            request.raw_data,
            do_map_match=request.do_map_match,
            do_geocode=request.do_geocode,
            do_coverage=request.do_coverage,
            force_map_match=request.force_map_match,
            prevalidated_data=request.prevalidated_data,
            prevalidated_history=request.prevalidated_history,
            prevalidated_state=request.prevalidated_state,
            sync_mobility=request.sync_mobility,
        )
        if hasattr(self._pipeline, "process_trip"):
            return await self._pipeline.process_trip(processing_request)
        kwargs = {
            "source": processing_request.source,
            "do_map_match": processing_request.do_map_match,
            "do_geocode": processing_request.do_geocode,
            "do_coverage": processing_request.do_coverage,
            "force_map_match": processing_request.force_map_match,
            "prevalidated_data": processing_request.prevalidated_data,
            "prevalidated_history": processing_request.prevalidated_history,
            "prevalidated_state": processing_request.prevalidated_state,
            "sync_mobility": processing_request.sync_mobility,
        }
        legacy_signature = signature(self._pipeline.process_raw_trip)
        accepted = {
            key: value
            for key, value in kwargs.items()
            if key in legacy_signature.parameters
        }
        return await self._pipeline.process_raw_trip(
            processing_request.raw_data,
            **accepted,
        )


__all__ = ["BouncieHistoricalTripWriter", "HistoricalTripWrite"]
