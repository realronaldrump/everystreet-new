# test_live_tracking_advanced.py
import requests
import time
from datetime import datetime
import json
import random
import argparse

BASE_URL = "http://localhost:8080"
WEBHOOK_URL = f"{BASE_URL}/webhook/bouncie"


def generate_route(start_lat, start_lon, num_points=10, variance=0.0003):
    """Generate a realistic-looking route"""
    route = []
    current_lat = start_lat
    current_lon = start_lon

    for _ in range(num_points):
        current_lat += random.uniform(-variance, variance)
        current_lon += random.uniform(-variance, variance)
        route.append({"lat": current_lat, "lon": current_lon})

    return route


def simulate_trip(duration=30, update_interval=2):
    """
    Simulate a trip with given duration and update interval
    duration: total trip duration in seconds
    update_interval: seconds between updates
    """
    # Generate unique transaction ID
    transaction_id = f"TEST-{int(time.time())}"

    # Starting point (Waco, TX area - adjust as needed)
    start_lat = 31.5472
    start_lon = -97.1161

    # Generate route
    num_points = duration // update_interval
    route = generate_route(start_lat, start_lon, num_points)

    # Start trip
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

    print(f"Starting trip {transaction_id}")
    requests.post(WEBHOOK_URL, json=start_event)

    # Send updates
    points_sent = 0
    start_time = time.time()

    while points_sent < len(route):
        current_time = time.time()
        elapsed = current_time - start_time

        if elapsed >= duration:
            break

        data_event = {
            "eventType": "tripData",
            "transactionId": transaction_id,
            "imei": "TEST-DEVICE",
            "vin": "TEST-VIN",
            "data": [{
                "timestamp": datetime.utcnow().isoformat(),
                "gps": {
                    "lat": route[points_sent]["lat"],
                    "lon": route[points_sent]["lon"],
                    "heading": random.randint(0, 359)
                },
                "speed": random.randint(20, 35)
            }]
        }

        print(f"Sending update {points_sent + 1}/{len(route)}")
        requests.post(WEBHOOK_URL, json=data_event)
        points_sent += 1
        time.sleep(update_interval)

    # End trip
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

    print("Ending trip")
    requests.post(WEBHOOK_URL, json=end_event)
    return transaction_id


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Simulate a vehicle trip')
    parser.add_argument('--duration', type=int, default=30,
                        help='Trip duration in seconds (default: 30)')
    parser.add_argument('--interval', type=int, default=2,
                        help='Update interval in seconds (default: 2)')

    args = parser.parse_args()

    print(f"Simulating {args.duration}s trip with {args.interval}s updates...")
    trip_id = simulate_trip(args.duration, args.interval)
    print(f"Trip {trip_id} simulation complete!")
