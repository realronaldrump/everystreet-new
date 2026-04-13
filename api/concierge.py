"""Concierge summary APIs for the primary Every Street experience."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter

from core.serialization import serialize_datetime
from core.trip_source_policy import enforce_bouncie_source
from db.models import BouncieCredentials, CoverageArea, GasFillup, Job, Trip, Vehicle
from map_data.models import MapServiceConfig
from trips.services.trip_sync_service import TripSyncService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["concierge"])


def _now() -> datetime:
    return datetime.now(UTC)


def _coerce_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    return None


def _age_label(value: datetime | str | None) -> str:
    dt = _coerce_datetime(value)
    if not dt:
        return "Not available yet"

    seconds = max(0, int((_now() - dt).total_seconds()))
    if seconds < 60:
        return "Just now"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min ago"
    hours = minutes // 60
    if hours < 48:
        return f"{hours} hr ago"
    days = hours // 24
    return f"{days} days ago"


def _vehicle_name(vehicle: Vehicle | None) -> str:
    if not vehicle:
        return "No vehicle connected"
    parts = [vehicle.year, vehicle.make, vehicle.model]
    stock_name = " ".join(str(part) for part in parts if part)
    return vehicle.custom_name or stock_name or vehicle.imei


def _coverage_status_label(area: CoverageArea | None) -> str:
    if not area:
        return "No territories yet"
    if area.status in {"initializing", "rebuilding"}:
        return "Atlas is refreshing"
    if area.status == "error":
        return "Needs attention"
    return "Up to date"


async def _safe_count(model: Any, *criteria: Any) -> int:
    try:
        query = model.find(*criteria) if criteria else model.find_all()
        return await query.count()
    except Exception:
        logger.exception("Failed to count %s", getattr(model, "__name__", model))
        return 0


async def _safe_to_list(model: Any, *criteria: Any, limit: int = 100) -> list[Any]:
    try:
        query = model.find(*criteria) if criteria else model.find_all()
        return await query.limit(limit).to_list()
    except Exception:
        logger.exception("Failed to list %s", getattr(model, "__name__", model))
        return []


async def _get_trip_sync_status() -> dict[str, Any]:
    try:
        return await TripSyncService.get_sync_status()
    except Exception:
        logger.exception("Failed to load trip sync status")
        return {
            "state": "unknown",
            "last_success_at": None,
            "error": {
                "code": "sync_status_unavailable",
                "message": "Trip sync status is temporarily unavailable.",
                "cta_label": "Open diagnostics",
                "cta_href": "/control-center#diagnostics",
            },
        }


async def _get_map_status() -> dict[str, Any]:
    try:
        config = await MapServiceConfig.find_one({"_id": "map_service_config"})
        if not config:
            return {
                "state": "not_configured",
                "label": "Preparing",
                "message": "Map services will finish in the background.",
                "geocoding_ready": False,
                "routing_ready": False,
                "last_updated": None,
                "last_error": None,
            }
        return {
            "state": "ready" if config.is_ready else config.status,
            "label": "Ready" if config.is_ready else "Preparing",
            "message": config.message
            or (
                "Map services are ready."
                if config.is_ready
                else "Map services will finish in the background."
            ),
            "geocoding_ready": bool(config.geocoding_ready),
            "routing_ready": bool(config.routing_ready),
            "last_updated": serialize_datetime(config.last_updated),
            "last_error": config.last_error,
        }
    except Exception:
        logger.exception("Failed to load map service config")
        return {
            "state": "unknown",
            "label": "Unknown",
            "message": "Map readiness is temporarily unavailable.",
            "geocoding_ready": False,
            "routing_ready": False,
            "last_updated": None,
            "last_error": None,
        }


async def _get_credentials_status() -> dict[str, Any]:
    try:
        credentials = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )
    except Exception:
        logger.exception("Failed to load Bouncie credential state")
        credentials = None

    if not credentials:
        return {
            "state": "missing",
            "label": "Needs authorization",
            "authorized_devices": 0,
            "last_webhook_at": None,
            "message": "Connect Bouncie once and the app can keep itself current.",
        }

    has_config = bool(
        credentials.client_id
        and credentials.client_secret
        and credentials.redirect_uri,
    )
    has_auth = bool(credentials.authorization_code or credentials.access_token)
    devices = credentials.authorized_devices or []
    state = "connected" if has_config and has_auth and devices else "needs_attention"
    return {
        "state": state,
        "label": "Connected" if state == "connected" else "Needs attention",
        "authorized_devices": len(devices),
        "last_webhook_at": serialize_datetime(credentials.last_webhook_at),
        "message": (
            "Bouncie is connected and ready for automatic trip updates."
            if state == "connected"
            else "Bouncie needs authorization or at least one authorized vehicle."
        ),
    }


async def _active_coverage_jobs() -> list[Job]:
    try:
        return (
            await Job.find(
                {
                    "job_type": {
                        "$in": ["area_ingestion", "area_rebuild", "area_backfill"]
                    },
                    "status": {"$in": ["pending", "running"]},
                },
            )
            .sort("-created_at")
            .limit(10)
            .to_list()
        )
    except Exception:
        logger.exception("Failed to load active coverage jobs")
        return []


async def _coverage_summary() -> dict[str, Any]:
    try:
        areas = await CoverageArea.find_all().to_list()
    except Exception:
        logger.exception("Failed to load coverage areas")
        areas = []

    ready_areas = [area for area in areas if area.status == "ready"]
    selected = max(
        ready_areas or areas,
        key=lambda area: (
            float(area.coverage_percentage or 0),
            _coerce_datetime(area.last_synced) or area.created_at,
        ),
        default=None,
    )
    jobs = await _active_coverage_jobs()
    remaining_miles = max(
        0.0,
        sum(
            float(area.driveable_length_miles or area.total_length_miles or 0)
            for area in areas
        )
        - sum(float(area.driven_length_miles or 0) for area in areas),
    )

    return {
        "state": "refreshing" if jobs else ("ready" if ready_areas else "empty"),
        "label": _coverage_status_label(selected),
        "territory_count": len(areas),
        "ready_territory_count": len(ready_areas),
        "selected_territory": _serialize_territory(selected) if selected else None,
        "active_jobs": [_serialize_job(job) for job in jobs],
        "remaining_miles": round(remaining_miles, 1),
        "last_refreshed_at": serialize_datetime(selected.last_synced)
        if selected
        else None,
    }


def _serialize_territory(area: CoverageArea | None) -> dict[str, Any] | None:
    if not area:
        return None
    return {
        "id": str(area.id),
        "name": area.display_name,
        "type": area.area_type,
        "status": area.status,
        "health": area.health,
        "coverage_percent": round(float(area.coverage_percentage or 0), 1),
        "driven_miles": round(float(area.driven_length_miles or 0), 1),
        "remaining_miles": round(
            max(
                0.0,
                float(area.driveable_length_miles or area.total_length_miles or 0)
                - float(area.driven_length_miles or 0),
            ),
            1,
        ),
        "total_segments": int(area.total_segments or 0),
        "driven_segments": int(area.driven_segments or 0),
        "last_refreshed_at": serialize_datetime(area.last_synced),
    }


def _serialize_job(job: Job) -> dict[str, Any]:
    return {
        "id": str(job.id),
        "type": job.job_type,
        "status": job.status,
        "stage": job.stage,
        "progress": round(float(job.progress or 0), 1),
        "message": job.message,
        "area_id": str(job.area_id) if job.area_id else None,
        "updated_at": serialize_datetime(job.updated_at or job.created_at),
    }


@router.get("/concierge/status", response_model=dict[str, Any])
async def get_concierge_status() -> dict[str, Any]:
    """Return the primary self-driving status summary for the app."""
    sync_status = await _get_trip_sync_status()
    map_status = await _get_map_status()
    credentials = await _get_credentials_status()
    coverage = await _coverage_summary()
    active_vehicles = await _safe_to_list(
        Vehicle,
        Vehicle.is_active == True,  # noqa: E712
        limit=25,
    )
    latest_trip = None
    try:
        latest_trip = (
            await Trip.find(enforce_bouncie_source({"invalid": {"$ne": True}}))
            .sort("-endTime")
            .first_or_none()
        )
    except Exception:
        logger.exception("Failed to load latest trip")

    action_items: list[dict[str, Any]] = []
    sync_error = sync_status.get("error") if isinstance(sync_status, dict) else None
    if sync_error:
        action_items.append(
            {
                "severity": "warning",
                "code": sync_error.get("code") or "sync_attention",
                "title": "Trip sync needs attention",
                "message": sync_error.get("message") or "Trip sync is not current.",
                "cta_label": sync_error.get("cta_label") or "Review",
                "cta_href": sync_error.get("cta_href") or "/control-center#diagnostics",
            },
        )
    if not active_vehicles:
        action_items.append(
            {
                "severity": "warning",
                "code": "garage_empty",
                "title": "Garage is empty",
                "message": "Connect or sync a vehicle so Every Street can drive itself.",
                "cta_label": "Open Garage",
                "cta_href": "/vehicles",
            },
        )
    if coverage["territory_count"] == 0:
        action_items.append(
            {
                "severity": "info",
                "code": "atlas_empty",
                "title": "Choose your first territory",
                "message": "Add a city or county once, then coverage keeps itself refreshed.",
                "cta_label": "Open Atlas",
                "cta_href": "/coverage-management",
            },
        )
    if map_status.get("state") == "error":
        action_items.append(
            {
                "severity": "warning",
                "code": "map_services",
                "title": "Map services need attention",
                "message": map_status.get("last_error") or map_status.get("message"),
                "cta_label": "Open diagnostics",
                "cta_href": "/control-center#diagnostics",
            },
        )

    overall_state = "ready"
    if action_items:
        overall_state = "attention"
    if sync_status.get("state") == "syncing" or coverage.get("state") == "refreshing":
        overall_state = "working"

    primary_vehicle = active_vehicles[0] if active_vehicles else None
    return {
        "overall": {
            "state": overall_state,
            "label": {
                "ready": "Everything is handled",
                "working": "Concierge is working",
                "attention": "Review needed",
            }.get(overall_state, "Status unknown"),
            "message": (
                "Trips, coverage, and map services are being maintained quietly."
                if overall_state == "ready"
                else "A few background systems are still settling."
            ),
            "generated_at": serialize_datetime(_now()),
        },
        "vehicle": {
            "state": "connected" if primary_vehicle else "empty",
            "label": _vehicle_name(primary_vehicle),
            "count": len(active_vehicles),
            "last_seen_at": serialize_datetime(latest_trip.endTime)
            if latest_trip
            else None,
            "last_seen_label": _age_label(latest_trip.endTime if latest_trip else None),
        },
        "sync": {
            "state": sync_status.get("state", "unknown"),
            "last_success_at": sync_status.get("last_success_at"),
            "last_success_label": _age_label(sync_status.get("last_success_at")),
            "auto_sync_enabled": bool(sync_status.get("auto_sync_enabled")),
            "trip_count": sync_status.get("trip_count", 0),
        },
        "coverage": coverage,
        "maps": map_status,
        "credentials": credentials,
        "action_items": action_items,
    }


@router.get("/journey/feed", response_model=dict[str, Any])
async def get_journey_feed() -> dict[str, Any]:
    """Return a curated recent journey feed for the Trips page."""
    query = enforce_bouncie_source({"invalid": {"$ne": True}})
    try:
        recent_trips = await Trip.find(query).sort("-endTime").limit(8).to_list()
        total_trips = await Trip.find(query).count()
        inactive_count = await Trip.find(
            enforce_bouncie_source({"inactive": True})
        ).count()
    except Exception:
        logger.exception("Failed to load journey feed")
        recent_trips = []
        total_trips = 0
        inactive_count = 0

    month_start = _now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_miles = sum(
        float(getattr(trip, "distance", 0) or 0)
        for trip in recent_trips
        if _coerce_datetime(trip.endTime)
        and _coerce_datetime(trip.endTime) >= month_start
    )
    longest = max(
        recent_trips, key=lambda trip: float(trip.distance or 0), default=None
    )

    issues = []
    for trip in recent_trips:
        match_status = str(trip.matchStatus or "")
        if match_status.startswith(("error:", "skipped:")):
            issues.append(
                {
                    "trip_id": str(trip.id),
                    "title": "Route detail needs review",
                    "message": match_status,
                },
            )

    return {
        "summary": {
            "total_trips": total_trips,
            "recent_count": len(recent_trips),
            "month_miles": round(month_miles, 1),
            "inactive_count": inactive_count,
            "longest_recent_trip_miles": round(float(longest.distance or 0), 1)
            if longest
            else 0,
        },
        "highlights": [
            {
                "trip_id": str(trip.id),
                "transaction_id": trip.transactionId,
                "title": getattr(trip, "destinationPlaceName", None)
                or getattr(trip, "destination", None)
                or "Recent drive",
                "started_at": serialize_datetime(trip.startTime),
                "ended_at": serialize_datetime(trip.endTime),
                "distance_miles": round(float(trip.distance or 0), 1),
                "duration_seconds": trip.duration,
                "vehicle_imei": trip.imei,
            }
            for trip in recent_trips
        ],
        "issues": issues,
        "empty_state": {
            "title": "Your journal is waiting for the first drive",
            "message": "Connect Bouncie once and recent journeys will appear here automatically.",
        },
    }


@router.get("/garage/summary", response_model=dict[str, Any])
async def get_garage_summary() -> dict[str, Any]:
    """Return vehicle state without exposing maintenance controls by default."""
    vehicles = await _safe_to_list(Vehicle, limit=50)
    active = [vehicle for vehicle in vehicles if vehicle.is_active]
    sync_status = await _get_trip_sync_status()
    primary = active[0] if active else (vehicles[0] if vehicles else None)

    next_attention = None
    if not vehicles:
        next_attention = "Connect Bouncie to discover your garage."
    elif sync_status.get("error"):
        next_attention = sync_status["error"].get("message")
    elif primary and not primary.odometer_reading:
        next_attention = "Odometer will fill in after the next reliable reading."
    else:
        next_attention = "No action needed."

    return {
        "summary": {
            "vehicle_count": len(vehicles),
            "active_vehicle_count": len(active),
            "primary_vehicle": _vehicle_name(primary),
            "sync_state": sync_status.get("state", "unknown"),
            "next_attention": next_attention,
        },
        "vehicles": [
            {
                "imei": vehicle.imei,
                "vin": vehicle.vin,
                "name": _vehicle_name(vehicle),
                "is_active": vehicle.is_active,
                "odometer": vehicle.odometer_reading,
                "odometer_source": vehicle.odometer_source,
                "odometer_updated_at": serialize_datetime(vehicle.odometer_updated_at),
                "odometer_confidence": (
                    "high"
                    if vehicle.odometer_source == "bouncie"
                    else "manual"
                    if vehicle.odometer_source
                    else "pending"
                ),
                "updated_at": serialize_datetime(vehicle.updated_at),
            }
            for vehicle in vehicles
        ],
    }


@router.get("/fuel/suggestions", response_model=dict[str, Any])
async def get_fuel_suggestions() -> dict[str, Any]:
    """Return fuel stop suggestions before the manual fill-up form."""
    vehicles = await _safe_to_list(
        Vehicle,
        Vehicle.is_active == True,  # noqa: E712
        limit=25,
    )
    fillups = await _safe_to_list(GasFillup, limit=10)
    suggestions: list[dict[str, Any]] = []

    if not vehicles:
        suggestions.append(
            {
                "type": "connect_vehicle",
                "confidence": "high",
                "title": "Connect a vehicle first",
                "message": "Fuel stops become concierge prompts once a vehicle is available.",
                "cta_label": "Open Garage",
                "cta_href": "/vehicles",
            },
        )
    else:
        latest_fillup_time = max(
            (_coerce_datetime(fillup.fillup_time) for fillup in fillups),
            default=None,
        )
        stale_after = _now() - timedelta(days=14)
        if latest_fillup_time is None or latest_fillup_time < stale_after:
            vehicle = vehicles[0]
            suggestions.append(
                {
                    "type": "review_fillup",
                    "confidence": "medium",
                    "title": "Review the latest fuel stop",
                    "message": (
                        f"{_vehicle_name(vehicle)} has no recent confirmed fill-up."
                    ),
                    "vehicle_imei": vehicle.imei,
                    "suggested_time": serialize_datetime(_now()),
                    "odometer": vehicle.odometer_reading,
                },
            )

    return {
        "summary": {
            "suggestion_count": len(suggestions),
            "recent_fillup_count": len(fillups),
            "state": "ready" if suggestions else "quiet",
        },
        "suggestions": suggestions,
        "recent_fillups": [
            {
                "id": str(fillup.id),
                "vehicle_imei": fillup.imei,
                "fillup_time": serialize_datetime(fillup.fillup_time),
                "gallons": fillup.gallons,
                "total_cost": fillup.total_cost,
                "odometer": fillup.odometer,
                "calculated_mpg": fillup.calculated_mpg,
            }
            for fillup in fillups[:5]
        ],
    }
