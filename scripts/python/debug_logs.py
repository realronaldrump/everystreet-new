import asyncio
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load env vars first
load_dotenv()

# Ensure repo root is on path for local imports.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


async def main() -> None:
    # Local imports after sys.path adjustment.
    from beanie.operators import In

    from db.manager import db_manager
    from db.models import ServerLog

    try:
        await db_manager.init_beanie()
        print("Connected to MongoDB.")

        # Fetch last 20 error/warning logs
        logs = (
            await ServerLog.find(In(ServerLog.level, ["ERROR", "CRITICAL", "WARNING"]))
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
