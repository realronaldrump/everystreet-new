import asyncio

from dotenv import load_dotenv

# Load env vars first
load_dotenv()

from db.manager import db_manager
from db.models import ServerLog


async def main() -> None:
    try:
        await db_manager.init_beanie()
        print("Connected to MongoDB.")

        # Fetch last 20 error/warning logs
        logs = (
            await ServerLog.find(ServerLog.level.in_(["ERROR", "CRITICAL", "WARNING"]))
            .sort("-timestamp")
            .limit(20)
            .to_list()
        )

        print(f"Found {len(logs)} logs.")
        for log in logs:
            print(f"[{log.timestamp}] {log.level}: {log.message}")
            if log.exc_info:
                print(f"Exception: {log.exc_info[:500]}...")  # Truncate for readability
            print("-" * 40)

    except Exception as e:
        print(f"Failed to fetch logs: {e}")


if __name__ == "__main__":
    asyncio.run(main())
