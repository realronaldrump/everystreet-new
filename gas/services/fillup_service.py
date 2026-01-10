"""Business logic for gas fill-up management and MPG calculations."""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId

from core.exceptions import ResourceNotFoundException, ValidationException
from db import (
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    gas_fillups_collection,
    insert_one_with_retry,
    update_one_with_retry,
    vehicles_collection,
)
from gas.serializers import parse_iso_datetime

logger = logging.getLogger(__name__)


class FillupService:
    """Service class for gas fill-up operations."""

    @staticmethod
    async def get_fillups(
        imei: str | None = None,
        vin: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Get gas fill-up records with optional filters.

        Args:
            imei: Optional IMEI filter
            vin: Optional VIN filter
            start_date: Optional start date ISO string
            end_date: Optional end date ISO string
            limit: Maximum number of records to return

        Returns:
            List of fill-up documents
        """
        query: dict[str, Any] = {}

        if imei:
            query["imei"] = imei
        if vin:
            query["vin"] = vin

        # Date filtering
        if start_date or end_date:
            date_query: dict[str, Any] = {}
            if start_date:
                date_query["$gte"] = parse_iso_datetime(start_date)
            if end_date:
                date_query["$lte"] = parse_iso_datetime(end_date)
            query["fillup_time"] = date_query

        fillups = await find_with_retry(
            gas_fillups_collection,
            query,
            sort=[("fillup_time", -1)],
            limit=limit,
        )

        return fillups

    @staticmethod
    async def get_fillup_by_id(fillup_id: str) -> dict[str, Any] | None:
        """Get a specific gas fill-up by ID.

        Args:
            fillup_id: Fill-up ObjectId string

        Returns:
            Fill-up document or None if not found
        """
        if not ObjectId.is_valid(fillup_id):
            raise ValidationException("Invalid fillup ID")

        return await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )

    @staticmethod
    def calculate_mpg(
        current_odometer: float,
        current_gallons: float,
        previous_fillup: dict[str, Any] | None,
        is_full_tank: bool,
        missed_previous: bool,
    ) -> tuple[float | None, float | None, float | None]:
        """Calculate MPG for a fill-up.

        Strict MPG Rules:
        1. Previous fill-up must exist and have odometer
        2. Previous fill-up must be IS_FULL_TANK (establishes known full state)
        3. Current fill-up must be IS_FULL_TANK (measures usage to return to full)
        4. User must NOT have marked "Missed Previous"

        Args:
            current_odometer: Current odometer reading
            current_gallons: Gallons filled
            previous_fillup: Previous fill-up document
            is_full_tank: Whether current fill-up is full tank
            missed_previous: Whether user marked missed previous

        Returns:
            Tuple of (calculated_mpg, miles_since_last, previous_odometer)
        """
        if not previous_fillup:
            return None, None, None

        previous_odometer = previous_fillup.get("odometer")
        if not previous_odometer:
            return None, None, None

        # Check all MPG calculation requirements
        previous_is_full = previous_fillup.get("is_full_tank")
        if previous_is_full is None:
            previous_is_full = (
                True  # Default to True if missing (backward compatibility)
            )

        if not previous_is_full or not is_full_tank or missed_previous:
            return None, None, previous_odometer

        # Calculate MPG
        miles_since_last = current_odometer - previous_odometer
        if miles_since_last > 0 and current_gallons > 0:
            calculated_mpg = miles_since_last / current_gallons
            return calculated_mpg, miles_since_last, previous_odometer

        return None, None, previous_odometer

    @staticmethod
    async def create_fillup(fillup_data: dict[str, Any]) -> dict[str, Any]:
        """Create a new gas fill-up record.

        Args:
            fillup_data: Fill-up data dictionary

        Returns:
            Created fill-up document
        """
        # Convert string datetime to datetime object if needed
        fillup_time = parse_iso_datetime(fillup_data["fillup_time"])

        # Get vehicle info if available
        vehicle = await find_one_with_retry(
            vehicles_collection, {"imei": fillup_data["imei"]}
        )
        vin = vehicle.get("vin") if vehicle else None

        # Get previous fill-up to calculate MPG
        previous_fillup = await find_one_with_retry(
            gas_fillups_collection,
            {"imei": fillup_data["imei"], "fillup_time": {"$lt": fillup_time}},
            sort=[("fillup_time", -1)],
        )

        # Calculate MPG if we have odometer readings
        calculated_mpg = None
        miles_since_last = None
        previous_odometer = None

        if fillup_data.get("odometer") and previous_fillup:
            calculated_mpg, miles_since_last, previous_odometer = (
                FillupService.calculate_mpg(
                    fillup_data["odometer"],
                    fillup_data["gallons"],
                    previous_fillup,
                    fillup_data.get("is_full_tank", True),
                    fillup_data.get("missed_previous", False),
                )
            )

        # Calculate total cost if not provided
        total_cost = fillup_data.get("total_cost")
        if (
            not total_cost
            and fillup_data.get("price_per_gallon")
            and fillup_data.get("gallons")
        ):
            total_cost = fillup_data["price_per_gallon"] * fillup_data["gallons"]

        # Create fill-up document
        fillup_doc = {
            "imei": fillup_data["imei"],
            "vin": vin,
            "fillup_time": fillup_time,
            "gallons": fillup_data["gallons"],
            "price_per_gallon": fillup_data.get("price_per_gallon"),
            "total_cost": total_cost,
            "odometer": fillup_data.get("odometer"),
            "latitude": fillup_data.get("latitude"),
            "longitude": fillup_data.get("longitude"),
            "is_full_tank": fillup_data.get("is_full_tank", True),
            "missed_previous": fillup_data.get("missed_previous", False),
            "notes": fillup_data.get("notes"),
            "previous_odometer": previous_odometer,
            "miles_since_last_fillup": miles_since_last,
            "calculated_mpg": calculated_mpg,
            "detected_automatically": False,
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        }

        result = await insert_one_with_retry(gas_fillups_collection, fillup_doc)
        fillup_doc["_id"] = result.inserted_id

        # Trigger recalculation of next entry
        await FillupService.recalculate_subsequent_fillup(
            fillup_data["imei"], fillup_time
        )

        return fillup_doc

    @staticmethod
    async def update_fillup(
        fillup_id: str, update_data: dict[str, Any]
    ) -> dict[str, Any]:
        """Update a gas fill-up record.

        Args:
            fillup_id: Fill-up ObjectId string
            update_data: Fields to update (from model_dump with exclude_unset=True)

        Returns:
            Updated fill-up document

        Raises:
            ValueError: If fill-up not found
        """
        if not ObjectId.is_valid(fillup_id):
            raise ValidationException("Invalid fillup ID")

        # Check if fillup exists
        existing = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )
        if not existing:
            raise ResourceNotFoundException("Fill-up not found")

        update_data["updated_at"] = datetime.now(UTC)

        current_time = update_data.get("fillup_time", existing["fillup_time"])
        imei = update_data.get("imei", existing["imei"])

        # Recalculate MPG for THIS entry if fields that affect it changed
        fields_affecting_mpg = ["gallons", "odometer", "fillup_time"]
        if any(f in update_data for f in fields_affecting_mpg):
            previous_fillup = await find_one_with_retry(
                gas_fillups_collection,
                {
                    "imei": imei,
                    "fillup_time": {"$lt": current_time},
                    "_id": {"$ne": ObjectId(fillup_id)},  # Exclude self
                },
                sort=[("fillup_time", -1)],
            )

            # Use new values or fallback to existing
            current_odometer = (
                update_data.get("odometer", existing.get("odometer"))
                if "odometer" in update_data
                else existing.get("odometer")
            )
            current_gallons = update_data.get("gallons", existing.get("gallons"))

            # Get current flags
            curr_is_full = update_data.get("is_full_tank", existing.get("is_full_tank"))
            if curr_is_full is None:
                curr_is_full = True

            curr_missed_prev = update_data.get(
                "missed_previous", existing.get("missed_previous")
            )

            # Calculate stats
            if previous_fillup and current_odometer is not None:
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
                update_data["calculated_mpg"] = calculated_mpg
                update_data["miles_since_last_fillup"] = miles_since_last
                update_data["previous_odometer"] = previous_odometer

        # Recalculate total cost if price or gallons changed
        if update_data.get("price_per_gallon") and update_data.get("gallons"):
            update_data["total_cost"] = (
                update_data["price_per_gallon"] * update_data["gallons"]
            )

        # Update document
        await update_one_with_retry(
            gas_fillups_collection,
            {"_id": ObjectId(fillup_id)},
            {"$set": update_data},
        )

        # Trigger recalculation of next entry
        await FillupService.recalculate_subsequent_fillup(imei, current_time)

        # Fetch and return updated fill-up
        updated = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )
        return updated

    @staticmethod
    async def delete_fillup(fillup_id: str) -> dict[str, str]:
        """Delete a gas fill-up record.

        Args:
            fillup_id: Fill-up ObjectId string

        Returns:
            Success message

        Raises:
            ValueError: If fill-up not found
        """
        if not ObjectId.is_valid(fillup_id):
            raise ValidationException("Invalid fillup ID")

        # Get existing to find IMEI and time
        existing = await find_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )
        if not existing:
            raise ResourceNotFoundException("Fill-up not found")

        result = await delete_one_with_retry(
            gas_fillups_collection, {"_id": ObjectId(fillup_id)}
        )

        if result.deleted_count == 0:
            raise ResourceNotFoundException("Fill-up not found")

        # Recalculate the next entry now that this one is gone
        await FillupService.recalculate_subsequent_fillup(
            existing["imei"], existing["fillup_time"]
        )

        return {"status": "success", "message": "Fill-up deleted"}

    @staticmethod
    async def recalculate_subsequent_fillup(imei: str, after_time: datetime) -> None:
        """Finds the next fill-up after 'after_time' and recalculates its MPG/distance stats.

        This ensures cascading recalculation when fill-ups are inserted, updated, or deleted.

        Args:
            imei: Vehicle IMEI
            after_time: Look for fill-ups after this time
        """
        try:
            # Find the immediately following fill-up
            next_fillup = await find_one_with_retry(
                gas_fillups_collection,
                {"imei": imei, "fillup_time": {"$gt": after_time}},
                sort=[("fillup_time", 1)],
            )

            if not next_fillup:
                return

            # Now find the fill-up immediately before THIS 'next_fillup'
            # (This effectively bridges the gap if the middle one was deleted)
            prev_fillup = await find_one_with_retry(
                gas_fillups_collection,
                {"imei": imei, "fillup_time": {"$lt": next_fillup["fillup_time"]}},
                sort=[("fillup_time", -1)],
            )

            # Calculate new stats for next_fillup
            next_odo = next_fillup.get("odometer")
            next_is_full = next_fillup.get("is_full_tank", True)
            next_missed_prev = next_fillup.get("missed_previous", False)

            if prev_fillup and next_odo is not None:
                calculated_mpg, miles_since_last, previous_odometer = (
                    FillupService.calculate_mpg(
                        next_odo,
                        next_fillup.get("gallons", 0),
                        prev_fillup,
                        next_is_full,
                        next_missed_prev,
                    )
                )

                updates = {
                    "calculated_mpg": calculated_mpg,
                    "miles_since_last_fillup": miles_since_last,
                    "previous_odometer": previous_odometer,
                }
            else:
                # Broken chain
                updates = {
                    "miles_since_last_fillup": None,
                    "calculated_mpg": None,
                    "previous_odometer": (
                        prev_fillup.get("odometer") if prev_fillup else None
                    ),
                }

            if updates:
                await update_one_with_retry(
                    gas_fillups_collection,
                    {"_id": next_fillup["_id"]},
                    {"$set": updates},
                )
                logger.info("Recalculated stats for fill-up %s", next_fillup["_id"])

        except Exception as e:
            logger.error("Error recalculating subsequent fillup: %s", e)
