"""Preview and import Bouncie trip files supplied by the owner."""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
import stat
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import PurePosixPath
from typing import Any, Literal

from beanie.operators import In

from core.bouncie_normalization import normalize_rest_trip_payload
from core.date_utils import parse_timestamp
from core.spatial import GeometryService, sanitize_geojson_geometry
from core.trip_map_cache import bump_trip_map_revision
from core.trip_source_policy import BOUNCIE_SOURCE
from db.models import Trip, Vehicle
from trips.models import TripStatusProjection
from trips.pipeline import TripPipeline
from trips.services.bouncie_ingest_runtime import (
    ingest_counters_changed_trips,
    process_bouncie_trips,
)

MAX_UPLOAD_CONTAINERS = 1000
MAX_SINGLE_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_TOTAL_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_JSON_FILE_BYTES = 10 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 5000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_COMPRESSION_RATIO = 200
MAX_ARCHIVE_MEMBER_NAME_LENGTH = 1000
MAX_IMPORT_BATCH_SIZE = 5

MIN_SUPPORTED_TRIP_TIME = datetime(2000, 1, 1, tzinfo=UTC)
MAX_FUTURE_CLOCK_SKEW = timedelta(days=1)
MAX_TRIP_DURATION = timedelta(days=7)
MAX_REASONABLE_SPEED_MPH = 200.0
VERY_SHORT_TRIP_MILES = 0.05

IssueSeverity = Literal["error", "warning", "info"]

_IMEI_PATTERN = re.compile(r"^[0-9]{14,16}$")
_BOUNCIE_TRANSACTION_ID_PATTERN = re.compile(r"^[0-9]{14,16}-[0-9]+-[0-9]+$")
_NUMERIC_FIELDS = {
    "distance": "Distance",
    "startOdometer": "Start odometer",
    "endOdometer": "End odometer",
    "averageSpeed": "Average speed",
    "avgSpeed": "Average speed",
    "maxSpeed": "Maximum speed",
    "fuelConsumed": "Fuel consumed",
    "totalIdleDuration": "Idle duration",
    "totalIdlingTime": "Idle duration",
}
_COUNT_FIELDS = {
    "hardBrakingCount": "Hard-braking count",
    "hardBrakingCounts": "Hard-braking count",
    "hardAccelerationCount": "Hard-acceleration count",
    "hardAccelerationCounts": "Hard-acceleration count",
}
_IMPORT_PAYLOAD_FIELDS = frozenset(
    {
        "transactionId",
        "imei",
        "gps",
        "startTime",
        "endTime",
        "timeZone",
        "distance",
        "startOdometer",
        "endOdometer",
        "averageSpeed",
        "avgSpeed",
        "maxSpeed",
        "fuelConsumed",
        "totalIdleDuration",
        "totalIdlingTime",
        "hardBrakingCount",
        "hardBrakingCounts",
        "hardAccelerationCount",
        "hardAccelerationCounts",
    }
)


class ManualTripImportError(ValueError):
    """A safe, user-facing upload or import failure."""


class _DuplicateJsonKeyError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class UploadedTripContainer:
    """One uploaded ZIP or JSON container already bounded by the API layer."""

    name: str
    content: bytes


@dataclass(frozen=True, slots=True)
class _LogicalJsonFile:
    source_name: str
    content: bytes


@dataclass(frozen=True, slots=True)
class _ParsedJsonFile:
    source_name: str
    content: bytes
    payload: dict[str, Any] | None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class ImportIssue:
    severity: IssueSeverity
    code: str
    message: str
    field: str | None = None

    def to_payload(self) -> dict[str, str]:
        payload = {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        }
        if self.field:
            payload["field"] = self.field
        return payload


@dataclass(slots=True)
class ManualImportRecord:
    key: str
    source_files: list[str]
    transaction_id: str | None = None
    imei: str | None = None
    vehicle_label: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    duration_seconds: float | None = None
    distance: float | None = None
    reported_distance: float | None = None
    geometry_distance: float | None = None
    max_speed: float | None = None
    average_speed: float | None = None
    point_count: int = 0
    raw_point_count: int = 0
    repeated_point_count: int = 0
    gps: dict[str, Any] | None = None
    issues: list[ImportIssue] = field(default_factory=list)
    existing_source: str | None = None
    payload: dict[str, Any] | None = None

    @property
    def status(self) -> str:
        if self.existing_source == BOUNCIE_SOURCE:
            return "existing"
        if any(issue.severity == "error" for issue in self.issues):
            return "invalid"
        if any(issue.severity == "warning" for issue in self.issues):
            return "warning"
        return "ready"

    @property
    def importable(self) -> bool:
        return self.status in {"ready", "warning"}

    def add_issue(
        self,
        severity: IssueSeverity,
        code: str,
        message: str,
        *,
        field: str | None = None,
    ) -> None:
        candidate = ImportIssue(severity, code, message, field)
        if candidate not in self.issues:
            self.issues.append(candidate)

    def to_payload(self) -> dict[str, Any]:
        issue_order = {"error": 0, "warning": 1, "info": 2}
        sorted_issues = sorted(
            self.issues,
            key=lambda issue: (issue_order[issue.severity], issue.code),
        )
        return {
            "key": self.key,
            "source_file": self.source_files[0] if self.source_files else None,
            "source_files": self.source_files,
            "transaction_id": self.transaction_id,
            "imei": self.imei,
            "vehicle_label": self.vehicle_label,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "duration_seconds": self.duration_seconds,
            "distance": self.distance,
            "reported_distance": self.reported_distance,
            "geometry_distance": self.geometry_distance,
            "max_speed": self.max_speed,
            "average_speed": self.average_speed,
            "point_count": self.point_count,
            "raw_point_count": self.raw_point_count,
            "gps": self.gps,
            "issues": [issue.to_payload() for issue in sorted_issues],
            "status": self.status,
            "importable": self.importable,
            "existing_source": self.existing_source,
        }


