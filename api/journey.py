"""Journey Time Machine feed API."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Query

from core.api import api_route
from core.date_utils import parse_timestamp
from core.trip_source_policy import enforce_bouncie_source
from db.aggregation import aggregate_to_list
from db.models import CoverageArea, CoverageState, GasFillup, Job, Trip
from db.query import build_calendar_date_expr

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/journey", tags=["journey"])

JourneyEventType = Literal["trip", "visit", "fuel", "coverage", "map_matching"]

MAX_FEED_LIMIT = 2000
DEFAULT_FEED_LIMIT = 500


class JourneyFeedService:
    """Build normalized journey feed events across app data domains."""

    async def get_feed(
        self,
        *,
        start_date: str | None,
        end_date: str | None,
        vehicle: str | None,
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        bounded_limit = max(1, min(limit, MAX_FEED_LIMIT))
        cursor_dt = parse_timestamp(cursor) if cursor else None
        source_limit = min(MAX_FEED_LIMIT, max(600, bounded_limit * 2))

        sources = {
            "trip": self._fetch_trip_events,
            "visit": self._fetch_visit_events,
            "fuel": self._fetch_fuel_events,
            "coverage": self._fetch_coverage_events,
            "map_matching": self._fetch_map_matching_events,
        }

        async def run_source(
            source_name: str,
            loader,
        ) -> tuple[str, list[dict[str, Any]] | None, str | None]:
            try:
                events = await loader(
                    start_date=start_date,
                    end_date=end_date,
                    vehicle=vehicle,
                    cursor=cursor_dt,
                    limit=source_limit,
                )
            except Exception as exc:  # pragma: no cover
                logger.exception("Journey source fetch failed: %s", source_name)
                return source_name, None, str(exc)
            else:
                return source_name, events, None

        tasks = [
            run_source(source_name, loader)
            for source_name, loader in sources.items()
        ]

        results = await asyncio.gather(*tasks)

        events: list[dict[str, Any]] = []
        errors: dict[str, str] = {}
        source_counts: dict[str, int] = {}

        for source_name, source_events, error in results:
            if error:
                errors[source_name] = error
                source_counts[source_name] = 0
                continue
            source_events = source_events or []
            source_counts[source_name] = len(source_events)
            events.extend(source_events)

        events.sort(
            key=lambda item: (
                item.get("timestamp") or "",
                item.get("type") or "",
                item.get("id") or "",
            )
        )

        has_more = len(events) > bounded_limit
        paged_events = events[:bounded_limit]
        next_cursor = paged_events[-1]["timestamp"] if has_more and paged_events else None

        return {
            "events": paged_events,
            "meta": {
                "limit": bounded_limit,
                "returned": len(paged_events),
                "has_more": has_more,
                "next_cursor": next_cursor,
                "source_counts": source_counts,
            },
            "errors": errors,
        }

    async def _fetch_trip_events(
        self,
        *,
        start_date: str | None,
        end_date: str | None,
        vehicle: str | None,
        cursor: datetime | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        query = build_historical_trip_query(
            start_date=start_date,
            end_date=end_date,
            vehicle=vehicle,
            date_field="startTime",
        )
        if cursor:
            query["startTime"] = {"$gt": cursor}

        trips = (
            await Trip.find(query)
            .sort(+Trip.startTime)
            .limit(limit)
            .to_list()
        )

        events: list[dict[str, Any]] = []
        for trip in trips:
            trip_data = trip.model_dump() if hasattr(trip, "model_dump") else dict(trip)
            start_time = _to_utc_datetime(trip_data.get("startTime"))
            end_time = _to_utc_datetime(trip_data.get("endTime"))
            timestamp = end_time or start_time
            if not timestamp:
                continue
            transaction_id = _as_str(trip_data.get("transactionId")) or str(trip.id)
            start_label = _extract_location_label(
                trip_data.get("startLocation") or trip_data.get("start")
            )
            end_label = _extract_location_label(
                trip_data.get("destination") or trip_data.get("endLocation")
            )
            distance = _to_float(trip_data.get("distance"))
            duration_seconds = _duration_seconds(start_time, end_time)

            summary_bits = []
            if start_label and end_label:
                summary_bits.append(f"{start_label} to {end_label}")
            elif end_label:
                summary_bits.append(f"Arrived near {end_label}")
            if distance is not None:
                summary_bits.append(f"{distance:.1f} mi")
            if duration_seconds is not None:
                summary_bits.append(_format_duration(duration_seconds))

            events.append(
                _build_event(
                    event_id=f"trip:{transaction_id}",
                    event_type="trip",
                    timestamp=timestamp,
                    title=_build_trip_title(start_label, end_label),
                    summary=" · ".join(summary_bits) or "Trip event",
                    source_url=f"/trips?trip_id={quote(transaction_id)}",
                    geometry=_normalize_geojson(
                        trip_data.get("matchedGps") or trip_data.get("gps")
                    ),
                    metrics=_compact_metrics(
                        {
                            "distance_miles": distance,
                            "duration_seconds": duration_seconds,
                            "max_speed_mph": _to_float(trip_data.get("maxSpeed")),
                            "fuel_gallons": _to_float(trip_data.get("fuelConsumed")),
                        }
                    ),
                )
            )

        return events

    async def _fetch_visit_events(
        self,
        *,
        start_date: str | None,
        end_date: str | None,
        vehicle: str | None,
        cursor: datetime | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        query = build_historical_trip_query(
            start_date=start_date,
            end_date=end_date,
            vehicle=vehicle,
            date_field="endTime",
        )
        if cursor:
            query["endTime"] = {"$gt": cursor}

        trips = (
            await Trip.find(query)
            .sort(+Trip.endTime)
            .limit(limit)
            .to_list()
        )

        events: list[dict[str, Any]] = []
        for trip in trips:
            trip_data = trip.model_dump() if hasattr(trip, "model_dump") else dict(trip)
            timestamp = _to_utc_datetime(trip_data.get("endTime"))
            if not timestamp:
                continue
            place_id = _as_str(trip_data.get("destinationPlaceId"))
            place_name = _as_str(trip_data.get("destinationPlaceName")) or _extract_location_label(
                trip_data.get("destination")
            )
            if not place_name and not place_id:
                continue

            transaction_id = _as_str(trip_data.get("transactionId")) or str(trip.id)
            query_parts = []
            if place_id:
                query_parts.append(f"place={quote(place_id)}")
            if place_name:
                query_parts.append(f"place_name={quote(place_name)}")
            query_str = f"?{'&'.join(query_parts)}" if query_parts else ""

            summary = "Arrival event"
            if place_name:
                summary = f"Arrived at {place_name}"
            distance = _to_float(trip_data.get("distance"))
            if distance is not None:
                summary = f"{summary} · {distance:.1f} mi trip"

            events.append(
                _build_event(
                    event_id=f"visit:{transaction_id}",
                    event_type="visit",
                    timestamp=timestamp,
                    title=(
                        f"Visit · {place_name}"
                        if place_name
                        else "Visit"
                    ),
                    summary=summary,
                    source_url=f"/visits{query_str}",
                    geometry=_normalize_geojson(trip_data.get("destinationGeoPoint")),
                    metrics=_compact_metrics(
                        {
                            "trip_distance_miles": distance,
                            "place_id": place_id,
                        }
                    ),
                )
            )

        return events

    async def _fetch_fuel_events(
        self,
        *,
        start_date: str | None,
        end_date: str | None,
        vehicle: str | None,
        cursor: datetime | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        query: dict[str, Any] = {}

        date_expr = build_calendar_date_expr(
            start_date,
            end_date,
            date_field="fillup_time",
        )
        if date_expr:
            query["$expr"] = date_expr
        if vehicle:
            query["imei"] = vehicle
        if cursor:
            query["fillup_time"] = {"$gt": cursor}

        fillups = (
            await GasFillup.find(query)
            .sort(+GasFillup.fillup_time)
            .limit(limit)
            .to_list()
        )

        events: list[dict[str, Any]] = []
        for fillup in fillups:
            fillup_data = (
                fillup.model_dump() if hasattr(fillup, "model_dump") else dict(fillup)
            )
            timestamp = _to_utc_datetime(fillup_data.get("fillup_time"))
            if not timestamp:
                continue
            fillup_id = str(fillup.id)
            gallons = _to_float(fillup_data.get("gallons"))
            total_cost = _to_float(fillup_data.get("total_cost"))
            mpg = _to_float(fillup_data.get("calculated_mpg"))

            summary_parts = []
            if gallons is not None:
                summary_parts.append(f"{gallons:.2f} gal")
            if total_cost is not None:
                summary_parts.append(f"${total_cost:.2f}")
            if mpg is not None:
                summary_parts.append(f"{mpg:.1f} mpg")

            geometry = None
            lat = _to_float(fillup_data.get("latitude"))
            lon = _to_float(fillup_data.get("longitude"))
            if lat is not None and lon is not None:
                geometry = {
                    "type": "Point",
                    "coordinates": [lon, lat],
                }

            events.append(
                _build_event(
                    event_id=f"fuel:{fillup_id}",
                    event_type="fuel",
                    timestamp=timestamp,
                    title="Fuel Fill-up",
                    summary=" · ".join(summary_parts) or "Fuel event",
                    source_url="/gas-tracking",
                    geometry=geometry,
                    metrics=_compact_metrics(
                        {
                            "gallons": gallons,
                            "total_cost": total_cost,
                            "price_per_gallon": _to_float(
                                fillup_data.get("price_per_gallon")
                            ),
                            "calculated_mpg": mpg,
                            "odometer": _to_float(fillup_data.get("odometer")),
                        }
                    ),
                )
            )

        return events

    async def _fetch_coverage_events(
        self,
        *,
        start_date: str | None,
        end_date: str | None,
        vehicle: str | None,
        cursor: datetime | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        _ = vehicle  # Coverage milestones are area-level, not vehicle-specific.

        match_clause: dict[str, Any] = {
            "status": "driven",
            "first_driven_at": {"$ne": None},
        }

        date_expr = build_calendar_date_expr(
            start_date,
            end_date,
            date_field="first_driven_at",
        )
        if date_expr:
            match_clause["$expr"] = date_expr
        if cursor:
            match_clause["first_driven_at"]["$gt"] = cursor

        pipeline = [
            {"$match": match_clause},
            {
                "$group": {
                    "_id": {
                        "area_id": "$area_id",
                        "day": {
                            "$dateToString": {
                                "format": "%Y-%m-%d",
                                "date": "$first_driven_at",
                                "timezone": "UTC",
                            }
                        },
                    },
                    "timestamp": {"$min": "$first_driven_at"},
                    "segments_driven": {"$sum": 1},
                }
            },
            {"$sort": {"timestamp": 1}},
            {"$limit": limit},
        ]

        docs = await aggregate_to_list(CoverageState, pipeline)

        area_ids = [doc.get("_id", {}).get("area_id") for doc in docs]
        area_ids = [area_id for area_id in area_ids if area_id is not None]
        area_map: dict[str, str] = {}
        if area_ids:
            areas = await CoverageArea.find({"_id": {"$in": area_ids}}).to_list()
            area_map = {
                str(area.id): area.display_name
                for area in areas
                if area and area.display_name
            }

        events: list[dict[str, Any]] = []
        for doc in docs:
            group_key = doc.get("_id", {})
            area_id = group_key.get("area_id")
            if area_id is None:
                continue
            timestamp = _to_utc_datetime(doc.get("timestamp"))
            if not timestamp:
                continue
            if cursor and timestamp <= cursor:
                continue

            area_id_str = str(area_id)
            day_key = _as_str(group_key.get("day")) or timestamp.date().isoformat()
            area_name = area_map.get(area_id_str, "Coverage Area")
            segments_driven = int(doc.get("segments_driven") or 0)
            segment_word = "segment" if segments_driven == 1 else "segments"

            events.append(
                _build_event(
                    event_id=f"coverage:{area_id_str}:{day_key}",
                    event_type="coverage",
                    timestamp=timestamp,
                    title=f"Coverage Milestone · {area_name}",
                    summary=f"{segments_driven} {segment_word} newly marked driven",
                    source_url=f"/coverage-management?area_id={quote(area_id_str)}",
                    metrics={
                        "segments_driven": segments_driven,
                        "area_id": area_id_str,
                        "area_name": area_name,
                    },
                )
            )

        return events

    async def _fetch_map_matching_events(
        self,
        *,
        start_date: str | None,
        end_date: str | None,
        vehicle: str | None,
        cursor: datetime | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        query: dict[str, Any] = {
            "job_type": "map_matching",
        }

        date_expr = build_calendar_date_expr(
            start_date,
            end_date,
            date_field="created_at",
        )
        if date_expr:
            query["$expr"] = date_expr
        if cursor:
            query["created_at"] = {"$gt": cursor}

        jobs = (
            await Job.find(query)
            .sort(+Job.created_at)
            .limit(limit)
            .to_list()
        )

        events: list[dict[str, Any]] = []
        for job in jobs:
            if vehicle:
                metadata = job.metadata or {}
                job_vehicle = _as_str(metadata.get("imei"))
                if job_vehicle and job_vehicle != vehicle:
                    continue

            timestamp = _to_utc_datetime(job.created_at)
            if not timestamp:
                continue

            stage = _as_str(job.stage) or _as_str(job.status) or "queued"
            status = _as_str(job.status) or "pending"
            job_id = (
                _as_str(job.operation_id)
                or _as_str(job.task_id)
                or str(job.id)
            )
            metadata = job.metadata or {}
            processed = metadata.get("processed") or metadata.get("processed_count")
            total = metadata.get("total") or metadata.get("trip_ids_count")

            summary_parts = [
                _as_str(job.message) or f"Map matching is {stage}",
            ]
            if processed is not None and total is not None:
                summary_parts.append(f"{processed}/{total} trips")

            events.append(
                _build_event(
                    event_id=f"map_matching:{job_id}",
                    event_type="map_matching",
                    timestamp=timestamp,
                    title=f"Map Matching · {stage.title()}",
                    summary=" · ".join(
                        part for part in summary_parts if part
                    ),
                    source_url=f"/map-matching?job={quote(job_id)}",
                    metrics=_compact_metrics(
                        {
                            "status": status,
                            "stage": stage,
                            "progress": _to_float(job.progress),
                            "processed": _to_int(processed),
                            "total": _to_int(total),
                        }
                    ),
                )
            )

        return events


service = JourneyFeedService()


@router.get("/feed")
@api_route(logger)
async def get_journey_feed(
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    vehicle: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=DEFAULT_FEED_LIMIT, ge=1, le=MAX_FEED_LIMIT),
) -> dict[str, Any]:
    """Return normalized, timestamp-ordered events for Journey Time Machine."""
    return await service.get_feed(
        start_date=start_date,
        end_date=end_date,
        vehicle=vehicle,
        cursor=cursor,
        limit=limit,
    )


def build_historical_trip_query(
    *,
    start_date: str | None,
    end_date: str | None,
    vehicle: str | None,
    date_field: str,
) -> dict[str, Any]:
    """Build historical trip query constrained to Bouncie source."""
    query: dict[str, Any] = {}
    date_expr = build_calendar_date_expr(start_date, end_date, date_field=date_field)
    if date_expr:
        query["$expr"] = date_expr
    if vehicle:
        query["imei"] = vehicle
    query["invalid"] = {"$ne": True}
    return enforce_bouncie_source(query)


def _build_event(
    *,
    event_id: str,
    event_type: JourneyEventType,
    timestamp: datetime,
    title: str,
    summary: str,
    source_url: str,
    geometry: dict[str, Any] | None = None,
    metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "id": event_id,
        "type": event_type,
        "timestamp": _iso_utc(timestamp),
        "title": title,
        "summary": summary,
        "source_url": source_url,
    }
    if geometry:
        event["geometry"] = geometry
    if metrics:
        event["metrics"] = metrics
    return event


def _iso_utc(value: datetime) -> str:
    normalized = value.astimezone(UTC)
    return normalized.isoformat().replace("+00:00", "Z")


def _to_utc_datetime(value: Any) -> datetime | None:
    parsed = parse_timestamp(value)
    if parsed is None:
        return None
    return parsed.astimezone(UTC)


def _normalize_geojson(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    geometry_type = _as_str(value.get("type"))
    coords = value.get("coordinates")
    if geometry_type not in {"Point", "LineString", "MultiLineString"}:
        return None
    if coords is None:
        return None
    return {
        "type": geometry_type,
        "coordinates": coords,
    }


def _extract_location_label(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None

    if isinstance(value, dict):
        for key in (
            "display_name",
            "name",
            "address",
            "formatted_address",
            "label",
            "city",
        ):
            text = _as_str(value.get(key))
            if text:
                return text
    return None


def _build_trip_title(start_label: str | None, end_label: str | None) -> str:
    if start_label and end_label:
        return f"Trip · {start_label} to {end_label}"
    if end_label:
        return f"Trip · To {end_label}"
    if start_label:
        return f"Trip · From {start_label}"
    return "Trip"


def _duration_seconds(start: datetime | None, end: datetime | None) -> float | None:
    if not start or not end:
        return None
    delta = (end - start).total_seconds()
    if delta < 0:
        return None
    return delta


def _format_duration(value: float) -> str:
    seconds = max(0, int(value))
    hours, remainder = divmod(seconds, 3600)
    minutes, sec = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}h {minutes:02d}m"
    if minutes > 0:
        return f"{minutes}m {sec:02d}s"
    return f"{sec}s"


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _compact_metrics(metrics: dict[str, Any]) -> dict[str, Any] | None:
    compact = {k: v for k, v in metrics.items() if v is not None}
    return compact or None
