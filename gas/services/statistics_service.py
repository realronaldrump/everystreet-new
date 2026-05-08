"""Service for gas consumption statistics and vehicle synchronization."""

import logging
from datetime import UTC, datetime
from typing import Any

from core.date_utils import parse_timestamp
from core.trip_source_policy import enforce_bouncie_source
from db.aggregation import aggregate_to_list
from db.models import GasFillup, Trip, Vehicle

logger = logging.getLogger(__name__)


class StatisticsService:
    """Service class for gas statistics and vehicle operations."""

    @staticmethod
    def _safe_float(value: Any) -> float | None:
        try:
            if value is None:
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _effective_price_per_gallon(fillup: GasFillup) -> float | None:
        gallons = StatisticsService._safe_float(fillup.gallons)
        total_cost = StatisticsService._safe_float(fillup.total_cost)
        price_per_gallon = StatisticsService._safe_float(fillup.price_per_gallon)

        if gallons is not None and gallons > 0 and total_cost is not None:
            return total_cost / gallons
        if price_per_gallon is not None and price_per_gallon > 0:
            return price_per_gallon
        return None

    @staticmethod
    async def get_gas_statistics(
        imei: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> dict[str, Any]:
        """
        Get gas consumption statistics.

        Args:
            imei: Optional IMEI filter
            start_date: Optional start date ISO string
            end_date: Optional end date ISO string

        Returns:
            Statistics dict with totals and averages
        """
        conditions: list[Any] = []

        if imei:
            conditions.append(GasFillup.imei == imei)

        if start_date:
            start_dt = parse_timestamp(start_date)
            if start_dt:
                conditions.append(GasFillup.fillup_time >= start_dt)
        if end_date:
            end_dt = parse_timestamp(end_date)
            if end_dt:
                conditions.append(GasFillup.fillup_time <= end_dt)

        query = GasFillup.find(*conditions) if conditions else GasFillup.find_all()
        fillups = await query.sort(GasFillup.fillup_time).to_list()

        if not fillups:
            return {
                "imei": imei,
                "total_fillups": 0,
                "total_gallons": 0,
                "total_cost": 0,
                "average_mpg": None,
                "average_price_per_gallon": None,
                "cost_per_mile": None,
                "period_start": start_date,
                "period_end": end_date,
                "records": {},
            }

        total_gallons = 0.0
        total_cost = 0.0
        price_cost = 0.0
        price_gallons = 0.0
        mpg_miles = 0.0
        mpg_gallons = 0.0
        best_mpg: GasFillup | None = None
        cheapest_price: tuple[GasFillup, float] | None = None

        for fillup in fillups:
            gallons = StatisticsService._safe_float(fillup.gallons)
            cost = StatisticsService._safe_float(fillup.total_cost)
            if gallons is not None and gallons > 0:
                total_gallons += gallons
            if cost is not None and cost > 0:
                total_cost += cost

            effective_price = StatisticsService._effective_price_per_gallon(fillup)
            if gallons is not None and gallons > 0 and effective_price is not None:
                price_cost += effective_price * gallons
                price_gallons += gallons
                if (
                    cheapest_price is None
                    or effective_price < cheapest_price[1]
                    or (
                        effective_price == cheapest_price[1]
                        and (fillup.fillup_time or datetime.min.replace(tzinfo=UTC))
                        > (
                            cheapest_price[0].fillup_time
                            or datetime.min.replace(tzinfo=UTC)
                        )
                    )
                ):
                    cheapest_price = (fillup, effective_price)

            mpg = StatisticsService._safe_float(fillup.calculated_mpg)
            miles = StatisticsService._safe_float(fillup.miles_since_last_fillup)
            if mpg is not None and mpg > 0 and miles is not None and miles > 0:
                mpg_miles += miles
                mpg_gallons += miles / mpg
                if (
                    best_mpg is None
                    or mpg > (best_mpg.calculated_mpg or 0)
                    or (
                        mpg == (best_mpg.calculated_mpg or 0)
                        and (fillup.fillup_time or datetime.min.replace(tzinfo=UTC))
                        > (best_mpg.fillup_time or datetime.min.replace(tzinfo=UTC))
                    )
                ):
                    best_mpg = fillup

        average_mpg = round(mpg_miles / mpg_gallons, 2) if mpg_gallons > 0 else None
        average_price = (
            round(price_cost / price_gallons, 2) if price_gallons > 0 else None
        )

        stats: dict[str, Any] = {
            "imei": imei,
            "total_fillups": len(fillups),
            "total_gallons": round(total_gallons, 2),
            "total_cost": round(total_cost, 2),
            "average_mpg": average_mpg,
            "average_price_per_gallon": average_price,
            "period_start": fillups[0].fillup_time,
            "period_end": fillups[-1].fillup_time,
            "cost_per_mile": (
                round(average_price / average_mpg, 3)
                if average_price is not None and average_mpg is not None and average_mpg > 0
                else None
            ),
        }

        records: dict[str, Any] = {}
        if best_mpg is not None:
            records["best_mpg"] = {
                "mpg": best_mpg.calculated_mpg,
                "fillup_time": best_mpg.fillup_time,
                "price_per_gallon": StatisticsService._effective_price_per_gallon(
                    best_mpg,
                ),
            }
        if cheapest_price is not None:
            fillup, price = cheapest_price
            records["cheapest_price"] = {
                "price_per_gallon": price,
                "fillup_time": fillup.fillup_time,
            }

        stats["records"] = records

        return stats

    @staticmethod
    async def sync_vehicles_from_trips() -> dict[str, Any]:
        """
        Sync vehicles from trip data.

        Creates vehicle records with VIN info from trips for any vehicles
        that don't already exist.

        Returns:
            Dict with sync stats (synced count, updated count, total)
        """
        # Get unique vehicles from trips
        pipeline = [
            {"$match": enforce_bouncie_source({})},
            {
                "$group": {
                    "_id": "$imei",
                    "vin": {"$first": "$vin"},
                    "latest_trip": {"$max": "$endTime"},
                },
            },
            {"$match": {"_id": {"$ne": None}}},
        ]

        trip_vehicles = await aggregate_to_list(Trip, pipeline)

        synced_count = 0
        updated_count = 0

        # Get all existing vehicles to memory to avoid N+1 queries
        existing_vehicles = await Vehicle.find_all().to_list()
        existing_map = {v.imei: v for v in existing_vehicles}

        for tv in trip_vehicles:
            imei = tv["_id"]
            vin = tv.get("vin")

            if not imei:
                continue

            existing = existing_map.get(imei)

            if existing:
                # Update VIN if we have it and it's not set
                if vin and not existing.vin:
                    existing.vin = vin
                    existing.updated_at = datetime.now(UTC)
                    await existing.save()
                    updated_count += 1
            else:
                # Create new vehicle
                vehicle = Vehicle(
                    imei=imei,
                    vin=vin,
                    custom_name=None,
                    is_active=True,
                    created_at=datetime.now(UTC),
                    updated_at=datetime.now(UTC),
                )
                await vehicle.insert()
                synced_count += 1

        logger.info(
            "Vehicle sync complete: %d new, %d updated",
            synced_count,
            updated_count,
        )

        return {
            "status": "success",
            "synced": synced_count,
            "updated": updated_count,
            "total_vehicles": len(trip_vehicles),
        }