@dataclass(slots=True)
class ManualTripImportAnalysis:
    fingerprint: str
    uploaded_files: int
    json_files: int
    records_found: int
    records: list[ManualImportRecord]
    duplicate_copies: int = 0
    repeated_points_removed: int = 0
    available_transaction_ids: set[str] = field(default_factory=set)

    @property
    def records_by_id(self) -> dict[str, ManualImportRecord]:
        return {
            record.transaction_id: record
            for record in self.records
            if record.transaction_id
        }

    def to_payload(self) -> dict[str, Any]:
        counts = defaultdict(int)
        importable_distance = 0.0
        starts: list[datetime] = []
        ends: list[datetime] = []
        for record in self.records:
            counts[record.status] += 1
            if record.importable and record.distance is not None:
                importable_distance += record.distance
            if record.start_time:
                starts.append(record.start_time)
            if record.end_time:
                ends.append(record.end_time)

        importable = counts["ready"] + counts["warning"]
        return {
            "fingerprint": self.fingerprint,
            "limits": {
                "max_import_batch_size": MAX_IMPORT_BATCH_SIZE,
                "max_single_upload_bytes": MAX_SINGLE_UPLOAD_BYTES,
                "max_total_upload_bytes": MAX_TOTAL_UPLOAD_BYTES,
            },
            "summary": {
                "uploaded_files": self.uploaded_files,
                "json_files": self.json_files,
                "records_found": self.records_found,
                "review_records": len(self.records),
                "unique_trips": len(self.available_transaction_ids),
                "ready": counts["ready"],
                "warnings": counts["warning"],
                "invalid": counts["invalid"],
                "existing": counts["existing"],
                "importable": importable,
                "duplicate_copies": self.duplicate_copies,
                "repeated_points_removed": self.repeated_points_removed,
                "importable_distance": round(importable_distance, 3),
                "start_time": min(starts).isoformat() if starts else None,
                "end_time": max(ends).isoformat() if ends else None,
            },
            "records": [record.to_payload() for record in self.records],
        }


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKeyError(f"Duplicate JSON field '{key}'")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number '{value}' is not allowed")


def _safe_source_name(value: str | None) -> str:
    name = str(value or "upload").replace("\x00", "").strip()
    return name[:500] or "upload"


def _archive_member_is_safe(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    return bool(
        normalized
        and not normalized.startswith("/")
        and not path.is_absolute()
        and ".." not in path.parts
    )


def _decode_json_document(content: bytes) -> dict[str, Any]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ManualTripImportError("JSON file is not valid UTF-8") from exc

    try:
        value = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except RecursionError as exc:
        raise ManualTripImportError("JSON nesting is too deep") from exc
    except (json.JSONDecodeError, _DuplicateJsonKeyError, ValueError) as exc:
        raise ManualTripImportError(str(exc)) from exc

    if not isinstance(value, dict):
        raise ManualTripImportError("Each JSON file must contain one trip object")
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except RecursionError as exc:
        raise ManualTripImportError("JSON nesting is too deep") from exc
    except UnicodeEncodeError as exc:
        raise ManualTripImportError(
            "JSON contains an invalid Unicode character"
        ) from exc
    except ValueError as exc:
        raise ManualTripImportError("JSON contains a non-finite number") from exc
    return value


def _extract_archive(
    container: UploadedTripContainer,
    *,
    uncompressed_budget: int,
) -> list[_LogicalJsonFile]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(container.content))
    except zipfile.BadZipFile as exc:
        raise ManualTripImportError(
            f"{container.name} is not a valid ZIP archive"
        ) from exc

    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_ARCHIVE_ENTRIES:
            raise ManualTripImportError(
                f"{container.name} contains too many archive entries",
            )

        logical_files: list[_LogicalJsonFile] = []
        total_uncompressed = 0
        for info in infos:
            if info.is_dir():
                continue
            if len(info.filename) > MAX_ARCHIVE_MEMBER_NAME_LENGTH:
                raise ManualTripImportError(
                    f"{container.name} contains an archive path that is too long",
                )
            if not _archive_member_is_safe(info.filename):
                raise ManualTripImportError(
                    f"{container.name} contains an unsafe path: {info.filename}",
                )
            unix_mode = info.external_attr >> 16
            if unix_mode and stat.S_ISLNK(unix_mode):
                raise ManualTripImportError(
                    f"{container.name} contains a symbolic link",
                )
            if info.flag_bits & 0x1:
                raise ManualTripImportError(
                    f"{container.name} contains an encrypted file",
                )
            if not info.filename.lower().endswith(".json"):
                raise ManualTripImportError(
                    f"{container.name} contains a non-JSON file: {info.filename}",
                )
            if info.file_size > MAX_JSON_FILE_BYTES:
                raise ManualTripImportError(
                    f"{info.filename} exceeds the per-JSON size limit",
                )

            total_uncompressed += info.file_size
            if total_uncompressed > uncompressed_budget:
                raise ManualTripImportError(
                    "Selected files expand beyond the total archive size limit",
                )
            if info.file_size and (
                not info.compress_size
                or info.file_size / info.compress_size > MAX_ARCHIVE_COMPRESSION_RATIO
            ):
                raise ManualTripImportError(
                    f"{info.filename} has an unsafe compression ratio",
                )

            try:
                content = archive.read(info)
            except (NotImplementedError, RuntimeError, zipfile.BadZipFile) as exc:
                raise ManualTripImportError(
                    f"Unable to read {info.filename} from {container.name}",
                ) from exc
            if len(content) != info.file_size:
                raise ManualTripImportError(
                    f"{info.filename} did not match its declared size",
                )
            logical_files.append(
                _LogicalJsonFile(
                    source_name=f"{container.name}:{info.filename}",
                    content=content,
                ),
            )

    if not logical_files:
        raise ManualTripImportError(f"{container.name} contains no JSON files")
    return logical_files


