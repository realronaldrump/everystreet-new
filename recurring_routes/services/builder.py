"""Recurring route builder.

Groups stored trips into stable route templates (RecurringRoute) and assigns trips to
their template via Trip.recurringRouteId.
"""

from __future__ import annotations

import logging
import statistics
from collections import Counter
from datetime import UTC, datetime
from typing import Any

from beanie.operators import In
from pydantic import BaseModel, ConfigDict

from core.casting import safe_float
from core.jobs import JobHandle, create_job, find_job
from core.spatial import GeometryService
from db.models import Job, RecurringRoute, Trip
from recurring_routes.models import BuildRecurringRoutesRequest
from recurring_routes.services.fingerprint import (
    build_preview_svg_path,
    compute_route_key,
    compute_route_signature,
    extract_display_label,
    extract_polyline,
)
from trips.services.trip_cost_service import TripCostService

logger = logging.getLogger(__name__)

TERMINAL_STAGES = {"completed", "failed", "error", "cancelled"}


class TripRouteBuildProjection(BaseModel):
    transactionId: str | None = None
    imei: str | None = None
    startTime: datetime | None = None
    endTime: datetime | None = None
    duration: float | None = None
    distance: float | None = None
    fuelConsumed: float | None = None
    maxSpeed: float | None = None

    matchedGps: dict[str, Any] | None = None
    gps: dict[str, Any] | None = None
    coordinates: list[dict[str, Any]] | None = None

    startGeoPoint: dict[str, Any] | None = None
    destinationGeoPoint: dict[str, Any] | None = None

    # Stored as "extra" fields on Trip documents; included here for labels.
    startLocation: Any | None = None
    destination: Any | None = None
    destinationPlaceName: str | None = None

    model_config = ConfigDict(extra="ignore")


def _median(values: list[float]) -> float | None:
    cleaned = [float(v) for v in values if isinstance(v, (int, float))]
    if not cleaned:
        return None
    try:
        return float(statistics.median(cleaned))
    except statistics.StatisticsError:
        return None


def _avg(values: list[float]) -> float | None:
    cleaned = [float(v) for v in values if isinstance(v, (int, float))]
    if not cleaned:
        return None
    return float(sum(cleaned) / len(cleaned))


def _best_label(counter: Counter[str]) -> str:
    if not counter:
        return "Unknown"
    value, _ = counter.most_common(1)[0]
    return value or "Unknown"


def _extract_representative_geometry(trip_dict: dict[str, Any]) -> dict[str, Any] | None:
    geom = GeometryService.parse_geojson(trip_dict.get("matchedGps")) or GeometryService.parse_geojson(
        trip_dict.get("gps"),
    )
    if geom:
        return geom

    coords = trip_dict.get("coordinates")
    if isinstance(coords, list) and coords:
        pairs: list[list[Any]] = []
        for item in coords:
            if not isinstance(item, dict):
                continue
            lon = item.get("lon")
            lat = item.get("lat")
            if lon is None:
                lon = item.get("lng")
            if lon is None or lat is None:
                continue
            pairs.append([lon, lat])
        return GeometryService.geometry_from_coordinate_pairs(
            pairs,
            allow_point=False,
            dedupe=True,
            validate=True,
        )

    return None


def _extract_start_end_points(trip_dict: dict[str, Any]) -> tuple[list[float] | None, list[float] | None]:
    start_geo = trip_dict.get("startGeoPoint")
    dest_geo = trip_dict.get("destinationGeoPoint")
    start_pt = None
    end_pt = None

    if isinstance(start_geo, dict) and start_geo.get("type") == "Point":
        coords = start_geo.get("coordinates")
        valid, pair = GeometryService.validate_coordinate_pair(coords or [])
        if valid and pair:
            start_pt = pair

    if isinstance(dest_geo, dict) and dest_geo.get("type") == "Point":
        coords = dest_geo.get("coordinates")
        valid, pair = GeometryService.validate_coordinate_pair(coords or [])
        if valid and pair:
            end_pt = pair

    if start_pt is not None and end_pt is not None:
        return start_pt, end_pt

    poly = extract_polyline(trip_dict)
    if len(poly) >= 2:
        start_pt = start_pt or poly[0]
        end_pt = end_pt or poly[-1]

    return start_pt, end_pt


