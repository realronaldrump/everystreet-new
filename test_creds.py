import asyncio
from setup.services.bouncie_credentials import get_bouncie_credentials
from db.models import AppSettings

async def main():
    try:
        from core.startup import initialize_shared_runtime
        handler = await initialize_shared_runtime()
        creds = await get_bouncie_credentials()
        print(f"Bouncie credentials loaded. Webhook key: '{creds.get('webhook_key')}'")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
