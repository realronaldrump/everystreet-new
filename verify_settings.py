import asyncio
import os
import sys

# Add project root to path
sys.path.append(os.getcwd())

from app_settings import get_app_settings, update_app_settings
from db.manager import DatabaseManager
from db.models import AppSettings


async def verify_app_settings():
    print("Initializing DB...")
    await DatabaseManager.connect()

    print("Fetching settings...")
    try:
        settings = await get_app_settings()
        print(f"Successfully fetched settings: {settings}")
    except Exception as e:
        print(f"FAILED to fetch settings: {e}")
        return

    print("Updating settings...")
    try:
        success = await update_app_settings({"mapbox_access_token": "pk.test_token"})
        if success:
            print("Successfully updated settings")
        else:
            print("Failed to update settings (returned False)")
    except Exception as e:
        print(f"FAILED to update settings: {e}")
        return

    print("Fetching updated settings...")
    try:
        settings = await get_app_settings()
        print(f"Successfully fetched updated settings: {settings}")
        assert settings["mapbox_access_token"] == "pk.test_token"
    except Exception as e:
        print(f"FAILED to fetch updated settings: {e}")
        return

    print("VERIFICATION SUCCESSFUL")


if __name__ == "__main__":
    asyncio.run(verify_app_settings())
