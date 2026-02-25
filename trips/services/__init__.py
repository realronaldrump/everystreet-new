"""Trip services module."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from trips.services.trip_cost_service import TripCostService
    from trips.services.trip_query_service import TripQueryService
    from trips.services.trip_stats_service import TripStatsService
    from trips.services.trip_sync_service import TripSyncService

__all__ = ("TripCostService", "TripQueryService", "TripStatsService", "TripSyncService")


def __getattr__(name: str):
    if name == "TripCostService":
        from trips.services.trip_cost_service import TripCostService

        return TripCostService
    if name == "TripQueryService":
        from trips.services.trip_query_service import TripQueryService

        return TripQueryService
    if name == "TripStatsService":
        from trips.services.trip_stats_service import TripStatsService

        return TripStatsService
    if name == "TripSyncService":
        from trips.services.trip_sync_service import TripSyncService

        return TripSyncService
    msg = f"module {__name__!r} has no attribute {name!r}"
    raise AttributeError(msg)
