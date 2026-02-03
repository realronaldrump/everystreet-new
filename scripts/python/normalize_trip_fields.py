"""Normalize legacy trip fields to canonical schema."""

from __future__ import annotations

import logging
import os
from typing import Any

from pymongo import MongoClient

from core.date_utils import parse_timestamp

logger = logging.getLogger(__name__)

DEFAULT_MONGO_URI = "mongodb://mongo:27017"
DEFAULT_DB_NAME = "every_street"


def _get_mongo_client() -> MongoClient:
    mongo_uri = os.getenv("MONGODB_URI", DEFAULT_MONGO_URI)
    return MongoClient(mongo_uri)


def normalize_legacy_fields(db) -> int:
    trips = db["trips"]
    legacy_filter = {
        "$or": [
            {"averageSpeed": {"$exists": True}},
            {"hardBrakingCount": {"$exists": True}},
            {"hardAccelerationCount": {"$exists": True}},
            {"totalIdlingTime": {"$exists": True}},
        ],
    }

    pipeline = [
        {
            "$set": {
                "avgSpeed": {"$ifNull": ["$avgSpeed", "$averageSpeed"]},
                "hardBrakingCounts": {
                    "$ifNull": ["$hardBrakingCounts", "$hardBrakingCount"],
                },
                "hardAccelerationCounts": {
                    "$ifNull": [
                        "$hardAccelerationCounts",
                        "$hardAccelerationCount",
                    ],
                },
                "totalIdleDuration": {
                    "$ifNull": ["$totalIdleDuration", "$totalIdlingTime"],
                },
            },
        },
        {
            "$unset": [
                "averageSpeed",
                "hardBrakingCount",
                "hardAccelerationCount",
                "totalIdlingTime",
            ],
        },
    ]

    result = trips.update_many(legacy_filter, pipeline)
    return int(result.modified_count or 0)


def normalize_coordinate_timestamps(db) -> int:
    trips = db["trips"]
    cursor = trips.find({"coordinates.timestamp": {"$type": "string"}})
    updated = 0

    for doc in cursor:
        coords = doc.get("coordinates") or []
        if not isinstance(coords, list):
            continue
        changed = False
        normalized: list[dict[str, Any]] = []
        for entry in coords:
            if not isinstance(entry, dict):
                continue
            ts = entry.get("timestamp")
            if isinstance(ts, str):
                parsed = parse_timestamp(ts)
                if parsed is not None:
                    entry = dict(entry)
                    entry["timestamp"] = parsed
                    changed = True
            normalized.append(entry)

        if changed:
            trips.update_one({"_id": doc["_id"]}, {"$set": {"coordinates": normalized}})
            updated += 1

    return updated


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    db_name = os.getenv("MONGODB_DATABASE", DEFAULT_DB_NAME)
    client = _get_mongo_client()
    db = client[db_name]

    logger.info("Normalizing legacy trip fields in %s...", db_name)
    modified = normalize_legacy_fields(db)
    logger.info("Updated %d trip documents with canonical fields.", modified)

    logger.info("Normalizing coordinate timestamps (string -> datetime)...")
    updated_coords = normalize_coordinate_timestamps(db)
    logger.info(
        "Updated %d trip documents with normalized coordinates.",
        updated_coords,
    )


if __name__ == "__main__":
    main()
