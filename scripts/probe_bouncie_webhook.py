import asyncio

from tracking.api.webhooks import bouncie_live_webhook


async def main():
    class DummyRequest:
        def __init__(self, headers):
            self.headers = headers

        async def body(self):
            return (
                b'{"eventType":"tripStart","imei":"353816090000794",'
                b'"vin":"1FTFW1E88MFA00001","transactionId":"probe-trip",'
                b'"start":{"timestamp":"2026-02-21T12:00:00Z",'
                b'"timeZone":"UTC","odometer":1}}'
            )

    req = DummyRequest(
        {
            "authorization": "EyTqtvkRy6eb7XeaOsRYkAeWnEPkzNQ1",
            "content-type": "application/json",
        },
    )

    # Call the endpoint directly to probe credential/auth behavior.
    from db.manager import init_db

    await init_db()

    await bouncie_live_webhook(req)


if __name__ == "__main__":
    asyncio.run(main())
