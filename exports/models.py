from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from exports.constants import EXPORT_DEFAULT_FORMAT, EXPORT_FORMATS_BY_ENTITY

if TYPE_CHECKING:
    from beanie import PydanticObjectId

ExportEntity = Literal[
    "trips",
    "matched_trips",
    "streets",
    "boundaries",
    "undriven_streets",
]

ExportFormat = Literal["json", "csv", "geojson"]


class TripFilters(BaseModel):
    start_date: str | None = None
    end_date: str | None = None
    imei: str | None = None
    status: list[str] | None = None
    include_invalid: bool = False

    @field_validator("status", mode="before")
    @classmethod
    def _normalize_status(cls, value: Any) -> list[str] | None:
        if value is None:
            return None
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            return [str(item) for item in value if item is not None]
        return None


class ExportItem(BaseModel):
    entity: ExportEntity
    format: ExportFormat | None = None
    include_geometry: bool | None = None


class ExportRequest(BaseModel):
    items: list[ExportItem] = Field(default_factory=list)
    trip_filters: TripFilters | None = None
    area_id: PydanticObjectId | None = None

    @model_validator(mode="after")
    def _validate_request(self) -> ExportRequest:
        if not self.items:
            msg = "At least one export item is required."
            raise ValueError(msg)

        for item in self.items:
            allowed_formats = EXPORT_FORMATS_BY_ENTITY.get(item.entity, set())
            fmt = item.format or EXPORT_DEFAULT_FORMAT.get(item.entity)
            if fmt not in allowed_formats:
                msg = f"Unsupported format '{fmt}' for entity '{item.entity}'."
                raise ValueError(
                    msg,
                )

        needs_area = any(
            item.entity in {"streets", "boundaries", "undriven_streets"}
            for item in self.items
        )
        if needs_area and not self.area_id:
            msg = "area_id is required for coverage exports."
            raise ValueError(msg)

        return self


class ExportResult(BaseModel):
    artifact_name: str | None = None
    artifact_size_bytes: int | None = None
    records: dict[str, int] = Field(default_factory=dict)
    files: list[dict[str, Any]] = Field(default_factory=list)


class ExportJobResponse(BaseModel):
    id: str
    status: str
    progress: float
    message: str | None = None
    created_at: str


class ExportStatusResponse(BaseModel):
    id: str
    status: str
    progress: float
    message: str | None = None
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
    result: ExportResult | None = None
    download_url: str | None = None
