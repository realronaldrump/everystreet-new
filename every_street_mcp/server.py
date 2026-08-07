"""Anonymous MCP server and ChatGPT App resources for EveryStreet."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from beanie import PydanticObjectId
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations

from analytics.services.dashboard_service import DashboardService
from analytics.services.trip_analytics_service import TripAnalyticsService
from core.auth import get_session_secret
from core.redis import get_shared_redis
from db.models import (
    CoverageArea,
    CoverageState,
    McpAuditEvent,
    Place,
    RecurringRoute,
    Street,
    Trip,
)
from gas.services.statistics_service import StatisticsService
from geo_coverage.services.geo_coverage_service import GeoCoverageService
from recurring_routes.services.service import serialize_route_summary
from street_coverage.intelligence import CoverageIntelligenceService
from tracking.services.tracking_service import TrackingService

from .security import ExactMcpPathAdapter, OpenAIMtlsProxyGuard

SERVER_NAME = "every-street-intelligence"
SERVER_VERSION = "1.0.0"
PUBLIC_APP_URL = "https://www.everystreet.me"
EXPLORER_RESOURCE_URI = "ui://every-street/explorer-v1.html"
LIVE_RESOURCE_URI = "ui://every-street/live-drive-v1.html"
ACTION_RESOURCE_URI = "ui://every-street/action-review-v1.html"
VIEW_TTL_SECONDS = 20 * 60
ACTION_MAX_AGE_SECONDS = 10 * 60
AUDIT_TTL_DAYS = 30
TOOL_COUNT = 17
MODEL_TOOL_COUNT = 15

NOAUTH = [{"type": "noauth"}]
READ_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
WRITE_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "EveryStreet contains one owner's historical driving, live Redis trip state, "
        "street coverage, places, recurring routes, and vehicle economics. Use read "
        "tools before preparing an action. Never imply that a live trip is historical "
        "or persisted. Writes require prepare_every_street_action followed by a user "
        "click in the action-review widget."
    ),
    website_url=PUBLIC_APP_URL,
    host="0.0.0.0",
    streamable_http_path="/",
    stateless_http=True,
    json_response=True,
)


def _tool_meta(
    *,
    resource_uri: str | None = None,
    visibility: list[str] | None = None,
    invoking: str,
    invoked: str,
) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "securitySchemes": NOAUTH,
        "ui": {"visibility": visibility or ["model", "app"]},
        "openai/toolInvocation/invoking": invoking,
        "openai/toolInvocation/invoked": invoked,
    }
    if resource_uri:
        meta["ui"]["resourceUri"] = resource_uri
        meta["openai/outputTemplate"] = resource_uri
        meta["openai/widgetAccessible"] = True
    return meta


def _result(
    summary: str,
    structured: dict[str, Any],
    *,
    hidden: dict[str, Any] | None = None,
) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=summary)],
        structuredContent=structured,
        _meta=hidden or {},
    )


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value, PydanticObjectId):
        return str(value)
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return str(value)


def _public_trip(trip: Trip, *, include_identifiers: bool = True) -> dict[str, Any]:
    result = {
        "id": str(trip.id),
        "start_time": _json_default(trip.startTime) if trip.startTime else None,
        "end_time": _json_default(trip.endTime) if trip.endTime else None,
        "distance_miles": trip.distance,
        "average_speed_mph": trip.avgSpeed,
        "maximum_speed_mph": trip.maxSpeed,
        "fuel_gallons": trip.fuelConsumed,
        "idle_seconds": trip.totalIdleDuration,
        "destination_name": trip.destinationPlaceName,
        "recurring_route_id": (
            str(trip.recurringRouteId) if trip.recurringRouteId else None
        ),
        "validation_status": trip.validation_status,
        "source": trip.source,
    }
    if include_identifiers:
        result["transaction_id"] = trip.transactionId
    return result


def _date_query(
    preset: Literal[
        "last_7_days",
        "last_30_days",
        "last_90_days",
        "year_to_date",
        "all_time",
        "custom",
    ],
    start: datetime | None,
    end: datetime | None,
) -> tuple[dict[str, Any], datetime | None, datetime | None]:
    now = datetime.now(UTC)
    if preset == "custom":
        if start is None or end is None or start >= end:
            raise ValueError("Custom windows require start < end")
        start_at = start.astimezone(UTC)
        end_at = end.astimezone(UTC)
    elif preset == "all_time":
        start_at = None
        end_at = None
    elif preset == "year_to_date":
        start_at = datetime(now.year, 1, 1, tzinfo=UTC)
        end_at = now
    else:
        days = {
            "last_7_days": 7,
            "last_30_days": 30,
            "last_90_days": 90,
        }[preset]
        start_at = now - timedelta(days=days)
        end_at = now
    query: dict[str, Any] = {
        "source": "bouncie",
        "inactive": {"$ne": True},
        "invalid": {"$ne": True},
    }
    if start_at or end_at:
        query["startTime"] = {}
        if start_at:
            query["startTime"]["$gte"] = start_at
        if end_at:
            query["startTime"]["$lt"] = end_at
    return query, start_at, end_at


async def _audit(
    tool_name: str,
    started: float,
    *,
    outcome: str = "success",
    result_count: int | None = None,
    action_type: str | None = None,
) -> None:
    now = datetime.now(UTC)
    try:
        await McpAuditEvent(
            request_id=str(uuid.uuid4()),
            subject_hash=hashlib.sha256(b"anonymous").hexdigest()[:16],
            tool_name=tool_name,
            outcome=outcome,
            duration_ms=max(int((time.monotonic() - started) * 1000), 0),
            result_count=result_count,
            action_type=action_type,
            created_at=now,
            expires_at=now + timedelta(days=AUDIT_TTL_DAYS),
        ).insert()
    except Exception:
        # Audit persistence must never turn a successful read into a failed tool call.
        return


async def _start_tool(tool_name: str, *, limit: int = 60) -> float:
    """Apply a global anonymous per-tool minute limit and return a timer."""

    redis = await get_shared_redis()
    window = int(time.time() // 60)
    key = f"mcp:rate:{tool_name}:{window}"
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, 90)
    if count > limit:
        raise ValueError(
            f"EveryStreet rate limit reached for {tool_name}; retry next minute"
        )
    return time.monotonic()


async def _save_view(payload: dict[str, Any]) -> str:
    view_id = uuid.uuid4().hex
    redis = await get_shared_redis()
    await redis.setex(
        f"mcp:view:{view_id}",
        VIEW_TTL_SECONDS,
        json.dumps(payload, default=_json_default, separators=(",", ":")),
    )
    return view_id


def _action_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(
        get_session_secret(), salt="every-street-mcp-action-v1"
    )


def _load_action_token(token: str) -> dict[str, Any]:
    try:
        payload = _action_serializer().loads(token, max_age=ACTION_MAX_AGE_SECONDS)
    except SignatureExpired as exc:
        raise ValueError("Action review expired; prepare it again") from exc
    except BadSignature as exc:
        raise ValueError("Action review token is invalid") from exc
    if not isinstance(payload, dict) or payload.get("nonce") is None:
        raise ValueError("Action review token is invalid")
    return payload


def _parse_target_date(value: Any) -> datetime | None:
    if value in {None, ""}:
        return None
    raw = str(value).strip()
    if len(raw) == 10:
        return datetime.combine(
            date.fromisoformat(raw), datetime.max.time(), tzinfo=UTC
        )
    parsed = datetime.fromisoformat(raw)
    return (
        parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    )


async def _validate_action_arguments(
    action: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    normalized = dict(arguments)
    if action == "save_coverage_goal":
        area_id = PydanticObjectId(str(normalized["area_id"]))
        if await CoverageArea.get(area_id) is None:
            raise ValueError("Coverage area not found")
        percentage = float(normalized.get("target_percentage", 100.0))
        minutes = int(normalized.get("preferred_mission_minutes", 90))
        if not 1 <= percentage <= 100:
            raise ValueError("Target percentage must be between 1 and 100")
        if not 15 <= minutes <= 480:
            raise ValueError("Preferred mission minutes must be between 15 and 480")
        target_date = _parse_target_date(normalized.get("target_date"))
        normalized.update(
            {
                "area_id": str(area_id),
                "target_percentage": percentage,
                "preferred_mission_minutes": minutes,
                "target_date": target_date.isoformat() if target_date else None,
            }
        )
    elif action == "create_coverage_mission":
        area_id = PydanticObjectId(str(normalized["area_id"]))
        area = await CoverageArea.get(area_id)
        if area is None:
            raise ValueError("Coverage area not found")
        segment_ids = list(
            dict.fromkeys(str(value) for value in normalized["segment_ids"] if value)
        )
        if not 1 <= len(segment_ids) <= 500:
            raise ValueError("Mission must contain between 1 and 500 segments")
        if int(normalized["expected_area_version"]) != area.area_version:
            raise ValueError("Coverage area changed; refresh mission recommendations")
        if int(normalized["expected_journal_revision"]) != int(
            area.journal_revision or 0
        ):
            raise ValueError("Coverage changed; refresh mission recommendations")
        normalized.update({"area_id": str(area_id), "segment_ids": segment_ids})
    else:
        mission_id = PydanticObjectId(str(normalized["mission_id"]))
        await CoverageIntelligenceService.get_mission(mission_id)
        normalized["mission_id"] = str(mission_id)
    return normalized


async def _consume_action_nonce(nonce: str) -> None:
    redis = await get_shared_redis()
    accepted = await redis.set(
        f"mcp:action:{nonce}",
        "committed",
        ex=ACTION_MAX_AGE_SECONDS,
        nx=True,
    )
    if not accepted:
        raise ValueError("This action was already committed")


@mcp.tool(
    title="Get EveryStreet snapshot",
    description="Summarize historical driving, street coverage, places, recurring routes, and live-drive state.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Summarizing EveryStreet…", invoked="Snapshot ready"),
    structured_output=False,
)
async def get_every_street_snapshot() -> CallToolResult:
    started = await _start_tool("get_every_street_snapshot")
    areas = (
        await CoverageArea.find_all().sort(-CoverageArea.coverage_percentage).to_list()
    )
    trip_count = await Trip.find(
        {"source": "bouncie", "inactive": {"$ne": True}, "invalid": {"$ne": True}},
    ).count()
    place_count = await Place.find_all().count()
    recurring_count = await RecurringRoute.find(
        {"is_recurring": True, "is_hidden": {"$ne": True}},
    ).count()
    live = await TrackingService.get_active_trip()
    structured = {
        "as_of": datetime.now(UTC).isoformat(),
        "historical_trip_count": trip_count,
        "place_count": place_count,
        "recurring_route_count": recurring_count,
        "live_drive_active": bool(live),
        "coverage_areas": [
            {
                "id": str(area.id),
                "name": area.display_name,
                "status": area.status,
                "coverage_percentage": round(float(area.coverage_percentage or 0.0), 3),
                "driven_miles": round(float(area.driven_length_miles or 0.0), 3),
                "driveable_miles": round(float(area.driveable_length_miles or 0.0), 3),
            }
            for area in areas
        ],
    }
    await _audit("get_every_street_snapshot", started, result_count=len(areas))
    return _result(
        f"EveryStreet has {trip_count:,} historical trips and {len(areas)} coverage areas.",
        structured,
    )


@mcp.tool(
    title="Analyze driving history",
    description="Analyze driving totals and time patterns for a standard or custom date window.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Analyzing driving…", invoked="Driving analysis ready"),
    structured_output=False,
)
async def analyze_driving_history(
    preset: Literal[
        "last_7_days",
        "last_30_days",
        "last_90_days",
        "year_to_date",
        "all_time",
        "custom",
    ] = "last_30_days",
    start: datetime | None = None,
    end: datetime | None = None,
) -> CallToolResult:
    started = await _start_tool("analyze_driving_history", limit=10)
    query, start_at, end_at = _date_query(preset, start, end)
    insights = await DashboardService.get_driving_insights(
        query,
        include_movement=False,
    )
    patterns = await TripAnalyticsService.get_trip_analytics(query)
    structured = {
        "window": {
            "preset": preset,
            "start": _json_default(start_at) if start_at else None,
            "end": _json_default(end_at) if end_at else None,
        },
        "insights": insights,
        "patterns": patterns,
    }
    await _audit("analyze_driving_history", started)
    return _result(f"Driving analysis for {preset} is ready.", structured)


@mcp.tool(
    title="Find historical trips",
    description="Find historical Bouncie trips by date window, destination name, and bounded result count.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Finding trips…", invoked="Trips found"),
    structured_output=False,
)
async def find_trips(
    preset: Literal[
        "last_7_days",
        "last_30_days",
        "last_90_days",
        "year_to_date",
        "all_time",
        "custom",
    ] = "last_30_days",
    start: datetime | None = None,
    end: datetime | None = None,
    destination: str | None = None,
    limit: int = 20,
) -> CallToolResult:
    started = await _start_tool("find_trips")
    query, start_at, end_at = _date_query(preset, start, end)
    if destination:
        query["destinationPlaceName"] = {"$regex": destination.strip(), "$options": "i"}
    limit = min(max(int(limit), 1), 50)
    trips = await Trip.find(query).sort(-Trip.startTime).limit(limit).to_list()
    structured = {
        "window": {
            "preset": preset,
            "start": _json_default(start_at) if start_at else None,
            "end": _json_default(end_at) if end_at else None,
        },
        "trips": [_public_trip(trip) for trip in trips],
        "has_more": len(trips) == limit,
    }
    await _audit("find_trips", started, result_count=len(trips))
    return _result(f"Found {len(trips)} historical trips.", structured)


@mcp.tool(
    title="Get historical trip details",
    description="Get metrics and map-ready geometry for one historical trip by database or transaction ID.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(
        resource_uri=EXPLORER_RESOURCE_URI,
        invoking="Loading trip…",
        invoked="Trip ready",
    ),
    structured_output=False,
)
async def get_trip_details(trip_id: str) -> CallToolResult:
    started = await _start_tool("get_trip_details")
    trip = None
    if len(trip_id) == 24:
        try:
            trip = await Trip.get(PydanticObjectId(trip_id))
        except Exception:
            trip = None
    if trip is None:
        trip = await Trip.find_one({"transactionId": trip_id})
    if trip is None:
        raise ValueError("Historical trip not found")
    geometry = trip.displayGps or trip.matchedGps or trip.gps
    structured = {"trip": _public_trip(trip)}
    await _audit("get_trip_details", started, result_count=1)
    return _result(
        "Historical trip details are ready.",
        structured,
        hidden={"map": {"type": "trip", "geometry": geometry}},
    )


@mcp.tool(
    title="Analyze places",
    description="List saved places and summarize their historical trip usage without exposing place geometry to the model.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Analyzing places…", invoked="Places ready"),
    structured_output=False,
)
async def analyze_places(limit: int = 50) -> CallToolResult:
    started = await _start_tool("analyze_places", limit=10)
    places = (
        await Place.find_all().sort(Place.name).limit(min(max(limit, 1), 100)).to_list()
    )
    rows = []
    hidden_geometries: dict[str, Any] = {}
    for place in places:
        place_id = str(place.id)
        visit_count = await Trip.find(
            {
                "source": "bouncie",
                "inactive": {"$ne": True},
                "$or": [
                    {"destinationPlaceId": place_id},
                    {"startPlaceId": place_id},
                ],
            },
        ).count()
        rows.append({"id": place_id, "name": place.name, "trip_count": visit_count})
        hidden_geometries[place_id] = place.geometry
    rows.sort(key=lambda row: (-int(row["trip_count"]), str(row["name"])))
    await _audit("analyze_places", started, result_count=len(rows))
    return _result(
        f"Analyzed {len(rows)} saved places.",
        {"places": rows},
        hidden={"place_geometries": hidden_geometries},
    )


@mcp.tool(
    title="Analyze recurring routes",
    description="Summarize recurring route frequency, distance, duration, fuel, and cost.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Analyzing recurring routes…", invoked="Routes ready"),
    structured_output=False,
)
async def analyze_recurring_routes(
    include_hidden: bool = False,
    limit: int = 30,
) -> CallToolResult:
    started = await _start_tool("analyze_recurring_routes", limit=10)
    query: dict[str, Any] = {"is_recurring": True}
    if not include_hidden:
        query["is_hidden"] = {"$ne": True}
    routes = (
        await RecurringRoute.find(query)
        .sort(-RecurringRoute.trip_count)
        .limit(
            min(max(limit, 1), 50),
        )
        .to_list()
    )
    rows = [serialize_route_summary(route) for route in routes]
    await _audit("analyze_recurring_routes", started, result_count=len(rows))
    return _result(f"Analyzed {len(rows)} recurring routes.", {"routes": rows})


@mcp.tool(
    title="Get geographic coverage",
    description="Summarize states, counties, and cities visited from historical trip processing.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Loading geographic coverage…", invoked="Coverage ready"),
    structured_output=False,
)
async def get_geographic_coverage() -> CallToolResult:
    started = await _start_tool("get_geographic_coverage", limit=10)
    summary = await GeoCoverageService.get_summary()
    await _audit("get_geographic_coverage", started)
    return _result("Geographic coverage summary is ready.", summary)


@mcp.tool(
    title="List street coverage areas",
    description="List current street coverage areas with versions, progress, and remaining miles.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Loading coverage areas…", invoked="Areas ready"),
    structured_output=False,
)
async def list_coverage_areas() -> CallToolResult:
    started = await _start_tool("list_coverage_areas")
    areas = await CoverageArea.find_all().sort(CoverageArea.display_name).to_list()
    rows = [
        {
            "id": str(area.id),
            "name": area.display_name,
            "status": area.status,
            "area_version": area.area_version,
            "journal_revision": int(area.journal_revision or 0),
            "coverage_percentage": round(float(area.coverage_percentage or 0.0), 3),
            "driveable_miles": round(float(area.driveable_length_miles or 0.0), 3),
            "driven_miles": round(float(area.driven_length_miles or 0.0), 3),
            "remaining_miles": round(
                max(
                    float(area.driveable_length_miles or 0.0)
                    - float(area.driven_length_miles or 0.0),
                    0.0,
                ),
                3,
            ),
        }
        for area in areas
    ]
    await _audit("list_coverage_areas", started, result_count=len(rows))
    return _result(f"Found {len(rows)} coverage areas.", {"areas": rows})


@mcp.tool(
    title="Get coverage intelligence",
    description="Get a coverage area's goal, deterministic pace forecast, required pace, and active mission.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Forecasting coverage…", invoked="Forecast ready"),
    structured_output=False,
)
async def get_coverage_intelligence(area_id: str) -> CallToolResult:
    started = await _start_tool("get_coverage_intelligence", limit=10)
    intelligence = await CoverageIntelligenceService.get_intelligence(
        PydanticObjectId(area_id),
    )
    await _audit("get_coverage_intelligence", started, result_count=1)
    return _result(
        f"Coverage intelligence for {intelligence['area']['display_name']} is ready.",
        intelligence,
    )


@mcp.tool(
    title="Recommend coverage missions",
    description="Recommend up to five efficient, bounded missions for undriven streets from a supplied or area-center start.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Planning coverage missions…", invoked="Missions ready"),
    structured_output=False,
)
async def recommend_coverage_missions(
    area_id: str,
    preferred_minutes: int = 90,
    start_lat: float | None = None,
    start_lon: float | None = None,
) -> CallToolResult:
    started = await _start_tool("recommend_coverage_missions", limit=10)
    recommendations = await CoverageIntelligenceService.recommend_missions(
        PydanticObjectId(area_id),
        preferred_minutes=preferred_minutes,
        start_lat=start_lat,
        start_lon=start_lon,
        limit=5,
    )
    await _audit(
        "recommend_coverage_missions",
        started,
        result_count=len(recommendations["recommendations"]),
    )
    return _result(
        f"Prepared {len(recommendations['recommendations'])} coverage mission candidates.",
        recommendations,
    )


@mcp.tool(
    title="Get live drive",
    description="Get the current Redis-backed live drive. This never treats live state as historical trip data.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(
        resource_uri=LIVE_RESOURCE_URI,
        invoking="Checking live drive…",
        invoked="Live drive checked",
    ),
    structured_output=False,
)
async def get_live_drive() -> CallToolResult:
    started = await _start_tool("get_live_drive")
    live = await TrackingService.get_active_trip()
    if not live:
        await _audit("get_live_drive", started, result_count=0)
        return _result("No drive is currently active.", {"active": False})
    structured = {
        "active": True,
        "transaction_id": live.get("transactionId"),
        "status": live.get("status"),
        "start_time": live.get("startTime"),
        "last_update": live.get("lastUpdate"),
        "distance_miles": live.get("distance"),
        "current_speed_mph": live.get("currentSpeed"),
        "maximum_speed_mph": live.get("maxSpeed"),
        "points_recorded": live.get("pointsRecorded"),
        "ephemeral": True,
    }
    await _audit("get_live_drive", started, result_count=1)
    return _result(
        "A live Redis-backed drive is active.",
        structured,
        hidden={"live_trip": live},
    )


@mcp.tool(
    title="Get vehicle economics",
    description="Summarize fillups, fuel economy, fuel cost, and cost per mile for a date range.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(
        invoking="Calculating vehicle economics…", invoked="Economics ready"
    ),
    structured_output=False,
)
async def get_vehicle_economics(
    start_date: str | None = None,
    end_date: str | None = None,
    imei: str | None = None,
) -> CallToolResult:
    started = await _start_tool("get_vehicle_economics", limit=10)
    result = await StatisticsService.get_gas_statistics(
        imei=imei,
        start_date=start_date,
        end_date=end_date,
    )
    await _audit("get_vehicle_economics", started)
    return _result("Vehicle economics are ready.", result)


@mcp.tool(
    title="Get EveryStreet system health",
    description="Check database-backed app data and Bouncie live-webhook health without exposing credentials or logs.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(invoking="Checking EveryStreet…", invoked="Health ready"),
    structured_output=False,
)
async def get_system_health() -> CallToolResult:
    started = await _start_tool("get_system_health")
    webhook = await TrackingService.get_webhook_status()
    latest_trip = (
        await Trip.find(
            {"source": "bouncie", "inactive": {"$ne": True}},
        )
        .sort(-Trip.endTime)
        .first_or_none()
    )
    result = {
        "ok": True,
        "as_of": datetime.now(UTC).isoformat(),
        "latest_historical_trip_end": (
            _json_default(latest_trip.endTime)
            if latest_trip and latest_trip.endTime
            else None
        ),
        "live_webhook": webhook,
        "mcp": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION,
            "authentication": "none",
        },
    }
    await _audit("get_system_health", started)
    return _result("EveryStreet system health is ready.", result)


@mcp.tool(
    title="Open EveryStreet explorer",
    description="Render a fullscreen map and analytical coverage explorer for one area.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(
        resource_uri=EXPLORER_RESOURCE_URI,
        invoking="Building explorer…",
        invoked="Explorer ready",
    ),
    structured_output=False,
)
async def render_every_street_explorer(area_id: str) -> CallToolResult:
    started = await _start_tool("render_every_street_explorer", limit=10)
    oid = PydanticObjectId(area_id)
    area = await CoverageArea.get(oid)
    if area is None:
        raise ValueError("Coverage area not found")
    intelligence = await CoverageIntelligenceService.get_intelligence(oid)
    streets = await Street.find(
        {"area_id": oid, "area_version": area.area_version},
    ).to_list()
    states = await CoverageState.find({"area_id": oid}).to_list()
    status_by_segment = {state.segment_id: state.status for state in states}
    view_payload = {
        "area": {
            "id": str(area.id),
            "name": area.display_name,
            "boundary": area.boundary,
            "bounding_box": area.bounding_box,
        },
        "features": [
            {
                "segment_id": street.segment_id,
                "street_name": street.street_name,
                "highway_type": street.highway_type,
                "length_miles": street.length_miles,
                "status": status_by_segment.get(street.segment_id, "undriven"),
                "geometry": street.geometry,
            }
            for street in streets
        ],
    }
    view_id = await _save_view(view_payload)
    structured = {
        "view_id": view_id,
        "view_expires_in_seconds": VIEW_TTL_SECONDS,
        "feature_count": len(streets),
        "intelligence": intelligence,
    }
    await _audit("render_every_street_explorer", started, result_count=len(streets))
    return _result(
        f"The {area.display_name} explorer is ready.",
        structured,
        hidden={"view_id": view_id, "initial_view": view_payload},
    )


@mcp.tool(
    title="Prepare an EveryStreet action",
    description="Prepare a reversible goal or mission change for explicit review. This tool never commits the change.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(
        resource_uri=ACTION_RESOURCE_URI,
        invoking="Preparing action review…",
        invoked="Action ready for review",
    ),
    structured_output=False,
)
async def prepare_every_street_action(
    action: Literal[
        "save_coverage_goal",
        "create_coverage_mission",
        "start_coverage_mission",
        "finish_coverage_mission",
        "cancel_coverage_mission",
    ],
    arguments: dict[str, Any],
) -> CallToolResult:
    started = await _start_tool("prepare_every_street_action", limit=5)
    arguments = await _validate_action_arguments(action, arguments)
    nonce = uuid.uuid4().hex
    preview = {
        "action": action,
        "arguments": arguments,
        "expires_in_seconds": ACTION_MAX_AGE_SECONDS,
    }
    token = _action_serializer().dumps(
        {"action": action, "arguments": arguments, "nonce": nonce},
    )
    await _audit("prepare_every_street_action", started, action_type=action)
    return _result(
        "The action is prepared. Review it in the confirmation card; no data has changed.",
        {"prepared": True, "preview": preview},
        hidden={"action_token": token},
    )


@mcp.tool(
    title="Load EveryStreet view data",
    description="Load paginated model-hidden geometry for an EveryStreet widget.",
    annotations=READ_ANNOTATIONS,
    meta=_tool_meta(
        visibility=["app"],
        invoking="Loading map data…",
        invoked="Map data ready",
    ),
    structured_output=False,
)
async def get_view_data(
    view_id: str, offset: int = 0, limit: int = 500
) -> CallToolResult:
    started = await _start_tool("get_view_data")
    redis = await get_shared_redis()
    raw = await redis.get(f"mcp:view:{view_id}")
    if not raw:
        raise ValueError("This map view expired; ask ChatGPT to render it again")
    payload = json.loads(raw)
    features = payload.get("features") or []
    offset = min(max(int(offset), 0), len(features))
    limit = min(max(int(limit), 1), 1000)
    page = features[offset : offset + limit]
    structured = {
        "view_id": view_id,
        "offset": offset,
        "returned": len(page),
        "total": len(features),
        "next_offset": offset + len(page)
        if offset + len(page) < len(features)
        else None,
    }
    await _audit("get_view_data", started, result_count=len(page))
    return _result(
        f"Loaded {len(page)} map features.",
        structured,
        hidden={"area": payload.get("area"), "features": page},
    )


@mcp.tool(
    title="Commit reviewed EveryStreet action",
    description="Commit the exact signed action selected in the EveryStreet review widget.",
    annotations=WRITE_ANNOTATIONS,
    meta=_tool_meta(
        visibility=["app"],
        invoking="Applying reviewed action…",
        invoked="Action applied",
    ),
    structured_output=False,
)
async def commit_every_street_action(action_token: str) -> CallToolResult:
    started = await _start_tool("commit_every_street_action", limit=5)
    payload = _load_action_token(action_token)
    action = str(payload["action"])
    arguments = await _validate_action_arguments(
        action,
        dict(payload.get("arguments") or {}),
    )
    await _consume_action_nonce(str(payload["nonce"]))
    if action == "save_coverage_goal":
        result = await CoverageIntelligenceService.save_goal(
            PydanticObjectId(str(arguments["area_id"])),
            target_percentage=float(arguments.get("target_percentage", 100.0)),
            target_date=_parse_target_date(arguments.get("target_date")),
            preferred_mission_minutes=int(
                arguments.get("preferred_mission_minutes", 90)
            ),
        )
    elif action == "create_coverage_mission":
        result = await CoverageIntelligenceService.create_mission(
            PydanticObjectId(str(arguments["area_id"])),
            segment_ids=list(arguments["segment_ids"]),
            expected_area_version=int(arguments["expected_area_version"]),
            expected_journal_revision=int(arguments["expected_journal_revision"]),
            requested_minutes=int(arguments.get("requested_minutes", 90)),
            start_lat=arguments.get("start_lat"),
            start_lon=arguments.get("start_lon"),
        )
    else:
        transition = action.removesuffix("_coverage_mission")
        result = await CoverageIntelligenceService.transition_mission(
            PydanticObjectId(str(arguments["mission_id"])),
            transition,
        )
    await _audit(
        "commit_every_street_action",
        started,
        action_type=action,
    )
    return _result(
        "The reviewed EveryStreet action was applied.",
        {"success": True, "result": result},
    )


def _widget_html(filename: str) -> str:
    return (Path(__file__).with_name(filename)).read_text(encoding="utf-8")


_RESOURCE_META = {
    "ui": {
        "prefersBorder": True,
        "domain": PUBLIC_APP_URL,
        "csp": {
            "connectDomains": [
                PUBLIC_APP_URL,
                "https://api.mapbox.com",
                "https://events.mapbox.com",
            ],
            "resourceDomains": ["https://api.mapbox.com", "https://*.tiles.mapbox.com"],
        },
    },
    "openai/widgetDescription": "Interactive EveryStreet driving and coverage visualization.",
    "openai/widgetPrefersBorder": True,
    "openai/widgetDomain": PUBLIC_APP_URL,
    "openai/widgetCSP": {
        "connect_domains": [
            PUBLIC_APP_URL,
            "https://api.mapbox.com",
            "https://events.mapbox.com",
        ],
        "resource_domains": ["https://api.mapbox.com", "https://*.tiles.mapbox.com"],
        "redirect_domains": [PUBLIC_APP_URL],
    },
}


@mcp.resource(
    EXPLORER_RESOURCE_URI,
    name="EveryStreet Explorer",
    description="Fullscreen coverage and historical-trip map explorer.",
    mime_type="text/html+skybridge",
    meta=_RESOURCE_META,
)
def explorer_resource() -> str:
    return _widget_html("explorer.html")


@mcp.resource(
    LIVE_RESOURCE_URI,
    name="EveryStreet Live Drive",
    description="Compact live-drive status and route visualization.",
    mime_type="text/html+skybridge",
    meta=_RESOURCE_META,
)
def live_resource() -> str:
    return _widget_html("live_drive.html")


@mcp.resource(
    ACTION_RESOURCE_URI,
    name="EveryStreet Action Review",
    description="Review and explicitly commit a reversible EveryStreet action.",
    mime_type="text/html+skybridge",
    meta={
        **_RESOURCE_META,
        "openai/widgetDescription": "Review a reversible EveryStreet action before applying it.",
    },
)
def action_resource() -> str:
    return _widget_html("action_review.html")


_mcp_sdk_app = OpenAIMtlsProxyGuard(mcp.streamable_http_app())
mcp_http_app = _mcp_sdk_app
mcp_exact_app = ExactMcpPathAdapter(_mcp_sdk_app)


@asynccontextmanager
async def mcp_lifespan():
    """Run the SDK's streamable-HTTP session manager inside FastAPI lifespan."""

    async with mcp.session_manager.run():
        yield


__all__ = [
    "MODEL_TOOL_COUNT",
    "SERVER_NAME",
    "SERVER_VERSION",
    "TOOL_COUNT",
    "mcp",
    "mcp_exact_app",
    "mcp_http_app",
    "mcp_lifespan",
]
