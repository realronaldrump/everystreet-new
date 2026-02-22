from __future__ import annotations

import json
import logging
import shutil
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from beanie import PydanticObjectId
from fastapi import HTTPException

from core.spatial import GeometryService, extract_timestamps_for_coordinates
from core.trip_source_policy import enforce_bouncie_source
from db import CoverageArea, CoverageState, Street, Trip, build_calendar_date_expr
from db.models import Job
from exports.constants import (
    EXPORT_DEFAULT_FORMAT,
    EXPORT_FORMATS_BY_ENTITY,
    EXPORT_SPEC_VERSION,
    EXPORT_SUBDIR_BY_ENTITY,
    TRIP_CSV_FIELDS,
)
from exports.serializers import (
    normalize_value,
    serialize_boundary_properties,
    serialize_street_properties,
    serialize_trip_base,
    serialize_trip_properties,
    serialize_trip_record,
)
from exports.services.export_writer import (
    write_csv,
    write_geojson_features,
    write_gpx_tracks,
    write_json_array,
)

if TYPE_CHECKING:
    from exports.models import ExportItem, ExportRequest

logger = logging.getLogger(__name__)

EXPORT_ROOT = Path("cache") / "exports"
EXPORT_RETENTION_DAYS = 7
PROGRESS_UPDATE_EVERY = 500


class ExportProgress:
    def __init__(self, job: Job, total_records: int) -> None:
        self.job = job
        self.total_records = total_records
        self.processed = 0
        self.last_update = 0

    async def bump(self, count: int, message: str | None = None) -> None:
        self.processed += count
        if self.total_records:
            progress = min(100.0, (self.processed / self.total_records) * 100.0)
        else:
            progress = self.job.progress

        if (
            self.processed - self.last_update >= PROGRESS_UPDATE_EVERY
            or self.processed == self.total_records
        ):
            await ExportService._update_job(
                self.job,
                progress=progress,
                message=message,
            )
            self.last_update = self.processed


