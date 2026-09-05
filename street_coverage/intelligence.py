"""Coverage goals, deterministic forecasts, and bounded drive missions."""

from __future__ import annotations

import math
import statistics
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from beanie import PydanticObjectId

from db.models import (
    CoverageArea,
    CoverageGoal,
    CoverageMission,
    CoverageState,
    CoverageDriveEvent,
    CoverageJournalEntry,
    CoverageJournalRollup,
    Job,
    Street,
)
from driving.services.driving_service import DrivingService

MILES_PER_METER = 1 / 1609.344
DEFAULT_COVERAGE_SPEED_MPH = 22.0
MISSION_COMPLETION_RATIO = 0.95
MISSION_ACTIVE_STATES = {"route_generating", "ready", "active"}


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat() if value else None


def _percentile(values: list[float], probability: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _serialize_goal(goal: CoverageGoal | None) -> dict[str, Any] | None:
    if goal is None:
        return None
    return {
        "id": str(goal.id),
        "area_id": str(goal.area_id),
        "target_percentage": round(float(goal.target_percentage), 2),
        "target_date": _iso(goal.target_date),
        "preferred_mission_minutes": int(goal.preferred_mission_minutes),
        "baseline_percentage": round(float(goal.baseline_percentage), 2),
        "baseline_driven_miles": round(float(goal.baseline_driven_miles), 3),
        "status": goal.status,
        "created_at": _iso(goal.created_at),
        "updated_at": _iso(goal.updated_at),
        "completed_at": _iso(goal.completed_at),
    }


async def _serialize_mission(
    mission: CoverageMission,
    *,
    include_route: bool = False,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": str(mission.id),
        "area_id": str(mission.area_id),
        "goal_id": str(mission.goal_id) if mission.goal_id else None,
        "area_version": mission.area_version,
        "journal_revision": mission.journal_revision,
        "status": mission.status,
        "target_segment_ids": mission.target_segment_ids,
        "mapped_segment_ids": mission.mapped_segment_ids,
        "completed_segment_ids": mission.completed_segment_ids,
        "completion_ratio": min(1.0, mission.actual_new_miles / mission.target_miles)
        if mission.target_miles > 0
        else 0.0,
        "requested_minutes": mission.requested_minutes,
        "target_miles": round(mission.target_miles, 3),
        "route_distance_miles": mission.route_distance_miles,
        "estimated_duration_minutes": mission.estimated_duration_minutes,
        "estimate_basis": mission.estimate_basis,
        "predicted_coverage_gain": round(mission.predicted_coverage_gain, 3),
        "predicted_coverage_after": round(mission.predicted_coverage_after, 3),
        "confidence": mission.confidence,
        "route_job_id": mission.route_job_id,
        "route_id": str(mission.route_id) if mission.route_id else None,
        "navigation_url": f"/live-navigation?routeId={mission.route_id}&areaId={mission.area_id}"
        if mission.route_id
        else None,
        "actual_trip_ids": [str(value) for value in mission.actual_trip_ids],
        "actual_new_miles": round(mission.actual_new_miles, 3),
        "actual_coverage_gain": round(mission.actual_coverage_gain, 3),
        "created_at": _iso(mission.created_at),
        "updated_at": _iso(mission.updated_at),
        "started_at": _iso(mission.started_at),
        "completed_at": _iso(mission.completed_at),
    }
    if include_route:
        from fastapi import HTTPException

        from routing.route_store import get_generated_route

        payload["route"] = None
        if mission.route_id:
            try:
                payload["route"] = await get_generated_route(mission.route_id)
            except HTTPException as exc:
                payload["route_error"] = exc.detail
    return payload


async def _current_street_lengths(area: CoverageArea) -> dict[str, float]:
    streets = await Street.find(
        {"area_id": area.id, "area_version": area.area_version},
    ).to_list()
    return {
        street.segment_id: max(float(street.length_miles or 0.0), 0.0)
        for street in streets
    }


async def _daily_new_miles(area, *, since, timezone="UTC"):
    from zoneinfo import ZoneInfo
    from street_coverage.journal import normalize_timezone

    rollup = await CoverageJournalRollup.find_one(
        {"area_id": area.id, "area_version": area.area_version}
    )
    if rollup is None:
        return {}
    rows = await CoverageJournalEntry.find(
        {
            "area_id": area.id,
            "area_version": area.area_version,
            "revision": rollup.revision,
            "kind": "contribution",
            "data.source": "trip",
            "occurred_at": {"$gte": since},
        }
    ).to_list()
    totals = {}
    zone = ZoneInfo(normalize_timezone(timezone))
    for row in rows:
        day = row.occurred_at.astimezone(zone).date()
        totals[day] = totals.get(day, 0.0) + float(row.data["new_miles"])
    return totals


def _pace_date(now, days):
    if not math.isfinite(days) or days > 365 * 50:
        return None
    return (now + timedelta(days=days)).date().isoformat()


def target_reached(area, percentage):
    if area.driveable_length_miles <= 0:
        return False
    return (
        area.is_complete
        if percentage >= 100
        else area.coverage_percentage >= percentage
    )


class CoverageIntelligenceService:
    """Authoritative goal, forecast, recommendation, and mission service."""

    @staticmethod
    async def get_goal(area_id: PydanticObjectId) -> CoverageGoal | None:
        return await CoverageGoal.find_one({"area_id": area_id})

    @staticmethod
    async def save_goal(
        area_id: PydanticObjectId,
        *,
        target_percentage: float = 100.0,
        target_date: datetime | None = None,
        preferred_mission_minutes: int = 90,
    ) -> dict[str, Any]:
        area = await CoverageArea.get(area_id)
        if area is None:
            raise ValueError("Coverage area not found")
        target_percentage = min(max(float(target_percentage), 1.0), 100.0)
        preferred_mission_minutes = min(max(int(preferred_mission_minutes), 15), 480)
        now = datetime.now(UTC)
        goal = await CoverageGoal.find_one({"area_id": area_id})
        if goal is None:
            goal = CoverageGoal(
                area_id=area_id,
                target_percentage=target_percentage,
                target_date=target_date,
                preferred_mission_minutes=preferred_mission_minutes,
                baseline_percentage=float(area.coverage_percentage or 0.0),
                baseline_driven_miles=float(area.driven_length_miles or 0.0),
                status=(
                    "completed" if target_reached(area, target_percentage) else "active"
                ),
                completed_at=(now if target_reached(area, target_percentage) else None),
            )
            await goal.insert()
        else:
            goal.target_percentage = target_percentage
            goal.target_date = target_date
            goal.preferred_mission_minutes = preferred_mission_minutes
            goal.updated_at = now
            completed = target_reached(area, target_percentage)
            goal.status = "completed" if completed else "active"
            goal.completed_at = now if completed else None
            await goal.save()
        return _serialize_goal(goal) or {}

    @staticmethod
    async def get_intelligence(
        area_id: PydanticObjectId, *, timezone: str = "UTC"
    ) -> dict[str, Any]:
        area = await CoverageArea.get(area_id)
        if area is None:
            raise ValueError("Coverage area not found")
        goal = await CoverageIntelligenceService.get_goal(area_id)
        target_percentage = float(goal.target_percentage if goal else 100.0)
        driveable_miles = max(float(area.driveable_length_miles or 0.0), 0.0)
        driven_miles = max(float(area.driven_length_miles or 0.0), 0.0)
        target_miles = driveable_miles * target_percentage / 100.0
        remaining_miles = max(target_miles - driven_miles, 0.0)
        now = datetime.now(UTC)

        recent = await _daily_new_miles(
            area, since=now - timedelta(days=90), timezone=timezone
        )
        window_days = 90
        daily = recent
        if len(recent) < 4:
            daily = await _daily_new_miles(
                area, since=now - timedelta(days=365), timezone=timezone
            )
            window_days = 365

        values = [value for value in daily.values() if value > 0]
        active_days = len(values)
        forecast: dict[str, Any] = {
            "available": active_days >= 4 and remaining_miles > 0,
            "window_days": window_days,
            "active_days": active_days,
            "median_new_miles_per_active_day": None,
            "active_days_per_week": None,
            "expected_completion_date": None,
            "completion_date_range": None,
            "confidence": "insufficient",
            "required_miles_per_week": None,
            "required_active_days_per_week": None,
        }
        if target_reached(area, target_percentage):
            forecast.update(
                {
                    "available": True,
                    "expected_completion_date": now.date().isoformat(),
                    "completion_date_range": {
                        "earliest": now.date().isoformat(),
                        "latest": now.date().isoformat(),
                    },
                    "confidence": "complete",
                },
            )
        elif active_days >= 4:
            median_daily = statistics.median(values)
            latest_day = max(daily)
            span_days = window_days
            active_days_per_week = active_days / span_days * 7
            weekly_miles = median_daily * active_days_per_week
            expected_days = remaining_miles / max(weekly_miles, 0.001) * 7
            p25 = max(_percentile(values, 0.25), 0.001)
            p75 = max(_percentile(values, 0.75), 0.001)
            fast_days = remaining_miles / max(p75 * active_days_per_week, 0.001) * 7
            slow_days = remaining_miles / max(p25 * active_days_per_week, 0.001) * 7
            confidence = (
                "medium"
                if active_days >= 12 and (now.date() - latest_day).days <= 30
                else "low"
            )
            forecast.update(
                {
                    "median_new_miles_per_active_day": round(median_daily, 3),
                    "active_days_per_week": round(active_days_per_week, 2),
                    "expected_completion_date": _pace_date(now, expected_days),
                    "completion_date_range": {
                        "earliest": _pace_date(now, fast_days),
                        "latest": _pace_date(now, slow_days),
                    },
                    "confidence": confidence,
                    "basis": f"Trailing {window_days} calendar days, including days without new coverage",
                    "last_progress_date": latest_day.isoformat(),
                },
            )

        if (
            remaining_miles > 0
            and forecast["available"]
            and forecast["expected_completion_date"] is None
        ):
            forecast.update(
                {
                    "available": False,
                    "confidence": "insufficient",
                    "reason": "Recent coverage pace does not support a useful completion date.",
                }
            )

        if goal and goal.target_date and remaining_miles > 0:
            days_until_target = max((goal.target_date - now).total_seconds() / 86400, 0)
            weeks_until_target = days_until_target / 7
            required_weekly = (
                remaining_miles / weeks_until_target if weeks_until_target > 0 else None
            )
            forecast["required_miles_per_week"] = (
                round(required_weekly, 3) if required_weekly is not None else None
            )
            median_daily = forecast.get("median_new_miles_per_active_day")
            if required_weekly is not None and median_daily:
                forecast["required_active_days_per_week"] = round(
                    required_weekly / median_daily,
                    2,
                )

        active_mission = await CoverageMission.find_one(
            {"area_id": area_id, "status": {"$in": list(MISSION_ACTIVE_STATES)}},
            sort=[("created_at", -1)],
        )
        return {
            "as_of": now.isoformat(),
            "area": {
                "id": str(area.id),
                "display_name": area.display_name,
                "area_version": area.area_version,
                "journal_revision": int(area.journal_revision or 0),
                "coverage_percentage": round(float(area.coverage_percentage or 0.0), 3),
                "driveable_miles": round(driveable_miles, 3),
                "driven_miles": round(driven_miles, 3),
                "remaining_miles": round(remaining_miles, 3),
            },
            "goal": _serialize_goal(goal),
            "forecast": forecast,
            "active_mission": (
                await _serialize_mission(active_mission) if active_mission else None
            ),
        }

    @staticmethod
    async def recommend_missions(
        area_id: PydanticObjectId,
        *,
        start_lat: float | None = None,
        start_lon: float | None = None,
        preferred_minutes: int | None = None,
        limit: int = 5,
    ) -> dict[str, Any]:
        area = await CoverageArea.get(area_id)
        if area is None:
            raise ValueError("Coverage area not found")
        goal = await CoverageIntelligenceService.get_goal(area_id)
        requested_minutes = min(
            max(
                int(
                    preferred_minutes
                    or (goal.preferred_mission_minutes if goal else 90)
                ),
                15,
            ),
            480,
        )
        if start_lon is None or start_lat is None:
            bounds = area.bounding_box or []
            if len(bounds) != 4:
                raise ValueError("A start location is required for this coverage area")
            start_lon = (float(bounds[0]) + float(bounds[2])) / 2
            start_lat = (float(bounds[1]) + float(bounds[3])) / 2

        suggestions = await DrivingService.suggest_next_street(
            area_id,
            start_lat,
            start_lon,
            top_n=min(max(limit, 1), 5),
            min_cluster_size=1,
        )
        clusters = suggestions.get("suggested_clusters") or []
        recommendations: list[dict[str, Any]] = []
        for cluster in clusters:
            target_miles = float(cluster.get("total_length_m") or 0.0) * MILES_PER_METER
            deadhead_miles = (
                float(cluster.get("distance_to_cluster_m") or 0.0) * MILES_PER_METER * 2
            )
            estimated_total_miles = target_miles + deadhead_miles
            estimated_minutes = estimated_total_miles / DEFAULT_COVERAGE_SPEED_MPH * 60
            segments = cluster.get("segments") or []
            segment_ids = [
                str(item.get("segment_id"))
                for item in segments
                if item.get("segment_id")
            ]
            if not segment_ids:
                continue
            gain = (
                target_miles
                / max(float(area.driveable_length_miles or 0.0), 0.001)
                * 100
            )
            recommendations.append(
                {
                    "candidate_id": f"cluster-{cluster.get('cluster_id', len(recommendations))}",
                    "segment_ids": segment_ids,
                    "segment_count": len(segment_ids),
                    "street_names": sorted(
                        {
                            str(item.get("street_name"))
                            for item in segments
                            if item.get("street_name")
                        }
                    )[:12],
                    "target_miles": round(target_miles, 3),
                    "estimated_total_miles": round(estimated_total_miles, 3),
                    "estimated_duration_minutes": round(estimated_minutes, 1),
                    "within_requested_duration": estimated_minutes
                    <= requested_minutes * 1.15,
                    "predicted_coverage_gain": round(gain, 3),
                    "predicted_coverage_after": round(
                        min(float(area.coverage_percentage or 0.0) + gain, 100.0),
                        3,
                    ),
                    "efficiency_score": round(
                        target_miles / max(estimated_total_miles, 0.001),
                        4,
                    ),
                    "confidence": "low",
                    "estimate_basis": "cluster geometry plus 22 mph default",
                },
            )
        recommendations.sort(
            key=lambda item: (
                not item["within_requested_duration"],
                -float(item["efficiency_score"]),
                -float(item["target_miles"]),
            ),
        )
        return {
            "area_id": str(area.id),
            "area_version": area.area_version,
            "journal_revision": int(area.journal_revision or 0),
            "requested_minutes": requested_minutes,
            "start_location": {"latitude": start_lat, "longitude": start_lon},
            "recommendations": recommendations[:limit],
        }

    @staticmethod
    async def create_mission(
        area_id: PydanticObjectId,
        *,
        segment_ids: list[str],
        expected_area_version: int,
        expected_journal_revision: int,
        requested_minutes: int = 90,
        start_lat: float | None = None,
        start_lon: float | None = None,
    ) -> dict[str, Any]:
        area = await CoverageArea.get(area_id)
        if area is None:
            raise ValueError("Coverage area not found")
        if area.area_version != expected_area_version:
            raise ValueError("Coverage area changed; refresh mission recommendations")
        if int(area.journal_revision or 0) != expected_journal_revision:
            raise ValueError("Coverage changed; refresh mission recommendations")
        segment_ids = list(dict.fromkeys(str(value) for value in segment_ids if value))
        if not segment_ids or len(segment_ids) > 500:
            raise ValueError("Mission must contain between 1 and 500 segments")
        streets = await Street.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
                "segment_id": {"$in": segment_ids},
            },
        ).to_list()
        lengths = {
            street.segment_id: float(street.length_miles or 0.0) for street in streets
        }
        states = await CoverageState.find(
            {"area_id": area_id, "segment_id": {"$in": segment_ids}},
        ).to_list()
        unavailable = {
            state.segment_id
            for state in states
            if state.status in {"driven", "undriveable"}
        }
        usable_ids = [
            sid for sid in segment_ids if sid in lengths and sid not in unavailable
        ]
        if not usable_ids:
            raise ValueError("All proposed mission segments are already resolved")
        goal = await CoverageIntelligenceService.get_goal(area_id)
        if goal is None:
            await CoverageIntelligenceService.save_goal(area_id)
            goal = await CoverageIntelligenceService.get_goal(area_id)
        from street_coverage.intervals import covered_fraction

        baseline = {state.segment_id: state.intervals for state in states}
        target_miles = sum(
            lengths[sid] * (1 - covered_fraction(baseline.get(sid, [])))
            for sid in usable_ids
        )
        coverage_gain = (
            target_miles / max(float(area.driveable_length_miles or 0.0), 0.001) * 100
        )
        now = datetime.now(UTC)
        mission = CoverageMission(
            area_id=area_id,
            goal_id=goal.id if goal else None,
            area_version=area.area_version,
            journal_revision=int(area.journal_revision or 0),
            status="route_generating",
            target_segment_ids=usable_ids,
            baseline_intervals=baseline,
            mapped_segment_ids=usable_ids,
            start_location=(
                {"latitude": start_lat, "longitude": start_lon}
                if start_lat is not None and start_lon is not None
                else None
            ),
            requested_minutes=min(max(int(requested_minutes), 15), 480),
            target_miles=target_miles,
            estimated_duration_minutes=round(
                target_miles / DEFAULT_COVERAGE_SPEED_MPH * 60,
                1,
            ),
            estimate_basis="target miles at 22 mph before route optimization",
            predicted_coverage_gain=coverage_gain,
            predicted_coverage_after=min(
                float(area.coverage_percentage or 0.0) + coverage_gain,
                100.0,
            ),
            confidence="low",
        )
        await mission.insert()

        from routing.route_store import enqueue_generated_route

        try:
            result = await enqueue_generated_route(
                area, segment_ids=usable_ids, start_lon=start_lon, start_lat=start_lat
            )
            mission.route_job_id = result["task_id"]
            await mission.save()
        except Exception:
            mission.status = "failed"
            mission.updated_at = now
            await mission.save()
            raise
        return await _serialize_mission(mission)

    @staticmethod
    async def refresh_route_result(mission: CoverageMission) -> None:
        if mission.status != "route_generating" or not mission.route_job_id:
            return
        job = await Job.find_one(
            {"job_type": "optimal_route", "task_id": mission.route_job_id},
            sort=[("created_at", -1)],
        )
        if job is None:
            return
        if job.status in {"failed", "cancelled"}:
            mission.status = "failed"
            mission.updated_at = datetime.now(UTC)
            await mission.save()
            return
        if job.status not in {"completed", "success"} or not job.result:
            return
        from routing.route_store import get_generated_route

        mission.route_id = PydanticObjectId(job.result["route_id"])
        route = await get_generated_route(mission.route_id)
        mission.route_distance_miles = float(
            route.get("total_distance_miles")
            or route.get("route_distance_miles")
            or route.get("distance_miles")
            or float(route.get("total_distance_m") or 0.0) / 1609.344
        )
        if mission.route_distance_miles > 0:
            mission.estimated_duration_minutes = round(
                mission.route_distance_miles / DEFAULT_COVERAGE_SPEED_MPH * 60,
                1,
            )
            mission.estimate_basis = "optimized route distance at 22 mph"
            mission.confidence = "medium"
        mission.status = "ready"
        mission.updated_at = datetime.now(UTC)
        await mission.save()

    @staticmethod
    async def list_missions(
        area_id: PydanticObjectId,
        *,
        limit: int = 20,
        include_route: bool = False,
    ) -> list[dict[str, Any]]:
        missions = (
            await CoverageMission.find({"area_id": area_id})
            .sort(
                -CoverageMission.created_at,
            )
            .limit(min(max(limit, 1), 100))
            .to_list()
        )
        for mission in missions:
            await CoverageIntelligenceService.refresh_route_result(mission)
        return [
            await _serialize_mission(mission, include_route=include_route)
            for mission in missions
        ]

    @staticmethod
    async def get_mission(
        mission_id: PydanticObjectId,
        *,
        include_route: bool = False,
    ) -> dict[str, Any]:
        mission = await CoverageMission.get(mission_id)
        if mission is None:
            raise ValueError("Coverage mission not found")
        await CoverageIntelligenceService.refresh_route_result(mission)
        return await _serialize_mission(mission, include_route=include_route)

    @staticmethod
    async def transition_mission(
        mission_id: PydanticObjectId,
        action: Literal["start", "finish", "cancel"],
    ) -> dict[str, Any]:
        mission = await CoverageMission.get(mission_id)
        if mission is None:
            raise ValueError("Coverage mission not found")
        await CoverageIntelligenceService.refresh_route_result(mission)
        area = await CoverageArea.get(mission.area_id)
        if area is None or area.area_version != mission.area_version:
            mission.status = "stale"
            mission.updated_at = datetime.now(UTC)
            await mission.save()
            raise ValueError("Coverage mission is stale because the area changed")
        now = datetime.now(UTC)
        if action == "start":
            if mission.status != "ready":
                raise ValueError("Only a ready mission can be started")
            mission.status = "active"
            mission.started_at = now
        elif action == "finish":
            if mission.status != "active":
                raise ValueError("Only an active mission can be finished")
            ratio = (
                mission.actual_new_miles / mission.target_miles
                if mission.target_miles > 0
                else 0.0
            )
            mission.status = (
                "completed" if ratio >= MISSION_COMPLETION_RATIO else "partial"
            )
            mission.completed_at = now
        elif action == "cancel":
            if mission.status not in MISSION_ACTIVE_STATES:
                raise ValueError("This mission can no longer be cancelled")
            mission.status = "cancelled"
            mission.completed_at = now
        mission.updated_at = now
        await mission.save()
        return await _serialize_mission(mission)

    @staticmethod
    async def reconcile_historical_trip(
        *, area_id, area_version, trip_id, newly_driven_segment_ids
    ):
        from street_coverage import transactions
        from street_coverage.intervals import covered_fraction, union_intervals
        from core.date_utils import normalize_to_utc_datetime

        missions = await CoverageMission.find(
            {"area_id": area_id, "status": {"$in": ["active", "completed", "partial"]}}
        ).to_list()
        for candidate in missions:

            async def reconcile(session):
                now = datetime.now(UTC)
                collection = CoverageMission.get_pymongo_collection()
                await collection.update_one(
                    {"_id": candidate.id},
                    {"$set": {"updated_at": now}},
                    session=session,
                )
                mission = await CoverageMission.get(candidate.id, session=session)
                area = await CoverageArea.get(area_id, session=session)
                if mission is None or area is None:
                    return
                if mission.area_version != area.area_version:
                    await collection.update_one(
                        {"_id": mission.id},
                        {"$set": {"status": "stale"}},
                        session=session,
                    )
                    return
                if not mission.started_at:
                    return
                targets = mission.mapped_segment_ids or mission.target_segment_ids
                window = {"$gte": normalize_to_utc_datetime(mission.started_at)}
                if mission.completed_at:
                    window["$lte"] = normalize_to_utc_datetime(mission.completed_at)
                events = await CoverageDriveEvent.find(
                    {
                        "area_id": area_id,
                        "area_version": area.area_version,
                        "segment_ids": {"$in": targets},
                        "driven_at": window,
                    },
                    session=session,
                ).to_list()
                streets = await Street.find(
                    {
                        "area_id": area_id,
                        "area_version": area.area_version,
                        "segment_id": {"$in": targets},
                    },
                    session=session,
                ).to_list()
                accumulated = {}
                for event in events:
                    for sid, intervals in event.segment_intervals.items():
                        if sid in targets:
                            accumulated[sid] = union_intervals(
                                [*accumulated.get(sid, []), *intervals]
                            )
                miles = 0.0
                completed = []
                for street in streets:
                    baseline = mission.baseline_intervals.get(street.segment_id, [])
                    union = union_intervals(
                        [*baseline, *accumulated.get(street.segment_id, [])]
                    )
                    miles += (
                        max(0.0, covered_fraction(union) - covered_fraction(baseline))
                        * street.length_miles
                    )
                    if covered_fraction(union) >= 1 - 1e-9:
                        completed.append(street.segment_id)
                ratio = (
                    miles / mission.target_miles if mission.target_miles > 0 else 0.0
                )
                status = (
                    "completed"
                    if ratio >= MISSION_COMPLETION_RATIO
                    else "partial"
                    if mission.completed_at
                    else "active"
                )
                await collection.update_one(
                    {"_id": mission.id},
                    {
                        "$set": {
                            "completed_segment_ids": sorted(completed),
                            "actual_trip_ids": sorted(
                                {event.trip_id for event in events}, key=str
                            ),
                            "actual_new_miles": miles,
                            "actual_coverage_gain": miles
                            / area.driveable_length_miles
                            * 100
                            if area.driveable_length_miles
                            else 0,
                            "status": status,
                            "completed_at": now
                            if status == "completed" and not mission.completed_at
                            else mission.completed_at,
                        }
                    },
                    session=session,
                )

            await transactions.run_transaction(reconcile)


__all__ = ["CoverageIntelligenceService"]
