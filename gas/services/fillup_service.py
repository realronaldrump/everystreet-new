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

    _MAX_CHAIN_LOOKBACK = 250

    @staticmethod
    def _sort_desc():
        """Stable descending sort for fill-up timeline traversal."""
        return [("fillup_time", -1), ("_id", -1)]

    @staticmethod
    def _sort_asc():
        """Stable ascending sort for fill-up timeline traversal."""
        return [("fillup_time", 1), ("_id", 1)]

    @staticmethod
    async def _get_previous_fillup(
        *,
        imei: str,
        before_time: datetime,
        anchor_id: PydanticObjectId | None = None,
        exclude_id: PydanticObjectId | None = None,
    ) -> GasFillup | None:
        """
        Fetch the previous fill-up in timeline order for an IMEI.

        If `anchor_id` is provided, same-timestamp ordering is resolved via `_id`,
        so we can reliably traverse records with identical fill-up timestamps.
        """

        query: dict[str, Any] = {"imei": imei}
        if anchor_id is not None:
            query["$or"] = [
                {"fillup_time": {"$lt": before_time}},
                {"fillup_time": before_time, "_id": {"$lt": anchor_id}},
            ]
        else:
            # For new records (no anchor id yet), allow same-time matches.
            query["fillup_time"] = {"$lte": before_time}
        if exclude_id is not None:
            query["_id"] = {"$ne": exclude_id}

        return await (
            GasFillup.find(query).sort(FillupService._sort_desc()).first_or_none()
        )

    @staticmethod
    async def _get_next_fillup(
        *,
        imei: str,
        after_time: datetime,
        anchor_id: PydanticObjectId | None = None,
        exclude_id: PydanticObjectId | None = None,
    ) -> GasFillup | None:
        """
        Fetch the next fill-up in timeline order for an IMEI.

        If `anchor_id` is provided, same-timestamp ordering is resolved via `_id`.
        """

        query: dict[str, Any] = {"imei": imei}
        if anchor_id is not None:
            query["$or"] = [
                {"fillup_time": {"$gt": after_time}},
                {"fillup_time": after_time, "_id": {"$gt": anchor_id}},
            ]
        else:
            # When no anchor exists (e.g. deleted record), include same-time rows.
            query["fillup_time"] = {"$gte": after_time}
        if exclude_id is not None:
            query["_id"] = {"$ne": exclude_id}

        return await (
            GasFillup.find(query)
            .sort(FillupService._sort_asc())
            .first_or_none()
        )

    @staticmethod
    async def _calculate_fillup_stats(
        *,
        imei: str,
        fillup_time: datetime,
        current_id: PydanticObjectId | None,
        current_odometer: float | None,
        current_gallons: float | None,
        is_full_tank: bool,
        missed_previous: bool,
    ) -> tuple[float | None, float | None, float | None]:
        """
        Calculate derived MPG fields for a fill-up.

        MPG rule:
        - Current fill-up must be full and not flagged missed_previous.
        - Walk backwards through prior fill-ups until a previous full-tank anchor.
        - Sum gallons from all fill-ups between anchor and current (inclusive current).
        - Abort if chain is broken by any missed_previous flag or missing anchor odometer.
        """

        previous_fillup = await FillupService._get_previous_fillup(
            imei=imei,
            before_time=fillup_time,
            anchor_id=current_id,
            exclude_id=current_id,
        )
        immediate_previous_odometer = (
            previous_fillup.odometer if previous_fillup is not None else None
        )

        if current_odometer is None or current_gallons is None or current_gallons <= 0:
            return None, None, immediate_previous_odometer

        if missed_previous or not is_full_tank:
            return None, None, immediate_previous_odometer

        gallons_used = float(current_gallons)
        anchor_fillup: GasFillup | None = None
        cursor = previous_fillup
        steps = 0

        while cursor is not None and steps < FillupService._MAX_CHAIN_LOOKBACK:
            steps += 1

            if cursor.is_full_tank:
                # A full-tank row remains a valid anchor even if it was marked
                # missed_previous; that flag only invalidates MPG before it.
                anchor_fillup = cursor
                break

            if cursor.missed_previous:
                return None, None, immediate_previous_odometer

            if cursor.gallons is None or cursor.gallons <= 0:
                return None, None, immediate_previous_odometer
            gallons_used += float(cursor.gallons)

            if cursor.fillup_time is None:
                cursor = None
                break

            cursor = await FillupService._get_previous_fillup(
                imei=imei,
                before_time=cursor.fillup_time,
                anchor_id=cursor.id,
                exclude_id=cursor.id,
            )

        if cursor is not None and steps >= FillupService._MAX_CHAIN_LOOKBACK:
            logger.warning(
                "MPG chain walk exceeded %d entries for IMEI %s at %s",
                FillupService._MAX_CHAIN_LOOKBACK,
                imei,
                fillup_time,
            )
            return None, None, immediate_previous_odometer

        if anchor_fillup is None or anchor_fillup.odometer is None:
            return None, None, immediate_previous_odometer

        miles_since_last = current_odometer - anchor_fillup.odometer
        if miles_since_last > 0 and gallons_used > 0:
            calculated_mpg = miles_since_last / gallons_used
            return calculated_mpg, miles_since_last, anchor_fillup.odometer

        return None, None, anchor_fillup.odometer

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

        return await query.sort(FillupService._sort_desc()).limit(limit).to_list()

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

        is_full_tank = fillup_data.get("is_full_tank")
        if not isinstance(is_full_tank, bool):
            msg = "is_full_tank must be a boolean"
            raise ValidationException(msg)
        missed_previous = fillup_data.get("missed_previous", False)
        if not isinstance(missed_previous, bool):
            msg = "missed_previous must be a boolean"
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

        # Calculate derived stats.
        calculated_mpg, miles_since_last, previous_odometer = (
            await FillupService._calculate_fillup_stats(
                imei=imei,
                fillup_time=fillup_time,
                current_id=None,
                current_odometer=fillup_data.get("odometer"),
                current_gallons=gallons,
                is_full_tank=is_full_tank,
                missed_previous=missed_previous,
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
            is_full_tank=is_full_tank,
            missed_previous=missed_previous,
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
            anchor_id=fillup.id,
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

        if "is_full_tank" in update_data and not isinstance(update_data["is_full_tank"], bool):
            msg = "is_full_tank must be a boolean"
            raise ValidationException(msg)

        if "missed_previous" in update_data and not isinstance(
            update_data["missed_previous"],
            bool,
        ):
            msg = "missed_previous must be a boolean"
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
            # Use new values or existing values
            current_odometer = (
                update_data.get("odometer", fillup.odometer)
                if "odometer" in update_data
                else fillup.odometer
            )
            current_gallons = update_data.get("gallons", fillup.gallons)

            # Get current flags
            curr_is_full = update_data.get("is_full_tank", fillup.is_full_tank)

            curr_missed_prev = update_data.get("missed_previous", fillup.missed_previous)

            if current_time is not None:
                calculated_mpg, miles_since_last, previous_odometer = (
                    await FillupService._calculate_fillup_stats(
                        imei=imei,
                        fillup_time=current_time,
                        current_id=fillup.id,
                        current_odometer=current_odometer,
                        current_gallons=current_gallons,
                        is_full_tank=curr_is_full,
                        missed_previous=curr_missed_prev,
                    )
                )
            else:
                calculated_mpg, miles_since_last, previous_odometer = (None, None, None)

            # Update derived fields.
            fillup.calculated_mpg = calculated_mpg
            fillup.miles_since_last_fillup = miles_since_last
            fillup.previous_odometer = previous_odometer

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
        recalc_targets: set[tuple[str, datetime, PydanticObjectId | None]] = set()
        if original_imei and original_time:
            recalc_targets.add((original_imei, original_time, None))
        if imei and current_time:
            recalc_targets.add((imei, current_time, fillup.id))
        for target_imei, target_time, target_anchor_id in recalc_targets:
            await FillupService.recalculate_subsequent_fillup(
                target_imei,
                target_time,
                anchor_id=target_anchor_id,
            )

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
    async def recalculate_subsequent_fillup(
        imei: str,
        after_time: datetime,
        anchor_id: PydanticObjectId | None = None,
    ) -> None:
        """
        Finds the next fill-up after 'after_time' and recalculates its MPG/distance
        stats.

        This ensures cascading recalculation when fill-ups are inserted, updated, or deleted.

        Args:
            imei: Vehicle IMEI
            after_time: Look for fill-ups after this time
            anchor_id: Optional ID of the anchor fill-up at `after_time`
        """
        if not imei or after_time is None:
            return

        try:
            # Find the immediately following fill-up.
            next_fillup = await FillupService._get_next_fillup(
                imei=imei,
                after_time=after_time,
                anchor_id=anchor_id,
                exclude_id=anchor_id,
            )

            if not next_fillup or next_fillup.fillup_time is None:
                return

            calculated_mpg, miles_since_last, previous_odometer = (
                await FillupService._calculate_fillup_stats(
                    imei=imei,
                    fillup_time=next_fillup.fillup_time,
                    current_id=next_fillup.id,
                    current_odometer=next_fillup.odometer,
                    current_gallons=next_fillup.gallons,
                    is_full_tank=next_fillup.is_full_tank,
                    missed_previous=next_fillup.missed_previous,
                )
            )

            next_fillup.calculated_mpg = calculated_mpg
            next_fillup.miles_since_last_fillup = miles_since_last
            next_fillup.previous_odometer = previous_odometer
            await next_fillup.save()
            logger.info("Recalculated stats for fill-up %s", next_fillup.id)
        except Exception as exc:
            logger.exception("Error recalculating subsequent fillup")
            logger.warning(
                "Continuing after non-fatal recalc failure for IMEI=%s after_time=%s anchor_id=%s: %s",
                imei,
                after_time,
                anchor_id,
                exc,
            )
