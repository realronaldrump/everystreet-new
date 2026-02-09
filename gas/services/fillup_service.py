"""Business logic for gas fill-up management and MPG calculations."""

import logging
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId

from core.date_utils import parse_timestamp
from core.exceptions import ResourceNotFoundException, ValidationException
from db.models import GasFillup, Vehicle

logger = logging.getLogger(__name__)


class FillupService:
    """Service class for gas fill-up operations."""

    @staticmethod
    async def _get_previous_fillup(
        *,
        imei: str,
        before_time: datetime,
        exclude_id: PydanticObjectId | None = None,
    ) -> GasFillup | None:
        """Fetch the most recent fill-up before `before_time` for an IMEI."""

        conditions: list[Any] = [
            GasFillup.imei == imei,
            GasFillup.fillup_time < before_time,
        ]
        if exclude_id is not None:
            conditions.append(GasFillup.id != exclude_id)

        return await (
            GasFillup.find(*conditions).sort(-GasFillup.fillup_time).first_or_none()
        )

    @staticmethod
    async def _get_next_fillup(*, imei: str, after_time: datetime) -> GasFillup | None:
        """Fetch the next fill-up after `after_time` for an IMEI."""

        return await (
            GasFillup.find(
                GasFillup.imei == imei,
                GasFillup.fillup_time > after_time,
            )
            .sort(GasFillup.fillup_time)
            .first_or_none()
        )

    @staticmethod
    async def get_fillups(
        imei: str | None = None,
        vin: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        limit: int = 100,
    ) -> list[GasFillup]:
        """
        Get gas fill-up records with optional filters.

        Args:
            imei: Optional IMEI filter
            vin: Optional VIN filter
            start_date: Optional start date ISO string
            end_date: Optional end date ISO string
            limit: Maximum number of records to return

        Returns:
            List of GasFillup models
        """
        conditions = []

        if imei:
            conditions.append(GasFillup.imei == imei)
        if vin:
            conditions.append(GasFillup.vin == vin)

        # Date filtering
        if start_date:
            start_dt = parse_timestamp(start_date)
            if start_dt:
                conditions.append(GasFillup.fillup_time >= start_dt)
        if end_date:
            end_dt = parse_timestamp(end_date)
            if end_dt:
                conditions.append(GasFillup.fillup_time <= end_dt)

        query = GasFillup.find(*conditions) if conditions else GasFillup.find_all()

        return await query.sort(-GasFillup.fillup_time).limit(limit).to_list()

    @staticmethod
    async def get_fillup_by_id(fillup_id: str) -> GasFillup | None:
        """
        Get a specific gas fill-up by ID.

        Args:
            fillup_id: Fill-up ObjectId string

        Returns:
            GasFillup model or None if not found
        """
        if not PydanticObjectId.is_valid(fillup_id):
            msg = "Invalid fillup ID"
            raise ValidationException(msg)

        return await GasFillup.get(fillup_id)

    @staticmethod
    def calculate_mpg(
        current_odometer: float,
        current_gallons: float,
        previous_fillup: GasFillup | None,
        is_full_tank: bool,
        missed_previous: bool,
    ) -> tuple[float | None, float | None, float | None]:
        """
        Calculate MPG for a fill-up.

        Strict MPG Rules:
        1. Previous fill-up must exist and have odometer
        2. Previous fill-up must be IS_FULL_TANK (establishes known full state)
        3. Current fill-up must be IS_FULL_TANK (measures usage to return to full)
        4. User must NOT have marked "Missed Previous"

        Args:
            current_odometer: Current odometer reading
            current_gallons: Gallons filled
            previous_fillup: Previous GasFillup model
            is_full_tank: Whether current fill-up is full tank
            missed_previous: Whether user marked missed previous

        Returns:
            Tuple of (calculated_mpg, miles_since_last, previous_odometer)
        """
        if not previous_fillup:
            return None, None, None

        previous_odometer = previous_fillup.odometer
        if previous_odometer is None:
            return None, None, None

        # Check all MPG calculation requirements
        previous_is_full = previous_fillup.is_full_tank
        if previous_is_full is None:
            previous_is_full = True  # Default to True if missing

        if not previous_is_full or not is_full_tank or missed_previous:
            return None, None, previous_odometer

        # Calculate MPG
        miles_since_last = current_odometer - previous_odometer
        if miles_since_last > 0 and current_gallons > 0:
            calculated_mpg = miles_since_last / current_gallons
            return calculated_mpg, miles_since_last, previous_odometer

        return None, None, previous_odometer

    @staticmethod
    async def create_fillup(fillup_data: dict[str, Any]) -> GasFillup:
        """
        Create a new gas fill-up record.

        Args:
            fillup_data: Fill-up data dictionary

        Returns:
            Created GasFillup model
        """
        # Convert string datetime to datetime object if needed
        fillup_time = parse_timestamp(fillup_data["fillup_time"])
        if not fillup_time:
            msg = "Invalid fillup_time format"
            raise ValidationException(msg)

        imei = str(fillup_data.get("imei") or "")
        if not imei:
            msg = "Missing imei"
            raise ValidationException(msg)

        gallons = fillup_data.get("gallons")
        if gallons is None or gallons <= 0:
            msg = "gallons must be greater than 0"
            raise ValidationException(msg)

        odometer = fillup_data.get("odometer")
        if odometer is not None and odometer < 0:
            msg = "odometer must be greater than or equal to 0"
            raise ValidationException(msg)

        price_per_gallon = fillup_data.get("price_per_gallon")
        if price_per_gallon is not None and price_per_gallon < 0:
            msg = "price_per_gallon must be greater than or equal to 0"
            raise ValidationException(msg)

        total_cost = fillup_data.get("total_cost")
        if total_cost is not None and total_cost < 0:
            msg = "total_cost must be greater than or equal to 0"
            raise ValidationException(msg)

        # Get vehicle info if available
        vehicle = await Vehicle.find_one(Vehicle.imei == imei)
        vin = vehicle.vin if vehicle else None

        # Get previous fill-up to calculate MPG
        previous_fillup = await FillupService._get_previous_fillup(
            imei=imei,
            before_time=fillup_time,
        )

        # Calculate MPG if we have odometer readings
        calculated_mpg = None
        miles_since_last = None
        previous_odometer = None

        if fillup_data.get("odometer") is not None and previous_fillup:
            calculated_mpg, miles_since_last, previous_odometer = (
                FillupService.calculate_mpg(
                    fillup_data["odometer"],
                    gallons,
                    previous_fillup,
                    fillup_data.get("is_full_tank", True),
                    fillup_data.get("missed_previous", False),
                )
            )

        # Calculate total cost if not provided
        if total_cost is None and price_per_gallon is not None and price_per_gallon > 0:
            total_cost = price_per_gallon * gallons

        # Create GasFillup model
        fillup = GasFillup(
            imei=imei,
            vin=vin,
            fillup_time=fillup_time,
            gallons=gallons,
            price_per_gallon=price_per_gallon,
            total_cost=total_cost,
            odometer=fillup_data.get("odometer"),
            latitude=fillup_data.get("latitude"),
            longitude=fillup_data.get("longitude"),
            is_full_tank=fillup_data.get("is_full_tank", True),
            missed_previous=fillup_data.get("missed_previous", False),
            previous_odometer=previous_odometer,
            miles_since_last_fillup=miles_since_last,
            calculated_mpg=calculated_mpg,
            detected_automatically=False,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

        await fillup.insert()

        # Trigger recalculation of next entry
        await FillupService.recalculate_subsequent_fillup(
            imei,
            fillup_time,
        )

        return fillup

    @staticmethod
    async def update_fillup(fillup_id: str, update_data: dict[str, Any]) -> GasFillup:
        """
        Update a gas fill-up record.

        Args:
            fillup_id: Fill-up ObjectId string
            update_data: Fields to update (from model_dump with exclude_unset=True)

        Returns:
            Updated GasFillup model

        Raises:
            ValueError: If fill-up not found
        """
        if not PydanticObjectId.is_valid(fillup_id):
            msg = "Invalid fillup ID"
            raise ValidationException(msg)

        # Check if fillup exists
        fillup = await GasFillup.get(fillup_id)
        if not fillup:
            msg = "Fill-up not found"
            raise ResourceNotFoundException(msg)

        original_time = fillup.fillup_time
        original_imei = fillup.imei

        current_time = update_data.get("fillup_time", fillup.fillup_time)
        if current_time is not None:
            parsed_time = parse_timestamp(current_time)
            if not parsed_time:
                msg = "Invalid fillup_time format"
                raise ValidationException(msg)
            current_time = parsed_time
            update_data["fillup_time"] = parsed_time

        imei = str(update_data.get("imei", fillup.imei) or "")
        if not imei:
            msg = "Missing imei"
            raise ValidationException(msg)
        update_data["imei"] = imei

        if "gallons" in update_data:
            gallons = update_data.get("gallons")
            if gallons is None or gallons <= 0:
                msg = "gallons must be greater than 0"
                raise ValidationException(msg)

        if "odometer" in update_data:
            odometer = update_data.get("odometer")
            if odometer is not None and odometer < 0:
                msg = "odometer must be greater than or equal to 0"
                raise ValidationException(msg)

        if "price_per_gallon" in update_data:
            price = update_data.get("price_per_gallon")
            if price is not None and price < 0:
                msg = "price_per_gallon must be greater than or equal to 0"
                raise ValidationException(msg)

        if "total_cost" in update_data:
            total_cost = update_data.get("total_cost")
            if total_cost is not None and total_cost < 0:
                msg = "total_cost must be greater than or equal to 0"
                raise ValidationException(msg)

        # If vehicle changed, refresh VIN for the new IMEI.
        if imei != original_imei:
            vehicle = await Vehicle.find_one(Vehicle.imei == imei)
            fillup.vin = vehicle.vin if vehicle else None

        # Recalculate MPG for THIS entry if fields that affect it changed
        fields_affecting_mpg = [
            "gallons",
            "odometer",
            "fillup_time",
            "is_full_tank",
            "missed_previous",
            "imei",
        ]
        if any(f in update_data for f in fields_affecting_mpg):
            previous_fillup = None
            if current_time is not None:
                previous_fillup = await FillupService._get_previous_fillup(
                    imei=imei,
                    before_time=current_time,
                    exclude_id=fillup.id,
                )

            # Use new values or fallback to existing
            current_odometer = (
                update_data.get("odometer", fillup.odometer)
                if "odometer" in update_data
                else fillup.odometer
            )
            current_gallons = update_data.get("gallons", fillup.gallons)

            # Get current flags
            curr_is_full = update_data.get("is_full_tank", fillup.is_full_tank)
            if curr_is_full is None:
                curr_is_full = True

            curr_missed_prev = update_data.get(
                "missed_previous",
                getattr(fillup, "missed_previous", False),
            )

            # Calculate stats
            if (
                previous_fillup
                and current_odometer is not None
                and current_gallons is not None
            ):
                calculated_mpg, miles_since_last, previous_odometer = (
                    FillupService.calculate_mpg(
                        current_odometer,
                        current_gallons,
                        previous_fillup,
                        curr_is_full,
                        curr_missed_prev,
                    )
                )

                # Update derived fields
                fillup.calculated_mpg = calculated_mpg
                fillup.miles_since_last_fillup = miles_since_last
                fillup.previous_odometer = previous_odometer
            else:
                # Clear derived fields when required inputs are missing or the
                # chain is broken.
                fillup.calculated_mpg = None
                fillup.miles_since_last_fillup = None
                fillup.previous_odometer = (
                    previous_fillup.odometer if previous_fillup else None
                )

        # Recalculate total cost if price or gallons changed (or clear if missing).
        if "price_per_gallon" in update_data or "gallons" in update_data:
            price = update_data.get("price_per_gallon", fillup.price_per_gallon)
            gallons = update_data.get("gallons", fillup.gallons)
            if price is not None and gallons is not None and gallons > 0:
                fillup.total_cost = price * gallons
            else:
                fillup.total_cost = None

        # Apply all update_data fields to the fillup model
        for key, value in update_data.items():
            if hasattr(fillup, key):
                setattr(fillup, key, value)

        # Update timestamp
        fillup.updated_at = datetime.now(UTC)
        await fillup.save()

        # Trigger recalculation of neighbors. Updates can move the fill-up in time
        # or across vehicles, which can affect the "next" fill-up in both the old
        # and new positions.
        recalc_targets = set()
        if original_imei and original_time:
            recalc_targets.add((original_imei, original_time))
        if imei and current_time:
            recalc_targets.add((imei, current_time))
        for target_imei, target_time in recalc_targets:
            await FillupService.recalculate_subsequent_fillup(target_imei, target_time)

        return fillup

    @staticmethod
    async def delete_fillup(fillup_id: str) -> dict[str, str]:
        """
        Delete a gas fill-up record.

        Args:
            fillup_id: Fill-up ObjectId string

        Returns:
            Success message

        Raises:
            ValueError: If fill-up not found
        """
        if not PydanticObjectId.is_valid(fillup_id):
            msg = "Invalid fillup ID"
            raise ValidationException(msg)

        # Get existing to find IMEI and time
        fillup = await GasFillup.get(fillup_id)
        if not fillup:
            msg = "Fill-up not found"
            raise ResourceNotFoundException(msg)

        imei = fillup.imei
        fillup_time = fillup.fillup_time

        await fillup.delete()

        # Recalculate the next entry now that this one is gone
        await FillupService.recalculate_subsequent_fillup(imei, fillup_time)

        return {"status": "success", "message": "Fill-up deleted"}

    @staticmethod
    async def recalculate_subsequent_fillup(imei: str, after_time: datetime) -> None:
        """
        Finds the next fill-up after 'after_time' and recalculates its MPG/distance
        stats.

        This ensures cascading recalculation when fill-ups are inserted, updated, or deleted.

        Args:
            imei: Vehicle IMEI
            after_time: Look for fill-ups after this time
        """
        if not imei or after_time is None:
            return

        try:
            # Find the immediately following fill-up
            next_fillup = await FillupService._get_next_fillup(
                imei=imei,
                after_time=after_time,
            )

            if not next_fillup:
                return

            # Now find the fill-up immediately before THIS 'next_fillup'
            # (This effectively bridges the gap if the middle one was deleted)
            prev_fillup = None
            if next_fillup.fillup_time is not None:
                prev_fillup = await FillupService._get_previous_fillup(
                    imei=imei,
                    before_time=next_fillup.fillup_time,
                    exclude_id=next_fillup.id,
                )

            # Calculate new stats for next_fillup
            next_odo = next_fillup.odometer
            next_is_full = (
                next_fillup.is_full_tank
                if next_fillup.is_full_tank is not None
                else True
            )
            next_missed_prev = next_fillup.missed_previous or False

            if prev_fillup and next_odo is not None:
                calculated_mpg, miles_since_last, previous_odometer = (
                    FillupService.calculate_mpg(
                        next_odo,
                        next_fillup.gallons or 0,
                        prev_fillup,
                        next_is_full,
                        next_missed_prev,
                    )
                )

                next_fillup.calculated_mpg = calculated_mpg
                next_fillup.miles_since_last_fillup = miles_since_last
                next_fillup.previous_odometer = previous_odometer
            else:
                # Broken chain
                next_fillup.miles_since_last_fillup = None
                next_fillup.calculated_mpg = None
                next_fillup.previous_odometer = (
                    prev_fillup.odometer if prev_fillup else None
                )

            await next_fillup.save()
            logger.info("Recalculated stats for fill-up %s", next_fillup.id)

        except Exception:
            logger.exception("Error recalculating subsequent fillup")
