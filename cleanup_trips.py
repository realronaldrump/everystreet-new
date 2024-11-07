import asyncio
from app import cleanup_invalid_trips, logger

async def main():
    logger.info("Starting cleanup process...")
    await cleanup_invalid_trips()
    logger.info("Cleanup process completed")

if __name__ == "__main__":
    asyncio.run(main())
