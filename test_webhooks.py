import asyncio
from tracking.api.webhooks import bouncie_webhook
from fastapi import Request

async def main():
    class DummyRequest:
        def __init__(self, headers):
            self.headers = headers
        async def body(self):
            return b'{"eventType": "test"}'
            
    req = DummyRequest({
        "authorization": "EyTqtvkRy6eb7XeaOsRYkAeWnEPkzNQ1",
        "content-type": "application/json"
    })
    
    # Try calling the endpoint directly to see if get_bouncie_credentials or _extract_auth_token fails inside the async flow
    from db.manager import init_db
    await init_db()
    
    await bouncie_webhook(req)
    await asyncio.sleep(2)  # Wait for background task

asyncio.run(main())