class ExportService:
    @staticmethod
    def _normalize_item(item: ExportItem) -> dict[str, Any]:
        fmt = item.format or EXPORT_DEFAULT_FORMAT.get(item.entity)
        if fmt not in EXPORT_FORMATS_BY_ENTITY.get(item.entity, set()):
            msg = f"Unsupported format '{fmt}' for entity '{item.entity}'."
            raise ValueError(msg)

        include_geometry = item.include_geometry
        if include_geometry is None:
            include_geometry = fmt != "csv"
        if fmt == "gpx":
            include_geometry = True

        return {
            "entity": item.entity,
            "format": fmt,
            "include_geometry": include_geometry,
        }

    @classmethod
    async def create_job(
        cls,
        request: ExportRequest,
        owner_key: str,
    ) -> Job:
        now = datetime.now(UTC)
        items = [cls._normalize_item(item) for item in request.items]

        spec: dict[str, Any] = {
            "items": items,
            "trip_filters": (
                request.trip_filters.model_dump() if request.trip_filters else None
            ),
            "area_id": str(request.area_id) if request.area_id else None,
            "created_at": now.isoformat(),
        }

        job = Job(
            job_type="export",
            owner_key=owner_key,
            status="pending",
            stage="queued",
            progress=0.0,
            message="Queued",
            spec=spec,
            created_at=now,
            updated_at=now,
            expires_at=now + timedelta(days=EXPORT_RETENTION_DAYS),
        )
        await job.insert()
        return job

    @classmethod
    async def run_job(cls, job_id: str) -> None:
        job = await Job.get(job_id)
        if not job or job.job_type != "export":
            logger.error("Export job %s not found", job_id)
            return

        try:
            await cls._update_job(
                job,
                status="running",
                message="Preparing export",
                progress=0.0,
                started_at=datetime.now(UTC),
            )

            export_dir = cls._prepare_export_dir(job_id)
            results = await cls._write_exports(job, export_dir)

            manifest_path = export_dir / "manifest.json"
            cls._write_manifest(job, results, manifest_path)

            zip_path = cls._build_zip(export_dir, job_id)
            artifact_size = zip_path.stat().st_size if zip_path.exists() else None

            result_payload = {
                "artifact_name": zip_path.name,
                "artifact_path": str(zip_path),
                "artifact_size_bytes": artifact_size,
                "records": results.get("records", {}),
                "files": results.get("files", []),
            }

            await cls._update_job(
                job,
                status="completed",
                progress=100.0,
                message="Export ready",
                completed_at=datetime.now(UTC),
                result=result_payload,
            )

        except Exception as exc:
            logger.exception("Export job %s failed", job_id)
            await cls._update_job(
                job,
                status="failed",
                message="Export failed",
                error=str(exc),
                completed_at=datetime.now(UTC),
            )
        finally:
            cls._cleanup_export_dir(job_id)

    @staticmethod
    async def _update_job(
        job: Job,
        *,
        status: str | None = None,
        progress: float | None = None,
        message: str | None = None,
        error: str | None = None,
        result: dict[str, Any] | None = None,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
    ) -> None:
        if status is not None:
            job.status = status
            if status == "running":
                job.stage = "running"
            elif status in {"completed", "failed"}:
                job.stage = status
        if progress is not None:
            job.progress = float(progress)
        if message is not None:
            job.message = message
        if error is not None:
            job.error = error
        if result is not None:
            job.result = result
        if started_at is not None:
            job.started_at = started_at
        if completed_at is not None:
            job.completed_at = completed_at
        job.updated_at = datetime.now(UTC)
        await job.save()

    @classmethod
    async def _write_exports(
        cls,
        job: Job,
        export_dir: Path,
    ) -> dict[str, Any]:
        spec = job.spec or {}
        items = spec.get("items", [])
        trip_filters = spec.get("trip_filters") or {}
        area_id = spec.get("area_id")

        area = None
        if area_id:
            area = await CoverageArea.get(PydanticObjectId(area_id))
            if not area:
                raise HTTPException(status_code=404, detail="Coverage area not found")
            if area.status != "ready":
                raise HTTPException(
                    status_code=400,
                    detail=f"Coverage area is not ready (status: {area.status})",
                )

        total_records = await cls._estimate_total_records(items, trip_filters, area)
        progress = ExportProgress(job, total_records)

        records: dict[str, int] = {}
        files: list[dict[str, Any]] = []

        for item in items:
            entity = item["entity"]
            fmt = item["format"]
            include_geometry = item.get("include_geometry", True)

            await cls._update_job(job, message=f"Exporting {entity}...")

            file_path = cls._entity_file_path(export_dir, entity, fmt)
            file_path.parent.mkdir(parents=True, exist_ok=True)

            count = await cls._write_entity(
                entity,
                fmt,
                file_path,
                trip_filters,
                area,
                include_geometry,
                progress,
            )

            records[entity] = count
            files.append(
                {
                    "entity": entity,
                    "format": fmt,
                    "filename": str(file_path.relative_to(export_dir)),
                    "record_count": count,
                },
            )

        return {"records": records, "files": files, "area": area}

    @classmethod
    async def _estimate_total_records(
        cls,
        items: list[dict[str, Any]],
        trip_filters: dict[str, Any],
        area: CoverageArea | None,
    ) -> int:
        total = 0
        for item in items:
            entity = item["entity"]
            if entity in {"trips", "matched_trips"}:
                query = cls._build_trip_query(trip_filters, entity == "matched_trips")
                total += await Trip.find(query).count()
            elif entity in {"streets", "undriven_streets"} and area:
                total += await Street.find(
                    {
                        "area_id": area.id,
                        "area_version": area.area_version,
                    },
                ).count()
            elif entity == "boundaries" and area:
                total += 1
        return total

    @classmethod
    async def _write_entity(
        cls,
        entity: str,
        fmt: str,
        file_path: Path,
        trip_filters: dict[str, Any],
        area: CoverageArea | None,
        include_geometry: bool,
        progress: ExportProgress,
    ) -> int:
        if entity in {"trips", "matched_trips"}:
            return await cls._write_trip_export(
                entity,
                fmt,
                file_path,
                trip_filters,
                include_geometry,
                progress,
            )
        if entity == "streets":
            return await cls._write_street_export(file_path, area, None, progress)
        if entity == "undriven_streets":
            return await cls._write_street_export(
                file_path,
                area,
                "undriven",
                progress,
            )
        if entity == "boundaries":
            return await cls._write_boundary_export(file_path, area, progress)

        msg = f"Unsupported export entity '{entity}'."
        raise ValueError(msg)

    @classmethod
    async def _write_trip_export(
        cls,
        entity: str,
        fmt: str,
        file_path: Path,
        trip_filters: dict[str, Any],
        include_geometry: bool,
        progress: ExportProgress,
    ) -> int:
        matched_only = entity == "matched_trips"
        query = cls._build_trip_query(trip_filters, matched_only)
        cursor = Trip.find(query).sort(Trip.startTime)

        if fmt == "json":
            return await write_json_array(
                file_path,
                cursor,
                lambda trip: serialize_trip_record(
                    trip,
                    include_geometry=include_geometry,
                ),
                progress.bump,
            )
        if fmt == "csv":

            def serializer(trip: Any) -> dict[str, Any]:
                record = serialize_trip_record(
                    trip,
                    include_geometry=include_geometry,
                )
                if not include_geometry:
                    record["gps"] = None
                    record["matchedGps"] = None
                return record

            return await write_csv(
                file_path,
                cursor,
                TRIP_CSV_FIELDS,
                serializer,
                progress.bump,
            )
        if fmt == "gpx":
            geometry_field = "matchedGps" if matched_only else "gps"

            def serializer(trip: Any) -> dict[str, Any]:
                geometry = GeometryService.parse_geojson(
                    getattr(trip, geometry_field, None),
                )
                coords: list[list[float]] = []
                if geometry:
                    geom_type = geometry.get("type")
                    raw_coords = geometry.get("coordinates")
                    if geom_type == "Point":
                        raw_coords = (
                            [raw_coords] if isinstance(raw_coords, list) else []
                        )
                    elif geom_type == "LineString":
                        raw_coords = raw_coords if isinstance(raw_coords, list) else []
                    else:
                        raw_coords = []

                    for coord in raw_coords:
                        is_valid, pair = GeometryService.validate_coordinate_pair(coord)
                        if is_valid and pair is not None:
                            coords.append(pair)

                timestamps: list[int | None] = []
                if coords:
                    timestamps = extract_timestamps_for_coordinates(
                        coords,
                        {
                            "coordinates": getattr(trip, "coordinates", None),
                            "startTime": getattr(trip, "startTime", None),
                            "endTime": getattr(trip, "endTime", None),
                        },
                    )

                base = serialize_trip_base(trip)
                trip_id = base.get("tripId") or base.get("transactionId")
                name = f"Trip {trip_id}" if trip_id else None

                description_parts = []
                if base.get("startTime"):
                    description_parts.append(f"start: {base['startTime']}")
                if base.get("endTime"):
                    description_parts.append(f"end: {base['endTime']}")
                if base.get("distance") is not None:
                    description_parts.append(f"distance_mi: {base['distance']}")
                if base.get("imei"):
                    description_parts.append(f"imei: {base['imei']}")
                if base.get("vin"):
                    description_parts.append(f"vin: {base['vin']}")
                description = (
                    " | ".join(description_parts) if description_parts else None
                )

                return {
                    "coordinates": coords,
                    "timestamps": timestamps,
                    "name": name,
                    "description": description,
                }

            return await write_gpx_tracks(
                file_path,
                cursor,
                serializer,
                progress.bump,
            )
        if fmt == "geojson":
            geometry_field = "matchedGps" if matched_only else "gps"

            async def features():
                async for trip in cursor:
                    geometry = GeometryService.parse_geojson(
                        getattr(trip, geometry_field, None),
                    )
                    props = serialize_trip_properties(trip)
                    yield GeometryService.feature_from_geometry(geometry, props)
                    await progress.bump(1)

            return await write_geojson_features(file_path, features())

        msg = f"Unsupported trip export format '{fmt}'."
        raise ValueError(msg)

    @classmethod
    async def _write_street_export(
        cls,
        file_path: Path,
        area: CoverageArea | None,
        status_filter: str | None,
        progress: ExportProgress,
    ) -> int:
        if not area:
            msg = "Coverage area is required for street exports."
            raise ValueError(msg)

        states = await CoverageState.find({"area_id": area.id}).to_list()
        state_map = {state.segment_id: state for state in states}

        streets = Street.find(
            {
                "area_id": area.id,
                "area_version": area.area_version,
            },
        ).sort(Street.segment_id)

        async def features():
            async for street in streets:
                state = state_map.get(street.segment_id)
                status = state.status if state else "undriven"
                if status_filter and status != status_filter:
                    await progress.bump(1)
                    continue
                props = serialize_street_properties(street, state)
                yield GeometryService.feature_from_geometry(street.geometry, props)
                await progress.bump(1)

        return await write_geojson_features(file_path, features())

    @classmethod
    async def _write_boundary_export(
        cls,
        file_path: Path,
        area: CoverageArea | None,
        progress: ExportProgress,
    ) -> int:
        if not area:
            msg = "Coverage area is required for boundary exports."
            raise ValueError(msg)

        async def features():
            yield GeometryService.feature_from_geometry(
                normalize_value(area.boundary),
                serialize_boundary_properties(area),
            )
            await progress.bump(1)

        return await write_geojson_features(file_path, features())

    @staticmethod
    def _build_trip_query(
        filters: dict[str, Any],
        matched_only: bool,
    ) -> dict[str, Any]:
        query: dict[str, Any] = {}
        if filters:
            start_date = filters.get("start_date")
            end_date = filters.get("end_date")
            date_expr = build_calendar_date_expr(
                start_date,
                end_date,
                date_field="startTime",
            )
            if date_expr:
                query["$expr"] = date_expr

            if filters.get("imei"):
                query["imei"] = filters["imei"]
            if filters.get("status"):
                query["status"] = {"$in": filters["status"]}
            if not filters.get("include_invalid", False):
                query["invalid"] = {"$ne": True}
        else:
            query["invalid"] = {"$ne": True}

        if matched_only:
            query["matchedGps"] = {"$ne": None}

        return enforce_bouncie_source(query)

    @staticmethod
    def _prepare_export_dir(job_id: str) -> Path:
        export_dir = EXPORT_ROOT / job_id
        export_dir.mkdir(parents=True, exist_ok=True)
        return export_dir

    @staticmethod
    def _build_zip(export_dir: Path, job_id: str) -> Path:
        EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
        zip_path = EXPORT_ROOT / f"export_{job_id}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_path in export_dir.rglob("*"):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(export_dir))
        return zip_path

    @staticmethod
    def _cleanup_export_dir(job_id: str) -> None:
        export_dir = EXPORT_ROOT / job_id
        if export_dir.exists():
            shutil.rmtree(export_dir, ignore_errors=True)

    @staticmethod
    def _entity_file_path(export_dir: Path, entity: str, fmt: str) -> Path:
        subdir = EXPORT_SUBDIR_BY_ENTITY.get(entity, "")
        filename = f"{entity}.{fmt}"
        if subdir:
            return export_dir / subdir / filename
        return export_dir / filename

    @staticmethod
    def _write_manifest(job: Job, results: dict[str, Any], path: Path) -> None:
        area = results.get("area")
        manifest = {
            "spec_version": EXPORT_SPEC_VERSION,
            "generated_at": datetime.now(UTC).isoformat(),
            "job_id": str(job.id),
            "owner_key": job.owner_key,
            "filters": job.spec.get("trip_filters") if job.spec else None,
            "area": (
                {
                    "id": str(area.id),
                    "display_name": area.display_name,
                    "area_version": area.area_version,
                }
                if area
                else None
            ),
            "items": results.get("files", []),
        }

        path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=True),
            encoding="utf-8",
        )
