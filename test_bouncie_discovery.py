import asyncio
import logging
import os
import sys

# Add parent directory to path to import modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import aiohttp

from bouncie_credentials import get_bouncie_credentials
from bouncie_trip_fetcher import get_access_token

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

API_BASE_URL = "https://api.bouncie.dev/v1"


async def test_discovery():
    try:
        credentials = await get_bouncie_credentials()
        if not credentials.get("client_id"):
            logger.error("No credentials found.")
            return

        async with aiohttp.ClientSession() as session:
            token = await get_access_token(session, credentials)
            if not token:
                logger.error("Could not get access token.")
                return

            logger.info("Got access token. Testing device discovery...")

            headers = {"Authorization": token}

            # Try /devices endpoint
            logger.info("Testing GET /devices ...")
            async with session.get(f"{API_BASE_URL}/devices", headers=headers) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    logger.info("Successfully fetched devices: %s", data)
                    return
                else:
                    logger.warning(
                        "Failed to fetch /devices: %s %s",
                        resp.status,
                        await resp.text(),
                    )

            # Try /vehicles endpoint
            logger.info("Testing GET /vehicles ...")
            async with session.get(f"{API_BASE_URL}/vehicles", headers=headers) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    logger.info("Successfully fetched vehicles: %s", data)
                    return
                else:
                    logger.warning(
                        "Failed to fetch /vehicles: %s %s",
                        resp.status,
                        await resp.text(),
                    )

    except Exception as e:
        logger.exception("Error testing discovery: %s", e)


if __name__ == "__main__":
    asyncio.run(test_discovery())
