import asyncio
import os
import sys

# Add project root to path
sys.path.append(os.getcwd())

from db.database import init_db
from db.models import AppSettings


async def check_settings():
    await init_db()
    settings = await AppSettings.find_one()
    if settings:
        print(f"Setup Completed: {settings.setup_completed}")
        print(f"Setup Completed At: {settings.setup_completed_at}")
    else:
        print("No AppSettings found.")


if __name__ == "__main__":
    asyncio.run(check_settings())
