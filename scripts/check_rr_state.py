"""Quick check of recurring route assignment state."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from motor.motor_asyncio import AsyncIOMotorClient


async def check():
    uri = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
    client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000)
    db = client["every_street"]

    assigned = await db.trips.count_documents(
        {"recurringRouteId": {"$exists": True}}
    )
    total = await db.trips.count_documents({})
    routes = await db.recurring_routes.count_documents({})

    print(f"assigned={assigned} total_trips={total} routes={routes}")

    sample = await db.recurring_routes.find_one({"trip_count": {"$gte": 3}})
    if sample:
        rid = sample["_id"]
        linked = await db.trips.count_documents({"recurringRouteId": rid})
        print(
            f"sample route: {sample.get('auto_name', '?')} "
            f"trip_count={sample.get('trip_count')} linked={linked}"
        )

    job = await db.jobs.find_one(
        {"task_type": "recurring_routes_build"}, sort=[("started_at", -1)]
    )
    if job:
        print(
            f"last build: stage={job.get('stage')} status={job.get('status')} "
            f"started={job.get('started_at')}"
        )
        meta = job.get("metadata") or {}
        print(f"  trips_assigned={meta.get('trips_assigned')}")
    else:
        print("no build jobs found")

    client.close()


asyncio.run(check())
