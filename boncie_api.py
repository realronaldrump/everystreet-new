import aiohttp
import asyncio
from datetime import datetime, timezone, timedelta
import os
from dotenv import load_dotenv
import json

load_dotenv()

CLIENT_ID = os.getenv('CLIENT_ID')
CLIENT_SECRET = os.getenv('CLIENT_SECRET')
AUTH_CODE = os.getenv('AUTHORIZATION_CODE')
REDIRECT_URI = os.getenv('REDIRECT_URI')
AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
AUTHORIZED_DEVICES = os.getenv('AUTHORIZED_DEVICES', '').split(',')


async def get_raw_trip_data():
    try:
        async with aiohttp.ClientSession() as session:
            # Get access token
            payload = {
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "grant_type": "authorization_code",
                "code": AUTH_CODE,
                "redirect_uri": REDIRECT_URI
            }

            print("Getting access token...")
            async with session.post(AUTH_URL, data=payload) as auth_response:
                if auth_response.status != 200:
                    error_text = await auth_response.text()
                    print(f"Auth Error ({auth_response.status}): {error_text}")
                    return
                auth_data = await auth_response.json()
                access_token = auth_data.get('access_token')
                if not access_token:
                    print("No access token received")
                    return

            # Get trips for each device
            headers = {
                "Authorization": access_token,
                "Content-Type": "application/json"
            }

            # Get last 24 hours of trips
            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=1)

            for imei in AUTHORIZED_DEVICES:
                print(f"\nFetching trips for device {imei}")
                params = {
                    "imei": imei,
                    "starts-after": start_date.isoformat(),
                    "ends-before": end_date.isoformat(),
                    "gps-format": "geojson"
                }

                async with session.get(f"{API_BASE_URL}/trips", headers=headers, params=params) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        print(f"API Error ({response.status}): {error_text}")
                        continue

                    trips = await response.json()
                    print(f"Found {len(trips)} trips")

                    for trip in trips:
                        print("\nRaw Trip Data:")
                        print(json.dumps({
                            "transactionId": trip.get('transactionId'),
                            "startTime": trip.get('startTime'),
                            "endTime": trip.get('endTime')
                        }, indent=2))

    except Exception as e:
        print(f"Error: {str(e)}")

if __name__ == "__main__":
    asyncio.run(get_raw_trip_data())
