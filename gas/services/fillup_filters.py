from typing import Any

from core.date_utils import parse_timestamp
from db.models import GasFillup


def build_fillup_date_conditions(
    start_date: str | None,
    end_date: str | None,
) -> list[Any]:
    conditions: list[Any] = []
    if start_date:
        start_dt = parse_timestamp(start_date)
        if start_dt:
            conditions.append(GasFillup.fillup_time >= start_dt)
    if end_date:
        end_dt = parse_timestamp(end_date)
        if end_dt:
            conditions.append(GasFillup.fillup_time <= end_dt)
    return conditions
