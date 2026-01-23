from fastapi.testclient import TestClient
from main import app
import sys


def test_api():
    client = TestClient(app)
    try:
        response = client.get("/api/trips?start_date=2020-01-01&end_date=2030-01-01")
        print(f"Status: {response.status_code}")
        if response.status_code != 200:
            print(f"Error: {response.text}")
        else:
            # We can't easily stream with TestClient in the same way, but it reads the response
            print("Response successfully read.")
            print("First 100 chars:", response.text[:100])
    except Exception as e:
        print(f"Exception triggering request: {e}")


if __name__ == "__main__":
    test_api()
