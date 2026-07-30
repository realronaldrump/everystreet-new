"""Authoritative Fleet Registry queries for Bouncie Device eligibility."""

from __future__ import annotations

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


class FleetRegistry:
    """Single source of truth for active Bouncie Devices."""

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


__all__ = ["FleetRegistry"]