def _logical_files_from_containers(
    containers: list[UploadedTripContainer],
) -> list[_LogicalJsonFile]:
    if not containers:
        raise ManualTripImportError("Choose at least one ZIP or JSON file")
    if len(containers) > MAX_UPLOAD_CONTAINERS:
        raise ManualTripImportError("Too many files were selected")

    logical_files: list[_LogicalJsonFile] = []
    total_uploaded_bytes = 0
    total_logical_bytes = 0
    for container in containers:
        container_bytes = len(container.content)
        if container_bytes > MAX_SINGLE_UPLOAD_BYTES:
            raise ManualTripImportError(
                f"{container.name} exceeds the per-file size limit",
            )
        total_uploaded_bytes += container_bytes
        if total_uploaded_bytes > MAX_TOTAL_UPLOAD_BYTES:
            raise ManualTripImportError("Selected files exceed the total upload limit")

        lower_name = container.name.lower()
        if lower_name.endswith(".zip"):
            extracted = _extract_archive(
                container,
                uncompressed_budget=(
                    MAX_ARCHIVE_UNCOMPRESSED_BYTES - total_logical_bytes
                ),
            )
            logical_files.extend(extracted)
            total_logical_bytes += sum(len(item.content) for item in extracted)
        elif lower_name.endswith(".json"):
            if len(container.content) > MAX_JSON_FILE_BYTES:
                raise ManualTripImportError(
                    f"{container.name} exceeds the per-JSON size limit",
                )
            logical_files.append(
                _LogicalJsonFile(container.name, container.content),
            )
            total_logical_bytes += container_bytes
        else:
            raise ManualTripImportError(
                f"Unsupported file type for {container.name}; use ZIP or JSON",
            )

        if total_logical_bytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ManualTripImportError(
                "Selected files expand beyond the total archive size limit",
            )

        if len(logical_files) > MAX_ARCHIVE_ENTRIES:
            raise ManualTripImportError("The upload contains too many JSON files")
    return logical_files


def _fingerprint(logical_files: list[_LogicalJsonFile]) -> str:
    digest = hashlib.sha256()
    entries = sorted(
        (
            item.source_name,
            hashlib.sha256(item.content).hexdigest(),
        )
        for item in logical_files
    )
    for source_name, content_digest in entries:
        encoded_name = source_name.encode("utf-8", errors="replace")
        digest.update(len(encoded_name).to_bytes(4, "big"))
        digest.update(encoded_name)
        digest.update(content_digest.encode("ascii"))
    return digest.hexdigest()


