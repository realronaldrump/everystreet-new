import asyncio
import os
import sys

# Ensure current directory is in python path
sys.path.insert(0, os.getcwd())

from db import db_manager
from db.models import Street


async def verify_projection():
    print("Initializing Beanie...")
    await db_manager.init_beanie()

    print("Testing Street query with Motor...")
    try:
        # Mimic the query from routes/service.py but using Motor directly
        # Filter is: {"properties.location": ..., "properties.driven": False, ...}
        # We'll just query ANY street to test the mechanism

        collection = Street.get_pymongo_collection()
        projection = {
            "geometry": 1,
            "properties.segment_id": 1,
            "properties.segment_length": 1,
            "properties.street_name": 1,
        }

        # Just find one to verify structure
        doc = await collection.find_one({}, projection=projection)

        if doc:
            print("Successfully fetched document with projection:")
            print(f"Keys: {list(doc.keys())}")
            if "properties" in doc:
                print(f"Properties keys: {list(doc['properties'].keys())}")
        else:
            print(
                "No street documents found (DB might be empty or filter mismatch, but query ran)."
            )

        print("\n>>> SUCCESS: Motor projection query works.")

    except Exception as e:
        print(f"\n>>> FAILURE: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(verify_projection())
    finally:
        loop.close()
