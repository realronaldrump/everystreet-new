"""API endpoints for Student Worker hours and payroll analytics."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from dateutil import parser as dateutil_parser
from fastapi import APIRouter, HTTPException, Query, status

from db import db_manager

logger = logging.getLogger(__name__)
router = APIRouter()

STUDENT_WORKERS_COLLECTION_NAME = "student_workers"


def _get_collection():
    """Return the Mongo collection for student workers."""
    return db_manager.db[STUDENT_WORKERS_COLLECTION_NAME]


def _parse_date(value: str | None, parameter: str) -> datetime | None:
    """Parse date strings into timezone-aware UTC datetimes."""
    if not value:
        return None
    try:
        parsed = dateutil_parser.parse(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError) as exc:  # pragma: no cover - defensive
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {parameter} supplied",
        ) from exc


def _coerce_number(raw: Any) -> float:
    """Attempt to coerce values to float for reporting metrics."""
    if raw is None:
        return 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def _serialize_student(doc: dict[str, Any]) -> dict[str, Any]:
    """Convert MongoDB document into API-friendly payload."""
    result: dict[str, Any] = {
        "id": str(doc.get("_id", "")),
        "studentId": doc.get("studentId"),
        "firstName": doc.get("firstName"),
        "lastName": doc.get("lastName"),
        "name": doc.get("name"),
        "email": doc.get("email"),
        "department": doc.get("department"),
        "role": doc.get("role"),
        "status": doc.get("status"),
        "hourlyRate": doc.get("hourlyRate"),
        "hoursWorked": doc.get("hoursWorked"),
        "payrollAmount": doc.get("payrollAmount"),
        "currency": doc.get("currency")
        or doc.get("payrollCurrency")
        or doc.get("currencyCode"),
        "payPeriodStart": doc.get("payPeriodStart"),
        "payPeriodEnd": doc.get("payPeriodEnd"),
        "lastUpdated": doc.get("lastUpdated"),
    }

    # Derive name if missing
    if not result.get("name"):
        first = result.get("firstName") or ""
        last = result.get("lastName") or ""
        full_name = " ".join(filter(None, [first.strip(), last.strip()])).strip()
        if full_name:
            result["name"] = full_name

    # ISO format datetime fields
    for key in ("payPeriodStart", "payPeriodEnd", "lastUpdated"):
        value = result.get(key)
        if isinstance(value, datetime):
            result[key] = value.astimezone(timezone.utc).isoformat()

    # Normalised numeric helpers
    hours = _coerce_number(result.get("hoursWorked"))
    rate = _coerce_number(result.get("hourlyRate"))
    payroll = result.get("payrollAmount")
    payroll_value = _coerce_number(payroll)
    if payroll_value == 0 and payroll not in (0, "0", 0.0):
        # if payroll could not be parsed, fall back to hours * rate
        payroll_value = hours * rate
    result["hoursWorked"] = hours
    result["hourlyRate"] = rate
    result["payrollAmount"] = payroll_value

    return result


@router.get("/api/student-workers")
async def list_student_workers(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    search: str | None = None,
    department: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    start_date: str | None = None,
    end_date: str | None = None,
    sort_by: str | None = Query("payPeriodEnd"),
    sort_order: str | None = Query("desc"),
):
    """Return paginated student worker data with filtering and aggregation."""

    collection = _get_collection()

    query: dict[str, Any] = {}
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"firstName": {"$regex": search, "$options": "i"}},
            {"lastName": {"$regex": search, "$options": "i"}},
            {"studentId": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}},
        ]

    if department:
        query["department"] = department

    if status_filter:
        query["status"] = status_filter

    start_dt = _parse_date(start_date, "start_date")
    end_dt = _parse_date(end_date, "end_date")
    if start_dt and end_dt:
        query["$and"] = query.get("$and", []) + [
            {
                "$or": [
                    {
                        "$and": [
                            {"payPeriodStart": {"$lte": end_dt}},
                            {"payPeriodEnd": {"$gte": start_dt}},
                        ]
                    },
                    {
                        "$and": [
                            {"payPeriodStart": {"$exists": False}},
                            {"payPeriodEnd": {"$gte": start_dt}},
                        ]
                    },
                    {
                        "$and": [
                            {"payPeriodStart": {"$lte": end_dt}},
                            {"payPeriodEnd": {"$exists": False}},
                        ]
                    },
                ]
            }
        ]
    elif start_dt:
        query["$and"] = query.get("$and", []) + [
            {
                "$or": [
                    {"payPeriodStart": {"$gte": start_dt}},
                    {"payPeriodEnd": {"$gte": start_dt}},
                ]
            }
        ]
    elif end_dt:
        query["$and"] = query.get("$and", []) + [
            {
                "$or": [
                    {"payPeriodStart": {"$lte": end_dt}},
                    {"payPeriodEnd": {"$lte": end_dt}},
                ]
            }
        ]

    # Determine sorting
    sort_field_map = {
        "name": "name",
        "department": "department",
        "status": "status",
        "hours": "hoursWorked",
        "hoursWorked": "hoursWorked",
        "pay": "payrollAmount",
        "payroll": "payrollAmount",
        "payrollAmount": "payrollAmount",
        "rate": "hourlyRate",
        "hourlyRate": "hourlyRate",
        "studentId": "studentId",
        "payPeriodStart": "payPeriodStart",
        "payPeriodEnd": "payPeriodEnd",
        "updated": "lastUpdated",
        "lastUpdated": "lastUpdated",
    }

    sort_field = sort_field_map.get(sort_by or "", "payPeriodEnd")
    sort_direction = -1 if (sort_order or "").lower() == "desc" else 1

    skip = (page - 1) * page_size

    async def _count_operation() -> int:
        return await collection.count_documents(query)

    total = await db_manager.execute_with_retry(
        _count_operation,
        operation_name="count student workers",
    )

    async def _find_operation():
        cursor = collection.find(query)
        cursor = cursor.sort([(sort_field, sort_direction), ("_id", 1)])
        cursor = cursor.skip(skip).limit(page_size)
        return await cursor.to_list(length=page_size)

    documents = await db_manager.execute_with_retry(
        _find_operation,
        operation_name="list student workers",
    )

    items = [_serialize_student(doc) for doc in documents]
    currency = next(
        (item.get("currency") for item in items if item.get("currency")), None
    )

    async def _aggregate_operation():
        pipeline = [
            {"$match": query},
            {
                "$project": {
                    "department": 1,
                    "status": 1,
                    "hours": {
                        "$convert": {
                            "input": "$hoursWorked",
                            "to": "double",
                            "onError": 0,
                            "onNull": 0,
                        }
                    },
                    "hourlyRate": {
                        "$convert": {
                            "input": "$hourlyRate",
                            "to": "double",
                            "onError": 0,
                            "onNull": 0,
                        }
                    },
                    "explicitPayroll": {
                        "$convert": {
                            "input": "$payrollAmount",
                            "to": "double",
                            "onError": None,
                            "onNull": None,
                        }
                    },
                }
            },
            {
                "$addFields": {
                    "payroll": {
                        "$cond": [
                            {"$ne": ["$explicitPayroll", None]},
                            "$explicitPayroll",
                            {"$multiply": ["$hours", "$hourlyRate"]},
                        ]
                    }
                }
            },
            {
                "$group": {
                    "_id": None,
                    "totalHours": {"$sum": "$hours"},
                    "totalPayroll": {"$sum": "$payroll"},
                }
            },
        ]
        results = await collection.aggregate(pipeline).to_list(length=1)
        return results[0] if results else {"totalHours": 0, "totalPayroll": 0}

    totals = await db_manager.execute_with_retry(
        _aggregate_operation,
        operation_name="aggregate student worker totals",
    )

    async def _distinct_departments():
        return await collection.distinct("department", query)

    async def _distinct_statuses():
        return await collection.distinct("status", query)

    departments = await db_manager.execute_with_retry(
        _distinct_departments,
        operation_name="distinct student worker departments",
    )
    statuses = await db_manager.execute_with_retry(
        _distinct_statuses,
        operation_name="distinct student worker statuses",
    )

    total_pages = (total + page_size - 1) // page_size if page_size else 1

    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": max(total_pages, 1),
        "totals": {
            "hours": totals.get("totalHours", 0),
            "payroll": totals.get("totalPayroll", 0),
        },
        "filters": {
            "departments": sorted(filter(None, departments)),
            "statuses": sorted(filter(None, statuses)),
        },
        "sort": {
            "field": sort_field,
            "order": "desc" if sort_direction == -1 else "asc",
        },
        "currency": currency or "USD",
    }