def _canonical_payload_digest(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _geometry_distance(coords: list[list[float]]) -> float:
    return sum(
        GeometryService.haversine_distance(
            previous[0],
            previous[1],
            current[0],
            current[1],
            unit="miles",
        )
        for previous, current in pairwise(coords)
    )


def _geometry_point_count(gps: dict[str, Any] | None) -> int:
    if not isinstance(gps, dict):
        return 0
    coords = gps.get("coordinates")
    if gps.get("type") == "Point":
        return 1 if isinstance(coords, list) else 0
    if gps.get("type") == "LineString" and isinstance(coords, list):
        return len(coords)
    return 0


def _vehicle_label(vehicle: Vehicle) -> str:
    for value in (vehicle.custom_name, vehicle.bouncie_nickname):
        label = str(value or "").strip()
        if label:
            return label
    description = " ".join(
        str(value) for value in (vehicle.year, vehicle.make, vehicle.model) if value
    ).strip()
    if description:
        return description
    if vehicle.vin:
        return f"VIN {vehicle.vin}"
    return f"IMEI {vehicle.imei}"


class ManualTripImportService:
    """Build a dry-run review and write selected historical Bouncie trips."""

    def __init__(self, pipeline: TripPipeline | None = None) -> None:
        self.pipeline = pipeline or TripPipeline()

    async def _load_existing_sources(self, transaction_ids: set[str]) -> dict[str, str]:
        if not transaction_ids:
            return {}
        documents = (
            await Trip.find(In(Trip.transactionId, sorted(transaction_ids)))
            .project(TripStatusProjection)
            .to_list()
        )
        return {
            str(document.transactionId): str(document.source or "").strip().lower()
            for document in documents
            if document.transactionId
        }

    async def _load_vehicles(self, imeis: set[str]) -> dict[str, Vehicle]:
        if not imeis:
            return {}
        vehicles = await Vehicle.find(In(Vehicle.imei, sorted(imeis))).to_list()
        return {str(vehicle.imei): vehicle for vehicle in vehicles if vehicle.imei}

    @staticmethod
    def _parse_files(logical_files: list[_LogicalJsonFile]) -> list[_ParsedJsonFile]:
        parsed: list[_ParsedJsonFile] = []
        for item in logical_files:
            try:
                payload = _decode_json_document(item.content)
            except ManualTripImportError as exc:
                parsed.append(
                    _ParsedJsonFile(
                        source_name=item.source_name,
                        content=item.content,
                        payload=None,
                        error=str(exc),
                    ),
                )
            else:
                parsed.append(
                    _ParsedJsonFile(item.source_name, item.content, payload),
                )
        return parsed

    @staticmethod
    def _validate_numbers(record: ManualImportRecord, payload: dict[str, Any]) -> None:
        for field_name, label in _NUMERIC_FIELDS.items():
            if field_name not in payload or payload[field_name] is None:
                continue
            number = _finite_number(payload[field_name])
            if number is None:
                record.add_issue(
                    "error",
                    "invalid_number",
                    f"{label} must be a finite number.",
                    field=field_name,
                )
            elif number < 0:
                record.add_issue(
                    "error",
                    "negative_number",
                    f"{label} cannot be negative.",
                    field=field_name,
                )

        for field_name, label in _COUNT_FIELDS.items():
            if field_name not in payload or payload[field_name] is None:
                continue
            number = _finite_number(payload[field_name])
            if number is None or number < 0 or not number.is_integer():
                record.add_issue(
                    "error",
                    "invalid_count",
                    f"{label} must be a non-negative whole number.",
                    field=field_name,
                )

        start_odometer = _finite_number(payload.get("startOdometer"))
        end_odometer = _finite_number(payload.get("endOdometer"))
        if (
            start_odometer is not None
            and end_odometer is not None
            and end_odometer < start_odometer
        ):
            record.add_issue(
                "error",
                "odometer_regression",
                "End odometer is lower than start odometer.",
                field="endOdometer",
            )

        reported_distance = _finite_number(payload.get("distance"))
        if (
            start_odometer is not None
            and end_odometer is not None
            and reported_distance is not None
            and end_odometer >= start_odometer
            and reported_distance >= 0
        ):
            odometer_distance = end_odometer - start_odometer
            tolerance = max(1.0, reported_distance * 0.5)
            if abs(odometer_distance - reported_distance) > tolerance:
                record.add_issue(
                    "warning",
                    "odometer_distance_mismatch",
                    (
                        f"Odometer change ({odometer_distance:.2f} mi) differs "
                        f"from reported distance ({reported_distance:.2f} mi)."
                    ),
                    field="endOdometer",
                )

        idle_value = payload.get("totalIdlingTime")
        if idle_value is None:
            idle_value = payload.get("totalIdleDuration")
        idle_duration = _finite_number(idle_value)
        if (
            idle_duration is not None
            and record.duration_seconds is not None
            and idle_duration > record.duration_seconds
        ):
            record.add_issue(
                "error",
                "idle_exceeds_duration",
                "Idle duration exceeds the trip's total duration.",
                field="totalIdleDuration",
            )

        average_speed = _finite_number(
            payload.get("averageSpeed", payload.get("avgSpeed")),
        )
        max_speed = _finite_number(payload.get("maxSpeed"))
        record.average_speed = average_speed
        record.max_speed = max_speed
        if (
            average_speed is not None
            and max_speed is not None
            and average_speed > max_speed
        ):
            record.add_issue(
                "error",
                "average_exceeds_maximum",
                "Average speed exceeds maximum speed.",
                field="averageSpeed",
            )
        if max_speed is not None and max_speed > MAX_REASONABLE_SPEED_MPH:
            record.add_issue(
                "error",
                "implausible_speed",
                f"Maximum speed exceeds {MAX_REASONABLE_SPEED_MPH:.0f} mph.",
                field="maxSpeed",
            )
        elif max_speed is not None and max_speed > 120:
            record.add_issue(
                "warning",
                "unusually_high_speed",
                "Maximum speed is unusually high; verify this trip before importing.",
                field="maxSpeed",
            )

    @staticmethod
    def _validate_identity(record: ManualImportRecord, payload: dict[str, Any]) -> None:
        transaction_value = payload.get("transactionId")
        if not isinstance(transaction_value, str) or not transaction_value.strip():
            record.add_issue(
                "error",
                "missing_transaction_id",
                "A non-empty Bouncie transaction ID is required.",
                field="transactionId",
            )
        elif len(transaction_value) > 200:
            record.add_issue(
                "error",
                "transaction_id_too_long",
                "Transaction ID is too long.",
                field="transactionId",
            )
        elif not _BOUNCIE_TRANSACTION_ID_PATTERN.fullmatch(transaction_value):
            record.add_issue(
                "error",
                "unusual_transaction_id",
                "Transaction ID does not match Bouncie's numeric ID format.",
                field="transactionId",
            )

        imei_value = payload.get("imei")
        if not isinstance(imei_value, str) or not imei_value.strip():
            record.add_issue(
                "error",
                "missing_imei",
                "A Bouncie device IMEI is required.",
                field="imei",
            )
            return

        record.imei = imei_value.strip()
        if imei_value != record.imei:
            record.add_issue(
                "warning",
                "imei_whitespace_removed",
                "Leading or trailing whitespace was removed from the IMEI.",
                field="imei",
            )
        payload["imei"] = record.imei
        if not _IMEI_PATTERN.fullmatch(record.imei):
            record.add_issue(
                "error",
                "invalid_imei",
                "IMEI must contain 14 to 16 digits.",
                field="imei",
            )

        if record.transaction_id and not record.transaction_id.startswith(
            f"{record.imei}-",
        ):
            record.add_issue(
                "error",
                "transaction_imei_mismatch",
                "Transaction ID does not begin with this trip's IMEI.",
                field="transactionId",
            )

    @staticmethod
    def _validate_timezone(record: ManualImportRecord, payload: dict[str, Any]) -> None:
        value = payload.get("timeZone")
        if value is None or value == "":
            record.add_issue(
                "warning",
                "missing_timezone",
                "Trip time zone is missing; timestamps will remain in UTC.",
                field="timeZone",
            )
            payload.pop("timeZone", None)
            return
        if not isinstance(value, str):
            record.add_issue(
                "error",
                "invalid_timezone",
                "Trip time zone must be text.",
                field="timeZone",
            )
            return

        normalized = value.strip()
        if not normalized or len(normalized) > 100 or not normalized.isprintable():
            record.add_issue(
                "error",
                "invalid_timezone",
                "Trip time zone is empty, too long, or contains control characters.",
                field="timeZone",
            )
            return
        if normalized != value:
            record.add_issue(
                "warning",
                "timezone_whitespace_removed",
                "Leading or trailing whitespace was removed from the time zone.",
                field="timeZone",
            )
        payload["timeZone"] = normalized

    @staticmethod
    def _validate_times(record: ManualImportRecord, payload: dict[str, Any]) -> None:
        start_time = parse_timestamp(payload.get("startTime"))
        end_time = parse_timestamp(payload.get("endTime"))
        record.start_time = start_time
        record.end_time = end_time

        if start_time is None:
            record.add_issue(
                "error",
                "missing_start_time",
                "A valid start time is required.",
                field="startTime",
            )
        if end_time is None:
            record.add_issue(
                "error",
                "missing_end_time",
                "A valid end time is required.",
                field="endTime",
            )
        if start_time is None or end_time is None:
            return

        now = datetime.now(UTC)
        if start_time < MIN_SUPPORTED_TRIP_TIME or end_time < MIN_SUPPORTED_TRIP_TIME:
            record.add_issue(
                "error",
                "unsupported_trip_date",
                "Trip timestamps earlier than 2000 are not accepted.",
                field="startTime",
            )
        if (
            start_time > now + MAX_FUTURE_CLOCK_SKEW
            or end_time > now + MAX_FUTURE_CLOCK_SKEW
        ):
            record.add_issue(
                "error",
                "future_trip_date",
                "Trip timestamp is more than one day in the future.",
                field="startTime",
            )
        if end_time <= start_time:
            record.add_issue(
                "error",
                "invalid_time_order",
                "End time must be later than start time.",
                field="endTime",
            )
            return

        duration = end_time - start_time
        record.duration_seconds = duration.total_seconds()
        if duration > MAX_TRIP_DURATION:
            record.add_issue(
                "error",
                "implausible_duration",
                "Trip duration exceeds seven days.",
                field="endTime",
            )
        elif duration > timedelta(days=1):
            record.add_issue(
                "warning",
                "long_duration",
                "Trip lasts more than 24 hours; verify its timestamps.",
                field="endTime",
            )

        if record.transaction_id:
            encoded_start_candidates: list[int] = []
            for component in record.transaction_id.split("-")[1:]:
                if len(component) == 10:
                    encoded_start_candidates.append(int(component) * 1000)
                elif len(component) == 13:
                    encoded_start_candidates.append(int(component))
                elif len(component) == 16:
                    encoded_start_candidates.append(int(component) // 1000)
            if not encoded_start_candidates:
                record.add_issue(
                    "warning",
                    "transaction_time_missing",
                    "Transaction ID does not contain a recognizable start timestamp.",
                    field="transactionId",
                )
                return
            actual_start_ms = round(start_time.timestamp() * 1000)
            if all(
                abs(encoded_start_ms - actual_start_ms) > 1000
                for encoded_start_ms in encoded_start_candidates
            ):
                record.add_issue(
                    "warning",
                    "transaction_time_mismatch",
                    "Transaction ID timestamp does not match the trip start time.",
                    field="transactionId",
                )

    @staticmethod
    def _validate_geometry(record: ManualImportRecord, payload: dict[str, Any]) -> None:
        gps = payload.get("gps")
        coords = gps.get("coordinates") if isinstance(gps, dict) else None
        if not (
            isinstance(gps, dict)
            and gps.get("type") == "LineString"
            and isinstance(coords, list)
        ):
            normalized_gps = normalize_rest_trip_payload({"gps": gps}).get("gps")
            if not (
                isinstance(normalized_gps, dict)
                and normalized_gps.get("type") == "LineString"
            ):
                record.add_issue(
                    "error",
                    "invalid_geometry_type",
                    "GPS must resolve to a GeoJSON LineString.",
                    field="gps",
                )
                return
            coords = normalized_gps.get("coordinates")
        if not isinstance(coords, list):
            record.add_issue(
                "error",
                "invalid_coordinates",
                "GPS coordinates must be an array.",
                field="gps.coordinates",
            )
            return

        record.raw_point_count = len(coords)
        cleaned: list[list[float]] = []
        invalid_count = 0
        repeated_count = 0
        for value in coords:
            if not isinstance(value, list | tuple) or len(value) < 2:
                invalid_count += 1
                continue
            lon = _finite_number(value[0])
            lat = _finite_number(value[1])
            if (
                lon is None
                or lat is None
                or not (-180 <= lon <= 180 and -90 <= lat <= 90)
            ):
                invalid_count += 1
                continue
            pair = [lon, lat]
            if cleaned and pair == cleaned[-1]:
                repeated_count += 1
                continue
            cleaned.append(pair)

        record.repeated_point_count = repeated_count

        if invalid_count:
            record.add_issue(
                "error",
                "malformed_coordinates",
                f"GPS contains {invalid_count} malformed or out-of-range point(s).",
                field="gps.coordinates",
            )
        if len(cleaned) < 2:
            record.add_issue(
                "error",
                "missing_route_geometry",
                "Trip needs at least two distinct valid GPS points.",
                field="gps.coordinates",
            )
            return

        record.geometry_distance = _geometry_distance(cleaned)
        if record.duration_seconds and record.geometry_distance:
            geometry_speed = record.geometry_distance / (record.duration_seconds / 3600)
            if geometry_speed > MAX_REASONABLE_SPEED_MPH:
                record.add_issue(
                    "error",
                    "implausible_geometry_speed",
                    "GPS path implies an impossible average speed.",
                    field="gps.coordinates",
                )

    @staticmethod
    def _validate_metric_consistency(record: ManualImportRecord) -> None:
        reported = record.reported_distance
        geometry = record.geometry_distance
        if reported is not None and reported >= 0 and geometry is not None:
            difference = abs(reported - geometry)
            tolerance = max(0.25, reported * 0.5)
            if difference > tolerance:
                record.add_issue(
                    "warning",
                    "distance_geometry_mismatch",
                    (
                        f"Reported distance ({reported:.2f} mi) differs from the "
                        f"GPS path ({geometry:.2f} mi)."
                    ),
                    field="distance",
                )

        if record.distance is not None and 0 <= record.distance < VERY_SHORT_TRIP_MILES:
            record.add_issue(
                "warning",
                "very_short_trip",
                f"Trip is shorter than {VERY_SHORT_TRIP_MILES:.2f} miles.",
                field="distance",
            )

    async def _analyze_trip(
        self,
        *,
        transaction_id: str,
        files: list[_ParsedJsonFile],
        existing_sources: dict[str, str],
        vehicles: dict[str, Vehicle],
    ) -> ManualImportRecord:
        raw_payload = dict(files[0].payload or {})
        payload = {
            key: value
            for key, value in raw_payload.items()
            if key in _IMPORT_PAYLOAD_FIELDS
        }
        record = ManualImportRecord(
            key=transaction_id,
            source_files=[item.source_name for item in files],
            transaction_id=transaction_id,
            payload=payload,
        )
        ignored_fields = sorted(set(raw_payload) - _IMPORT_PAYLOAD_FIELDS)
        if ignored_fields:
            sample = ", ".join(field[:60] for field in ignored_fields[:5])
            suffix = "" if len(ignored_fields) <= 5 else ", …"
            record.add_issue(
                "warning",
                "unsupported_fields_ignored",
                (
                    f"{len(ignored_fields)} unsupported field(s) will be ignored: "
                    f"{sample}{suffix}"
                ),
            )
        transaction_value = payload.get("transactionId")
        if isinstance(transaction_value, str):
            if transaction_value != transaction_id:
                record.add_issue(
                    "warning",
                    "transaction_id_whitespace_removed",
                    "Leading or trailing whitespace was removed from the transaction ID.",
                    field="transactionId",
                )
            payload["transactionId"] = transaction_id

        payload_digests = {
            _canonical_payload_digest(item.payload or {}) for item in files
        }
        if len(payload_digests) > 1:
            record.add_issue(
                "error",
                "conflicting_duplicate",
                "Multiple uploaded files use this transaction ID with different data.",
                field="transactionId",
            )
        elif len(files) > 1:
            record.add_issue(
                "warning",
                "duplicate_copy",
                f"The same trip was supplied {len(files)} times; one copy will be used.",
                field="transactionId",
            )

        self._validate_identity(record, payload)
        self._validate_timezone(record, payload)
        self._validate_times(record, payload)
        self._validate_numbers(record, payload)
        self._validate_geometry(record, payload)

        normalized = normalize_rest_trip_payload(payload)
        normalized_gps = sanitize_geojson_geometry(normalized.get("gps"))
        record.gps = normalized_gps
        record.point_count = _geometry_point_count(normalized_gps)
        record.reported_distance = _finite_number(payload.get("distance"))
        record.distance = record.reported_distance or record.geometry_distance

        has_structural_error = any(
            issue.severity == "error"
            and issue.code
            not in {
                "conflicting_duplicate",
            }
            for issue in record.issues
        )
        if not has_structural_error:
            validation = await self.pipeline.validate_raw_trip_with_basic(normalized)
            if not validation.get("success"):
                reason = (
                    (validation.get("processing_status") or {})
                    .get("errors", {})
                    .get("validation")
                )
                record.add_issue(
                    "error",
                    "pipeline_validation_failed",
                    str(reason or "Trip failed application validation."),
                )
            else:
                processed = validation.get("processed_data") or {}
                record.gps = sanitize_geojson_geometry(processed.get("gps"))
                record.point_count = _geometry_point_count(record.gps)
                processed_distance = _finite_number(processed.get("distance"))
                if processed_distance is not None:
                    record.distance = processed_distance
                meaningful_trip = Trip(**processed)
                meaningful, reason = meaningful_trip.validate_meaningful()
                if not meaningful:
                    record.add_issue(
                        "error",
                        "not_meaningful_trip",
                        str(reason or "Trip does not represent meaningful driving."),
                    )

        self._validate_metric_consistency(record)

        vehicle = vehicles.get(record.imei or "")
        if record.imei and _IMEI_PATTERN.fullmatch(record.imei) and vehicle is None:
            record.add_issue(
                "error",
                "unknown_imei",
                (
                    f"IMEI {record.imei} is not in the Fleet Registry. "
                    "Add the device on Vehicles before importing."
                ),
                field="imei",
            )
        elif vehicle is not None:
            record.vehicle_label = _vehicle_label(vehicle)

        if transaction_id in existing_sources:
            existing_source = existing_sources[transaction_id]
            record.existing_source = existing_source
            if existing_source == BOUNCIE_SOURCE:
                record.add_issue(
                    "info",
                    "already_exists",
                    "This Bouncie trip is already in historical trip storage.",
                    field="transactionId",
                )
            else:
                record.add_issue(
                    "error",
                    "conflicting_existing_source",
                    "An existing trip with this ID has a non-Bouncie source.",
                    field="transactionId",
                )
        return record

    async def analyze(
        self,
        containers: list[UploadedTripContainer],
        *,
        requested_ids: set[str] | None = None,
    ) -> ManualTripImportAnalysis:
        logical_files = _logical_files_from_containers(containers)
        fingerprint = _fingerprint(logical_files)
        parsed_files = self._parse_files(logical_files)

        grouped: dict[str, list[_ParsedJsonFile]] = defaultdict(list)
        records: list[ManualImportRecord] = []
        available_ids: set[str] = set()
        for index, parsed in enumerate(parsed_files):
            if parsed.payload is None:
                if requested_ids is None:
                    record = ManualImportRecord(
                        key=f"file-{index}",
                        source_files=[parsed.source_name],
                    )
                    record.add_issue(
                        "error",
                        "invalid_json",
                        parsed.error or "Invalid JSON file.",
                    )
                    records.append(record)
                continue

            value = parsed.payload.get("transactionId")
            transaction_id = str(value or "").strip()
            if not transaction_id:
                if requested_ids is None:
                    record = ManualImportRecord(
                        key=f"file-{index}",
                        source_files=[parsed.source_name],
                        payload=parsed.payload,
                    )
                    record.add_issue(
                        "error",
                        "missing_transaction_id",
                        "A non-empty Bouncie transaction ID is required.",
                        field="transactionId",
                    )
                    records.append(record)
                continue

            available_ids.add(transaction_id)
            if requested_ids is None or transaction_id in requested_ids:
                grouped[transaction_id].append(parsed)

        transaction_ids = {
            transaction_id
            for transaction_id in grouped
            if _BOUNCIE_TRANSACTION_ID_PATTERN.fullmatch(transaction_id)
        }
        imeis: set[str] = set()
        for files in grouped.values():
            item = files[0]
            imei_value = item.payload.get("imei") if item.payload else None
            if isinstance(imei_value, str):
                imei = imei_value.strip()
                if _IMEI_PATTERN.fullmatch(imei):
                    imeis.add(imei)
        existing_sources = await self._load_existing_sources(transaction_ids)
        vehicles = await self._load_vehicles(imeis)

        for transaction_id, files in grouped.items():
            records.append(
                await self._analyze_trip(
                    transaction_id=transaction_id,
                    files=files,
                    existing_sources=existing_sources,
                    vehicles=vehicles,
                ),
            )

        records.sort(
            key=lambda record: (
                record.start_time is None,
                record.start_time or datetime.max.replace(tzinfo=UTC),
                record.key,
            ),
        )
        duplicate_copies = sum(max(0, len(files) - 1) for files in grouped.values())
        repeated_points_removed = sum(record.repeated_point_count for record in records)
        return ManualTripImportAnalysis(
            fingerprint=fingerprint,
            uploaded_files=len(containers),
            json_files=len(logical_files),
            records_found=len(parsed_files),
            records=records,
            duplicate_copies=duplicate_copies,
            repeated_points_removed=repeated_points_removed,
            available_transaction_ids=available_ids,
        )

    async def import_selected(
        self,
        analysis: ManualTripImportAnalysis,
        selected_ids: list[str],
    ) -> dict[str, Any]:
        unique_ids = list(
            dict.fromkeys(str(value or "").strip() for value in selected_ids)
        )
        unique_ids = [value for value in unique_ids if value]
        if not unique_ids:
            raise ManualTripImportError("Select at least one eligible trip")
        if len(unique_ids) > MAX_IMPORT_BATCH_SIZE:
            raise ManualTripImportError(
                f"Import at most {MAX_IMPORT_BATCH_SIZE} trips per batch",
            )

        missing = [
            value
            for value in unique_ids
            if value not in analysis.available_transaction_ids
        ]
        if missing:
            raise ManualTripImportError(
                "The selected trips do not match the reviewed upload. Scan the files again.",
            )

        records_by_id = analysis.records_by_id
        rejected = [
            value
            for value in unique_ids
            if value not in records_by_id
            or records_by_id[value].status not in {"ready", "warning", "existing"}
        ]
        if rejected:
            raise ManualTripImportError(
                "One or more selected trips are no longer eligible. Scan the files again.",
            )

        already_present_ids = [
            value for value in unique_ids if records_by_id[value].status == "existing"
        ]
        payloads = [
            records_by_id[value].payload
            for value in unique_ids
            if records_by_id[value].importable
            and isinstance(records_by_id[value].payload, dict)
        ]

        result: dict[str, Any] = {
            "processed_transaction_ids": [],
            "counters": {},
        }
        if payloads:
            result = await process_bouncie_trips(
                payloads,
                pipeline=self.pipeline,
                mode="insert_only",
                do_map_match=False,
                do_geocode=True,
                do_coverage=True,
                sync_mobility=True,
                force_rematch_all=False,
                bump_revision=False,
            )

        counters = dict(result.get("counters") or {})
        if ingest_counters_changed_trips(counters):
            await bump_trip_map_revision()

        processed_id_set = {
            str(value)
            for value in result.get("processed_transaction_ids") or []
            if str(value) in unique_ids
        }
        already_present_set = set(already_present_ids)

        # An insert-only write can lose a race after the dry-run query. Resolve
        # those skipped IDs against historical storage so a retry stays
        # idempotent instead of being reported as a failure.
        unresolved_ids = {
            value
            for value in unique_ids
            if value not in processed_id_set and value not in already_present_set
        }
        if unresolved_ids:
            sources_after_write = await self._load_existing_sources(unresolved_ids)
            already_present_set.update(
                value
                for value, source in sources_after_write.items()
                if source == BOUNCIE_SOURCE
            )

        processed_ids = [value for value in unique_ids if value in processed_id_set]
        already_present_ids = [
            value for value in unique_ids if value in already_present_set
        ]
        completed_ids = [
            value
            for value in unique_ids
            if value in processed_id_set or value in already_present_set
        ]
        failed_ids = [value for value in unique_ids if value not in completed_ids]
        return {
            "status": "success" if not failed_ids else "partial",
            "requested": len(unique_ids),
            "completed": len(completed_ids),
            "inserted": int(counters.get("inserted", 0) or 0),
            "already_present": len(already_present_ids),
            "completed_ids": completed_ids,
            "processed_ids": processed_ids,
            "already_present_ids": already_present_ids,
            "failed_ids": failed_ids,
            "counters": counters,
        }


def build_uploaded_container(name: str | None, content: bytes) -> UploadedTripContainer:
    """Normalize an API upload into the service's bounded input type."""
    return UploadedTripContainer(name=_safe_source_name(name), content=content)


__all__ = [
    "MAX_IMPORT_BATCH_SIZE",
    "MAX_SINGLE_UPLOAD_BYTES",
    "MAX_TOTAL_UPLOAD_BYTES",
    "MAX_UPLOAD_CONTAINERS",
    "ManualTripImportAnalysis",
    "ManualTripImportError",
    "ManualTripImportService",
    "UploadedTripContainer",
    "build_uploaded_container",
]
