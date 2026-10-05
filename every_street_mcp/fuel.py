"""Photo-driven fuel logging for the owner's Nissan, Marquise."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_validator

from core.date_utils import ensure_utc
from core.redis import get_shared_redis
from db.models import AppSettings, GasFillup, Vehicle
from gas.services.fillup_service import FillupService
from gas.services.vehicle_service import VehicleService

TimeSource = Literal["photo_metadata", "receipt", "user"]


class FuelFillupInput(BaseModel):
    """Only observed or user-supplied readings, in US units."""

    model_config = ConfigDict(extra="forbid")

    fillup_time: datetime = Field(
        description="ISO timestamp with UTC offset; never guess from upload time."
    )
    time_source: TimeSource = Field(
        description="Where the fill-up date and time came from."
    )
    gallons: Annotated[FiniteFloat, Field(gt=0, strict=True)]
    odometer: Annotated[FiniteFloat, Field(ge=0, strict=True)] = Field(
        description="Total odometer miles, not the trip meter or range."
    )
    total_cost: Annotated[FiniteFloat, Field(ge=0, strict=True)] | None = None
    price_per_gallon: Annotated[FiniteFloat, Field(ge=0, strict=True)] | None = None
    is_full_tank: bool = Field(
        default=True,
        strict=True,
        description="Assume full unless the owner says partial or top-up.",
    )
    missed_previous: bool = Field(
        default=False,
        strict=True,
        description="True if an intervening fill-up was not logged; prevents misleading MPG.",
    )

    @field_validator("fillup_time")
    @classmethod
    def require_offset(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Fill-up time needs an explicit UTC offset")
        return value.astimezone(UTC)

    def readings(self) -> dict[str, Any]:
        if self.fillup_time > datetime.now(UTC) + timedelta(minutes=10):
            raise ValueError(
                "Fill-up time is in the future; check the photo date and timezone"
            )
        if self.total_cost is None and self.price_per_gallon is None:
            raise ValueError(
                "Read the total paid or price per gallon from the pump or receipt"
            )
        gallons = Decimal(str(self.gallons))
        price = (
            Decimal(str(self.price_per_gallon))
            if self.price_per_gallon is not None
            else None
        )
        cost = Decimal(str(self.total_cost)) if self.total_cost is not None else None
        if (
            cost is not None
            and price is not None
            and abs(cost - gallons * price) > Decimal("0.02")
        ):
            raise ValueError(
                "Gallons times price differs from total paid by more than two cents; recheck the photos"
            )
        if cost is None:
            cost = (gallons * price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if price is None:
            price = (cost / gallons).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
        return {
            "fillup_time": self.fillup_time,
            "gallons": self.gallons,
            "odometer": self.odometer,
            "total_cost": float(cost),
            "price_per_gallon": float(price),
            "is_full_tank": self.is_full_tank,
            "missed_previous": self.missed_previous,
            # Photo transcription is a measured reading, like typing it into the form.
            "odometer_source": "manual",
            "odometer_is_estimated": False,
            "entry_source": "conversation",
            "fillup_time_source": self.time_source,
        }


async def resolve_fuel_vehicle() -> Vehicle:
    vehicles = await VehicleService.get_vehicles(active_only=True)
    named = [
        vehicle
        for vehicle in vehicles
        if any(
            str(name or "").strip().casefold() == "marquise"
            for name in (vehicle.custom_name, vehicle.bouncie_nickname)
        )
    ]
    candidates = named or [
        vehicle
        for vehicle in vehicles
        if str(vehicle.make or "").strip().casefold() == "nissan"
    ]
    if len(candidates) != 1:
        raise ValueError(
            "Could not uniquely identify Marquise, the Nissan, in the active vehicle registry"
        )
    vehicle = candidates[0]
    if vehicle.make and vehicle.make.strip().casefold() != "nissan":
        raise ValueError(
            "The Marquise vehicle record is not a Nissan; check the registry"
        )
    return vehicle


def public_fillup(fillup: GasFillup) -> dict[str, Any]:
    timestamp = ensure_utc(fillup.fillup_time)
    return {
        "id": str(fillup.id),
        "fillup_time": timestamp.isoformat() if timestamp else None,
        "gallons": fillup.gallons,
        "odometer_miles": fillup.odometer,
        "total_cost_usd": fillup.total_cost,
        "price_per_gallon_usd": fillup.price_per_gallon,
        "is_full_tank": fillup.is_full_tank,
        "missed_previous": fillup.missed_previous,
        "mpg": fillup.calculated_mpg,
        "time_source": fillup.fillup_time_source,
    }


async def fuel_logging_context() -> dict[str, Any]:
    vehicle = await resolve_fuel_vehicle()
    settings = await AppSettings.find_one()
    recent = await FillupService.get_fillups(imei=vehicle.imei, limit=5)
    return {
        "vehicle": {"name": "Marquise", "make": vehicle.make, "model": vehicle.model},
        "units": {"volume": "US gallons", "distance": "miles", "currency": "USD"},
        "default_is_full_tank": True,
        "account_timezone": settings.user_timezone if settings else None,
        "as_of": datetime.now(UTC).isoformat(),
        "recent_fillups": [public_fillup(fillup) for fillup in recent],
        "instructions": (
            "Read odometer, gallons, and paid total or unit price from the user's photos. "
            "Use inspect_fuel_photos for original capture metadata when file attachments are available. "
            "Prefer the receipt's transaction time, otherwise the completed pump photo's capture time, "
            "otherwise the odometer photo's capture time. Never use upload time as capture time. "
            "Resolve missing timezone from the receipt/location or ask if the account timezone is uncertain. "
            "Ask one short question for missing or conflicting readings or dates. "
            "If intervening fills were missed, set missed_previous to avoid misleading MPG. "
            "When the user asks to log a fill-up, call log_gas_fillup and report its saved result."
        ),
    }


async def save_fuel_fillup(fillup: FuelFillupInput) -> dict[str, Any]:
    readings = fillup.readings()
    vehicle = await resolve_fuel_vehicle()
    readings["imei"] = vehicle.imei
    # Serialize retries, including photos with slightly different capture times.
    key = hashlib.sha256(
        json.dumps([vehicle.imei, fillup.odometer, fillup.gallons]).encode()
    ).hexdigest()
    redis = await get_shared_redis()
    async with redis.lock(f"mcp:fuel:{key}", timeout=60, blocking_timeout=3):
        existing = await GasFillup.find_one(
            {
                "imei": vehicle.imei,
                "odometer": fillup.odometer,
                "gallons": fillup.gallons,
                "fillup_time": {
                    "$gte": fillup.fillup_time - timedelta(minutes=30),
                    "$lte": fillup.fillup_time + timedelta(minutes=30),
                },
            }
        )
        if existing:
            if (
                existing.total_cost is None
                or abs(existing.total_cost - readings["total_cost"]) > 0.02
                or existing.is_full_tank != fillup.is_full_tank
                or existing.missed_previous != fillup.missed_previous
            ):
                raise ValueError(
                    "A matching fill-up already exists with different readings or tank flags; review the existing record"
                )
            return {
                "success": True,
                "already_logged": True,
                "vehicle": "Marquise",
                "fillup": public_fillup(existing),
            }
        previous = await FillupService._get_previous_fillup(
            imei=vehicle.imei, before_time=fillup.fillup_time
        )
        following = await FillupService._get_next_fillup(
            imei=vehicle.imei, after_time=fillup.fillup_time
        )
        if (
            previous
            and previous.odometer is not None
            and fillup.odometer < previous.odometer
        ):
            raise ValueError(
                "Odometer is below the preceding fill-up; check the total odometer and date"
            )
        if (
            following
            and following.odometer is not None
            and fillup.odometer > following.odometer
        ):
            raise ValueError(
                "Odometer is above a later fill-up; check the total odometer and date"
            )
        if (
            previous
            and previous.odometer is not None
            and previous.is_full_tank
            and fillup.is_full_tank
            and not fillup.missed_previous
            and (fillup.odometer - previous.odometer) / fillup.gallons > 80
        ):
            raise ValueError(
                "Mileage since the last logged fill-up implies over 80 MPG; check readings and ask whether intervening fills were missed"
            )
        saved = await FillupService.create_fillup(readings)
    return {
        "success": True,
        "already_logged": False,
        "vehicle": "Marquise",
        "fillup": public_fillup(saved),
    }
