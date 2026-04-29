import asyncio

from tracking.api.webhooks import bouncie_webhook


async def main():
    class DummyRequest:
        def __init__(self, headers):
            self.headers = headers

        async def body(self):
            return b'{"eventType": "test"}'

    req = DummyRequest(
        {
            "authorization": "EyTqtvkRy6eb7XeaOsRYkAeWnEPkzNQ1",
            "content-type": "application/json",
        },
    )

    # Call the endpoint directly to probe credential/auth behavior.
    from db.manager import init_db

    await init_db()

    await bouncie_webhook(req)
    await asyncio.sleep(2)  # Wait for background task


if __name__ == "__main__":
    asyncio.run(main())