def _extract_labels(trip_dict: dict[str, Any]) -> tuple[str | None, str | None]:
    start_label = extract_display_label(trip_dict.get("startLocation"))

    end_label = None
    place_name = trip_dict.get("destinationPlaceName")
    if isinstance(place_name, str) and place_name.strip():
        end_label = place_name.strip()
    if end_label is None:
        end_label = extract_display_label(trip_dict.get("destination"))

    return start_label, end_label


async def _job_cancelled(job: Job | None) -> bool:
    if not job or not job.id:
        return False
    refreshed = await Job.get(job.id)
    if not refreshed:
        return False
    stage = (refreshed.stage or "").lower()
    status = (refreshed.status or "").lower()
    return stage == "cancelled" or status == "cancelled"


class RecurringRoutesBuilder:
    """Build RecurringRoute templates and assign trips."""

    async def _get_or_create_progress(self, job_id: str) -> Job:
        progress = await find_job("recurring_routes_build", operation_id=job_id)
        if progress:
            return progress
        # Defensive: create progress record if API didn't create one.
        progress_handle = await create_job(
            "recurring_routes_build",
            operation_id=job_id,
            task_id=job_id,
            status="queued",
            stage="queued",
            progress=0.0,
            message="Queued recurring routes build",
            started_at=datetime.now(UTC),
            metadata={},
        )
        return progress_handle.job

    async def run(self, job_id: str, request: BuildRecurringRoutesRequest) -> dict[str, Any]:
        params = request.model_dump()
        now = datetime.now(UTC)

        progress = await self._get_or_create_progress(job_id)
        handle = JobHandle(progress)

        await handle.update(
            status="running",
            stage="scanning",
            progress=0.0,
            message="Preparing to build recurring routes...",
            started_at=progress.started_at or now,
            metadata_patch={"params": params},
        )

        try:
            # Compute total upfront for progress; avoids a second scan later.
            query = {"invalid": {"$ne": True}}
            total_trips = await Trip.find(query).count()

            await handle.update(
                stage="fingerprinting",
                message=f"Loading gas price history and fingerprinting {total_trips} trips...",
                metadata_patch={"total_trips": total_trips},
            )

            # Load gas fill-ups once for cost estimation.
            price_map = await TripCostService.get_fillup_price_map()

            # route_key -> aggregation
            groups: dict[str, dict[str, Any]] = {}

            processed = 0
            usable = 0

            # Iterate trips using a minimal projection.
            cursor = Trip.find(query).project(TripRouteBuildProjection)
            async for trip in cursor:
                processed += 1
                if processed % 300 == 0 and await _job_cancelled(progress):
                    await handle.update(
                        status="cancelled",
                        stage="cancelled",
                        progress=0.0,
                        message="Cancelled",
                        completed_at=datetime.now(UTC),
                    )
                    return {"status": "cancelled", "processed": processed, "usable": usable}

                trip_dict = trip.model_dump()
                signature = compute_route_signature(trip_dict, params)
                if not signature:
                    continue
                route_key = compute_route_key(signature)

                transaction_id = (trip_dict.get("transactionId") or "").strip()
                if not transaction_id:
                    continue

                usable += 1
                group = groups.get(route_key)
                if group is None:
                    group = {
                        "route_key": route_key,
                        "route_signature": signature,
                        "trip_ids": [],
                        "start_labels": Counter(),
                        "end_labels": Counter(),
                        "start_sum": [0.0, 0.0],
                        "start_count": 0,
                        "end_sum": [0.0, 0.0],
                        "end_count": 0,
                        "vehicle_imeis": set(),
                        "distances": [],
                        "durations": [],
                        "fuel": [],
                        "costs": [],
                        "max_speed_max": None,
                        "first_start_time": None,
                        "last_start_time": None,
                        "rep_trip_id": None,
                        "rep_start_time": None,
                        "rep_geometry": None,
                        "rep_preview": None,
                    }
                    groups[route_key] = group

                group["trip_ids"].append(transaction_id)

                imei = trip_dict.get("imei")
                if isinstance(imei, str) and imei.strip():
                    group["vehicle_imeis"].add(imei.strip())

                start_label, end_label = _extract_labels(trip_dict)
                if start_label:
                    group["start_labels"][start_label] += 1
                if end_label:
                    group["end_labels"][end_label] += 1

                start_pt, end_pt = _extract_start_end_points(trip_dict)
                if start_pt:
                    group["start_sum"][0] += float(start_pt[0])
                    group["start_sum"][1] += float(start_pt[1])
                    group["start_count"] += 1
                if end_pt:
                    group["end_sum"][0] += float(end_pt[0])
                    group["end_sum"][1] += float(end_pt[1])
                    group["end_count"] += 1

                dist = trip_dict.get("distance")
                if isinstance(dist, (int, float)) and dist >= 0:
                    group["distances"].append(float(dist))

                duration = trip_dict.get("duration")
                if isinstance(duration, (int, float)) and duration >= 0:
                    group["durations"].append(float(duration))
                else:
                    st = trip_dict.get("startTime")
                    et = trip_dict.get("endTime")
                    if st and et:
                        try:
                            delta = (et - st).total_seconds()
                            if delta >= 0:
                                group["durations"].append(float(delta))
                        except Exception:
                            pass

                fuel = trip_dict.get("fuelConsumed")
                if isinstance(fuel, (int, float)) and fuel > 0:
                    group["fuel"].append(float(fuel))

                max_speed = trip_dict.get("maxSpeed")
                if isinstance(max_speed, (int, float)) and max_speed >= 0:
                    prev = group.get("max_speed_max")
                    group["max_speed_max"] = float(max_speed) if prev is None else max(prev, float(max_speed))

                trip_cost = TripCostService.calculate_trip_cost(trip_dict, price_map)
                if isinstance(trip_cost, (int, float)) and trip_cost > 0:
                    group["costs"].append(float(trip_cost))

                st = trip_dict.get("startTime")
                if isinstance(st, datetime):
                    if group["first_start_time"] is None or st < group["first_start_time"]:
                        group["first_start_time"] = st
                    if group["last_start_time"] is None or st > group["last_start_time"]:
                        group["last_start_time"] = st

                # Representative trip: most recent trip with a usable geometry.
                rep_start = group.get("rep_start_time")
                if isinstance(st, datetime) and (rep_start is None or st > rep_start):
                    rep_geom = _extract_representative_geometry(trip_dict)
                    if rep_geom:
                        group["rep_trip_id"] = transaction_id
                        group["rep_start_time"] = st
                        group["rep_geometry"] = rep_geom
                        group["rep_preview"] = build_preview_svg_path(rep_geom)

                if total_trips > 0 and processed % 250 == 0:
                    pct = min(60.0, (processed / total_trips) * 60.0)
                    await handle.update(
                        progress=pct,
                        message=f"Fingerprinting trips... ({processed}/{total_trips})",
                        metadata_patch={"processed_trips": processed, "usable_trips": usable},
                    )

            await handle.update(
                stage="grouping",
                progress=60.0,
                message=f"Grouping trips into routes... ({len(groups)} candidates)",
                metadata_patch={"groups": len(groups)},
            )

            min_assign = max(1, int(params.get("min_assign_trips") or 2))
            min_recurring = max(1, int(params.get("min_recurring_trips") or 3))

            eligible_keys = [k for k, g in groups.items() if len(g.get("trip_ids") or []) >= min_assign]

            await handle.update(
                stage="upserting_routes",
                progress=60.0,
                message=f"Upserting {len(eligible_keys)} route templates...",
                metadata_patch={"eligible_routes": len(eligible_keys)},
            )

            existing_routes = (
                await RecurringRoute.find(In(RecurringRoute.route_key, eligible_keys)).to_list()
                if eligible_keys
                else []
            )
            existing_by_key = {r.route_key: r for r in existing_routes if r.route_key}

            seen_keys: set[str] = set()
            route_id_by_key: dict[str, Any] = {}

            created = 0
            updated = 0

            for idx, key in enumerate(eligible_keys, 1):
                if idx % 25 == 0 and await _job_cancelled(progress):
                    await handle.update(
                        status="cancelled",
                        stage="cancelled",
                        progress=0.0,
                        message="Cancelled",
                        completed_at=datetime.now(UTC),
                    )
                    return {"status": "cancelled", "processed": processed, "usable": usable}

                group = groups[key]
                trip_ids: list[str] = list(group.get("trip_ids") or [])
                trip_count = len(trip_ids)

                start_label = _best_label(group.get("start_labels") or Counter())
                end_label = _best_label(group.get("end_labels") or Counter())
                auto_name = f"{start_label} → {end_label}"

                start_centroid = []
                if group.get("start_count"):
                    start_centroid = [
                        group["start_sum"][0] / group["start_count"],
                        group["start_sum"][1] / group["start_count"],
                    ]

                end_centroid = []
                if group.get("end_count"):
                    end_centroid = [
                        group["end_sum"][0] / group["end_count"],
                        group["end_sum"][1] / group["end_count"],
                    ]

                dist_med = _median(group.get("distances") or [])
                dist_avg = _avg(group.get("distances") or [])
                dur_med = _median(group.get("durations") or [])
                dur_avg = _avg(group.get("durations") or [])
                fuel_avg = _avg(group.get("fuel") or [])
                cost_avg = _avg(group.get("costs") or [])
                max_speed_max = group.get("max_speed_max")

                rep_trip_id = group.get("rep_trip_id") or (trip_ids[-1] if trip_ids else None)
                rep_geom = group.get("rep_geometry")
                preview = group.get("rep_preview")

                route = existing_by_key.get(key)
                if route:
                    # Preserve customization fields across rebuilds
                    route.route_signature = str(group.get("route_signature") or route.route_signature)
                    route.algorithm_version = int(params.get("algorithm_version") or route.algorithm_version or 1)
                    route.params = params
                    route.auto_name = auto_name
                    route.start_label = start_label
                    route.end_label = end_label
                    route.start_centroid = start_centroid
                    route.end_centroid = end_centroid
                    route.trip_count = trip_count
                    route.is_recurring = trip_count >= min_recurring
                    route.first_start_time = group.get("first_start_time")
                    route.last_start_time = group.get("last_start_time")
                    route.vehicle_imeis = sorted(list(group.get("vehicle_imeis") or set()))
                    route.distance_miles_median = dist_med
                    route.distance_miles_avg = dist_avg
                    route.duration_sec_median = dur_med
                    route.duration_sec_avg = dur_avg
                    route.fuel_gal_avg = fuel_avg
                    route.cost_usd_avg = cost_avg
                    route.max_speed_mph_max = safe_float(max_speed_max, None) if max_speed_max is not None else None
                    route.representative_trip_id = rep_trip_id
                    route.geometry = rep_geom
                    route.preview_svg_path = preview
                    route.is_active = True
                    route.updated_at = now
                    await route.save()
                    updated += 1
                else:
                    route = RecurringRoute(
                        route_key=key,
                        route_signature=str(group.get("route_signature") or ""),
                        algorithm_version=int(params.get("algorithm_version") or 1),
                        params=params,
                        name=None,
                        auto_name=auto_name,
                        start_label=start_label,
                        end_label=end_label,
                        start_centroid=start_centroid,
                        end_centroid=end_centroid,
                        trip_count=trip_count,
                        is_recurring=trip_count >= min_recurring,
                        first_start_time=group.get("first_start_time"),
                        last_start_time=group.get("last_start_time"),
                        vehicle_imeis=sorted(list(group.get("vehicle_imeis") or set())),
                        distance_miles_median=dist_med,
                        distance_miles_avg=dist_avg,
                        duration_sec_median=dur_med,
                        duration_sec_avg=dur_avg,
                        fuel_gal_avg=fuel_avg,
                        cost_usd_avg=cost_avg,
                        max_speed_mph_max=safe_float(max_speed_max, None) if max_speed_max is not None else None,
                        representative_trip_id=rep_trip_id,
                        geometry=rep_geom,
                        preview_svg_path=preview,
                        is_pinned=False,
                        is_hidden=False,
                        is_active=True,
                        updated_at=now,
                    )
                    await route.insert()
                    created += 1

                seen_keys.add(key)
                route_id_by_key[key] = route.id

                if len(eligible_keys) > 0 and idx % 20 == 0:
                    pct = 60.0 + (idx / len(eligible_keys)) * 25.0
                    await handle.update(
                        progress=pct,
                        message=f"Upserting routes... ({idx}/{len(eligible_keys)})",
                        metadata_patch={"routes_created": created, "routes_updated": updated},
                    )

            # Deactivate routes not seen in this run.
            await handle.update(
                stage="updating_inactive",
                progress=85.0,
                message="Marking inactive routes...",
            )
            routes_coll = RecurringRoute.get_pymongo_collection()
            await routes_coll.update_many(
                {"is_active": True, "route_key": {"$nin": list(seen_keys)}},
                {"$set": {"is_active": False, "updated_at": now}},
            )

            # Assignment step
            await handle.update(
                stage="assigning_trips",
                progress=85.0,
                message="Assigning trips to routes...",
            )

            trips_coll = Trip.get_pymongo_collection()
            await trips_coll.update_many(
                # Keep the sparse index effective: sparse skips missing fields, not explicit nulls.
                {"recurringRouteId": {"$exists": True}},
                {"$unset": {"recurringRouteId": ""}},
            )

            assigned = 0
            for idx, key in enumerate(eligible_keys, 1):
                if idx % 25 == 0 and await _job_cancelled(progress):
                    await handle.update(
                        status="cancelled",
                        stage="cancelled",
                        progress=0.0,
                        message="Cancelled",
                        completed_at=datetime.now(UTC),
                    )
                    return {"status": "cancelled", "processed": processed, "usable": usable}

                route_id = route_id_by_key.get(key)
                if not route_id:
                    continue
                trip_ids = list(groups[key].get("trip_ids") or [])
                if not trip_ids:
                    continue

                chunk_size = 500
                for start in range(0, len(trip_ids), chunk_size):
                    chunk = trip_ids[start : start + chunk_size]
                    result = await trips_coll.update_many(
                        {"transactionId": {"$in": chunk}},
                        {"$set": {"recurringRouteId": route_id}},
                    )
                    assigned += int(getattr(result, "modified_count", 0) or 0)

                if len(eligible_keys) > 0 and idx % 20 == 0:
                    pct = 85.0 + (idx / len(eligible_keys)) * 15.0
                    await handle.update(
                        progress=pct,
                        message=f"Assigning trips... ({idx}/{len(eligible_keys)})",
                        metadata_patch={"trips_assigned": assigned},
                    )

            result = {
                "status": "success",
                "total_trips": total_trips,
                "processed_trips": processed,
                "usable_trips": usable,
                "eligible_routes": len(eligible_keys),
                "routes_created": created,
                "routes_updated": updated,
                "routes_active": len(seen_keys),
                "trips_assigned": assigned,
                "updated_at": now.isoformat(),
            }

            await handle.complete(
                message=f"Built {len(seen_keys)} routes; assigned {assigned} trips.",
                result=result,
                metadata_patch=result,
            )

            return result

        except Exception as exc:
            logger.exception("Recurring routes build failed")
            await handle.fail(str(exc), message="Build failed")
            raise
