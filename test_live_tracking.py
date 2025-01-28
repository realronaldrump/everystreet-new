# test_live_tracking.py
import requests
import time
from datetime import datetime
import json

BASE_URL = "http://localhost:8080"  # Adjust if different
WEBHOOK_URL = f"{BASE_URL}/webhook/bouncie"


def simulate_trip():
    # Sample coordinates for a short trip (adjust these to your local area)
    coordinates = [
        {"lat": 31.5472, "lon": -97.1161},  # Starting point
        {"lat": 31.5475, "lon": -97.1163},
        {"lat": 31.5478, "lon": -97.1165},
        {"lat": 31.5481, "lon": -97.1167},
        {"lat": 31.5484, "lon": -97.1169},  # Ending point
    ]

    # Generate unique transaction ID
    transaction_id = f"TEST-{int(time.time())}"

    # Simulate trip start
    start_event = {
        "eventType": "tripStart",
        "transactionId": transaction_id,
        "imei": "TEST-DEVICE",
        "vin": "TEST-VIN",
        "start": {
            "timestamp": datetime.utcnow().isoformat(),
            "timeZone": "America/Chicago",
            "odometer": 1000
        }
    }

    print("Sending trip start event...")
    response = requests.post(WEBHOOK_URL, json=start_event)
    print(f"Start response: {response.status_code}")
    time.sleep(1)  # Wait a second

    # Simulate trip data updates
    for i in range(0, len(coordinates), 2):
        current_coords = coordinates[i:i+2]
        data_event = {
            "eventType": "tripData",
            "transactionId": transaction_id,
            "imei": "TEST-DEVICE",
            "vin": "TEST-VIN",
            "data": []
        }

        for coord in current_coords:
            data_event["data"].append({
                "timestamp": datetime.utcnow().isoformat(),
                "gps": {
                    "lat": coord["lat"],
                    "lon": coord["lon"],
                    "heading": 0
                },
                "speed": 25
            })

        print(f"Sending trip data update {i//2 + 1}...")
        response = requests.post(WEBHOOK_URL, json=data_event)
        print(f"Data response: {response.status_code}")
        time.sleep(2)  # Wait between updates

    # Simulate trip end
    end_event = {
        "eventType": "tripEnd",
        "transactionId": transaction_id,
        "imei": "TEST-DEVICE",
        "vin": "TEST-VIN",
        "end": {
            "timestamp": datetime.utcnow().isoformat(),
            "timeZone": "America/Chicago",
            "odometer": 1005,
            "fuelConsumed": 0.2
        }
    }

    print("Sending trip end event...")
    response = requests.post(WEBHOOK_URL, json=end_event)
    print(f"End response: {response.status_code}")


if __name__ == "__main__":
    print("Starting trip simulation...")
    simulate_trip()
    print("Trip simulation complete!")
