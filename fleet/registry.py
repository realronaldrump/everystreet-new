"""Authoritative Fleet Registry reads and writes for Bouncie Devices."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from beanie.operators import In

from db.models import Vehicle


def _normalize_imeis(values: list[str] | None) -> list[str]:
    return list(
        dict.fromkeys(
            str(value or "").strip()
            for value in values or []
            if str(value or "").strip()
        ),
    )


def _clean(value: Any) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned or None


@dataclass(frozen=True)
class BouncieDeviceMetadata:
    """Normalized view of one vehicle record from the Bouncie API."""

    imei: str
    vin: str | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    nickname: str | None = None
    standard_engine: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def default_name(self) -> str:
        """Human-readable name to use when the user has not set one."""
        parts = " ".join(
            str(part) for part in (self.year, self.make, self.model) if part
        ).strip()
        return self.nickname or parts or f"Vehicle {self.imei}"


def normalize_bouncie_vehicle(payload: Any) -> BouncieDeviceMetadata | None:
    """
    Flatten a Bouncie vehicles-API entry.

    Bouncie nests make/model/year under ``model`` for some devices and
    reports them at the top level for others.
    """
    if not isinstance(payload, dict):
        return None
    imei = _clean(payload.get("imei"))
    if not imei:
        return None

    model_data = payload.get("model")
    if isinstance(model_data, dict):
        model_name = model_data.get("name")
        make = payload.get("make") or model_data.get("make")
        year = payload.get("year") or model_data.get("year")
    else:
        model_name = model_data
        make = payload.get("make")
        year = payload.get("year")

    return BouncieDeviceMetadata(
        imei=imei,
        vin=_clean(payload.get("vin")),
        make=make,
        model=model_name,
        year=year,
        nickname=payload.get("nickName"),
        standard_engine=payload.get("standardEngine"),
        raw=payload,
    )


class FleetRegistry:
    """
    Single source of truth for Bouncie Devices.

    Device identity is the IMEI. VIN describes the physical vehicle and
    can move between devices when a tracker is replaced, so every write
    that assigns a VIN goes through :meth:`_release_vin` first -- the
    ``vehicles.vin`` index is unique and sparse.

    Writers differ in authority. Bouncie is authoritative for vehicle
    metadata, the user is authoritative for the display name and whether
    a device is active, and trip recovery may only fill in blanks.
    """

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    @staticmethod
    async def list_active_devices(
        *,
        selected_imeis: list[str] | None = None,
    ) -> list[Vehicle]:
        conditions = [Vehicle.is_active == True]  # noqa: E712
        selected = _normalize_imeis(selected_imeis)
        if selected_imeis is not None:
            if not selected:
                return []
            conditions.append(In(Vehicle.imei, selected))

        return await Vehicle.find(*conditions).sort(Vehicle.created_at).to_list()

    @staticmethod
    async def list_active_imeis(
        *,
        selected_imeis: list[str] | None = None,
    ) -> list[str]:
        devices = await FleetRegistry.list_active_devices(
            selected_imeis=selected_imeis,
        )
        return _normalize_imeis([device.imei for device in devices])

    @staticmethod
    async def has_active_devices() -> bool:
        return bool(await Vehicle.find(Vehicle.is_active == True).count())  # noqa: E712

    @staticmethod
    async def get_device(imei: str) -> Vehicle | None:
        cleaned = _clean(imei)
        if not cleaned:
            return None
        return await Vehicle.find_one(Vehicle.imei == cleaned)

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    @staticmethod
    async def _release_vin(vin: str | None, *, keep_imei: str) -> bool:
        """
        Free a VIN currently recorded against a different device.

        A tracker moved into another car legitimately carries its VIN with
        it. Without releasing the prior holder first, assigning the VIN
        violates the unique index.
        """
        cleaned = _clean(vin)
        if not cleaned:
            return False
        holder = await Vehicle.find_one(Vehicle.vin == cleaned)
        if holder is None or holder.imei == keep_imei:
            return False
        holder.vin = None
        holder.updated_at = datetime.now(UTC)
        await holder.save()
        return True

    @staticmethod
    async def register_device(
        imei: str,
        *,
        custom_name: str | None = None,
    ) -> Vehicle:
        """
        Create or reactivate a device the user asked for by IMEI.

        Used by manual entry, which is the recovery path when a device is
        missing from the Bouncie vehicles endpoint.
        """
        cleaned = _clean(imei)
        if not cleaned:
            msg = "Vehicle IMEI is required"
            raise ValueError(msg)

        now = datetime.now(UTC)
        vehicle = await Vehicle.find_one(Vehicle.imei == cleaned)
        if vehicle is None:
            vehicle = Vehicle(
                imei=cleaned,
                custom_name=_clean(custom_name),
                is_active=True,
                created_at=now,
                updated_at=now,
            )
            await vehicle.insert()
            return vehicle

        if custom_name is not None:
            vehicle.custom_name = _clean(custom_name)
        vehicle.is_active = True
        vehicle.updated_at = now
        await vehicle.save()
        return vehicle

    @staticmethod
    async def apply_bouncie_metadata(
        metadata: BouncieDeviceMetadata,
        *,
        custom_name: str | None = None,
        activate: bool | None = None,
    ) -> Vehicle:
        """
        Record what Bouncie reports for one device.

        Bouncie owns the vehicle metadata. A name the user chose is kept;
        an existing device's active flag is left alone unless a caller
        explicitly asks to change it, so a locally retired tracker is not
        silently revived by a routine refresh.
        """
        now = datetime.now(UTC)
        vehicle = await Vehicle.find_one(Vehicle.imei == metadata.imei)
        await FleetRegistry._release_vin(metadata.vin, keep_imei=metadata.imei)

        if vehicle is None:
            vehicle = Vehicle(
                imei=metadata.imei,
                custom_name=_clean(custom_name) or metadata.default_name,
                is_active=True if activate is None else activate,
                created_at=now,
            )

        vehicle.vin = metadata.vin
        vehicle.make = metadata.make
        vehicle.model = metadata.model
        vehicle.year = metadata.year
        vehicle.bouncie_nickname = metadata.nickname
        vehicle.standard_engine = metadata.standard_engine
        vehicle.bouncie_data = metadata.raw
        vehicle.last_synced_at = now
        vehicle.updated_at = now

        explicit_name = _clean(custom_name)
        if explicit_name:
            vehicle.custom_name = explicit_name
        elif not _clean(vehicle.custom_name):
            vehicle.custom_name = metadata.default_name

        if activate is not None:
            vehicle.is_active = activate

        if vehicle.id is None:
            await vehicle.insert()
        else:
            await vehicle.save()
        return vehicle

    @staticmethod
    async def recover_device_from_trips(
        imei: str,
        *,
        vin: str | None = None,
    ) -> tuple[Vehicle | None, bool]:
        """
        Discover a device seen in trip history but missing from the registry.

        This is the lowest-authority writer: Bouncie's vehicles endpoint
        has been observed omitting a device that is nonetheless producing
        trips. It may create a record or fill a blank VIN, and must never
        overwrite metadata that a higher-authority writer supplied.

        Returns the device and whether it was newly created.
        """
        cleaned = _clean(imei)
        if not cleaned:
            return None, False

        now = datetime.now(UTC)
        vehicle = await Vehicle.find_one(Vehicle.imei == cleaned)
        cleaned_vin = _clean(vin)

        if vehicle is None:
            if cleaned_vin:
                await FleetRegistry._release_vin(cleaned_vin, keep_imei=cleaned)
            vehicle = Vehicle(
                imei=cleaned,
                vin=cleaned_vin,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
            await vehicle.insert()
            return vehicle, True

        if cleaned_vin and not _clean(vehicle.vin):
            await FleetRegistry._release_vin(cleaned_vin, keep_imei=cleaned)
            vehicle.vin = cleaned_vin
            vehicle.updated_at = now
            await vehicle.save()
            return vehicle, False

        return vehicle, False

    @staticmethod
    async def assign_vin(imei: str, vin: str | None) -> Vehicle | None:
        """Set a device's VIN, releasing whichever device held it before."""
        vehicle = await FleetRegistry.get_device(imei)
        if vehicle is None:
            return None
        cleaned_vin = _clean(vin)
        if cleaned_vin:
            await FleetRegistry._release_vin(cleaned_vin, keep_imei=vehicle.imei)
        vehicle.vin = cleaned_vin
        vehicle.updated_at = datetime.now(UTC)
        await vehicle.save()
        return vehicle

    @staticmethod
    async def deactivate_device(imei: str) -> Vehicle | None:
        """Retire a device while preserving its historical trip linkage."""
        vehicle = await FleetRegistry.get_device(imei)
        if vehicle is None:
            return None
        vehicle.is_active = False
        vehicle.updated_at = datetime.now(UTC)
        await vehicle.save()
        return vehicle


__all__ = [
    "BouncieDeviceMetadata",
    "FleetRegistry",
    "normalize_bouncie_vehicle",
]
