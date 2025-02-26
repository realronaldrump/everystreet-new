from datetime import datetime, timedelta, timezone
import json
import asyncio
import logging
from fastapi import WebSocket, HTTPException
from starlette.websockets import WebSocketDisconnect
from dateutil import parser as dateutil_parser

from db import live_trips_collection, trips_collection
from utils import parse_gps, serialize_datetime
from app import manager

# Set up logger
logger = logging.getLogger(__name__)


async def websocket_live_trip(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial heartbeat on connect
        await websocket.send_text(
            json.dumps(
                {
                    "type": "heartbeat",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )
        )

        # Send initial active trip data if available
        active_trip = await get_active_trip_data()
        if active_trip:
            await websocket.send_text(
                json.dumps({"type": "trip_update", "data": active_trip})
            )
        else:
            # Send empty trip data structure when no active trip exists
            empty_trip = {
                "trip_id": "",
                "start_time": None,
                "end_time": None,
                "coordinates": [],
                "is_active": False,
            }
            await websocket.send_text(
                json.dumps({"type": "trip_update", "data": empty_trip})
            )

        # Setup a heartbeat task to run every 20 seconds
        last_heartbeat_time = datetime.now(timezone.utc)
        heartbeat_interval = 20  # seconds

        # Keep connection alive and handle messages
        while True:
            try:
                # Check if we need to send a heartbeat
                now = datetime.now(timezone.utc)
                time_since_heartbeat = (now - last_heartbeat_time).total_seconds()

                if time_since_heartbeat >= heartbeat_interval:
                    # Send a heartbeat to keep connection alive
                    await websocket.send_text(
                        json.dumps({"type": "heartbeat", "timestamp": now.isoformat()})
                    )
                    last_heartbeat_time = now

                # Wait for message with timeout (this will also keep the connection alive)
                try:
                    # Use a small timeout so we can still send regular heartbeats
                    data = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)

                    # Process client message if received
                    try:
                        message = json.loads(data)
                    except json.JSONDecodeError:
                        # If not valid JSON, just treat as heartbeat request
                        message = {"type": "heartbeat_request"}

                    if (
                        message.get("type") == "request_active_trip"
                        or message.get("type") == "heartbeat_request"
                    ):
                        # Fetch active trip data and send it back
                        active_trip = await get_active_trip_data()
                        if active_trip:
                            await websocket.send_text(
                                json.dumps({"type": "trip_update", "data": active_trip})
                            )
                        else:
                            # Send empty trip data structure when no active trip exists
                            empty_trip = {
                                "trip_id": "",
                                "start_time": None,
                                "end_time": None,
                                "coordinates": [],
                                "is_active": False,
                            }
                            await websocket.send_text(
                                json.dumps({"type": "trip_update", "data": empty_trip})
                            )
                except asyncio.TimeoutError:
                    # This is normal - just continue and check heartbeat timing
                    continue

            except WebSocketDisconnect:
                logger.info("WebSocket client disconnected normally")
                manager.disconnect(websocket)
                break
            except Exception as e:
                logger.exception("Error processing WebSocket message")
                try:
                    await websocket.send_text(
                        json.dumps({"type": "error", "message": str(e)})
                    )
                except Exception:
                    break

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected during setup")
        manager.disconnect(websocket)
    except Exception as e:
        logger.exception(f"WebSocket error: {e}")
        try:
            await websocket.close(code=1011)  # Internal server error
        except Exception:
            pass
        manager.disconnect(websocket)


async def get_active_trip_data():
    """Fetch active trip data from the database"""
    try:
        # Query for active trips - get only very recent trips (last 15 minutes)
        now = datetime.now(timezone.utc)
        fifteen_minutes_ago = now - timedelta(
            minutes=15
        )  # Much shorter window for "active" trips

        # First check for currently active trips in live_trips_collection
        live_trip = await live_trips_collection.find_one({})
        if live_trip and live_trip.get("gps"):
            # Process live trip - this is a truly active trip
            gps_data = parse_gps(live_trip.get("gps", "{}"))

            # Extract coordinates
            coordinates = []
            if gps_data.get("type") == "LineString" and gps_data.get("coordinates"):
                for point in gps_data.get("coordinates", []):
                    if isinstance(point, list) and len(point) >= 2:
                        coordinates.append(
                            {
                                "lon": point[0],
                                "lat": point[1],
                                "timestamp": now.isoformat(),  # Use current time for live trips
                            }
                        )

            return {
                "trip_id": str(live_trip.get("transactionId", "live-trip")),
                "start_time": serialize_datetime(live_trip.get("startTime", now)),
                "end_time": None,  # No end time for active trips
                "coordinates": coordinates,
                "is_active": True,
            }

        # If no live trip, check for very recent trips (ended in last 15 minutes)
        query = {"endTime": {"$gte": fifteen_minutes_ago}, "startTime": {"$lte": now}}
        trips = (
            await trips_collection.find(query)
            .sort("endTime", -1)
            .limit(1)
            .to_list(length=1)
        )

        if not trips:
            return None  # No active or recent trips

        trip = trips[0]
        gps_data = parse_gps(trip.get("gps", "{}"))

        # Extract coordinates
        coordinates = []
        if gps_data.get("type") == "LineString" and gps_data.get("coordinates"):
            for i, point in enumerate(gps_data.get("coordinates", [])):
                if not isinstance(point, list) or len(point) < 2:
                    continue

                # Create timestamps assuming even distribution between start and end
                start_time = trip.get("startTime")
                end_time = trip.get("endTime")

                if isinstance(start_time, str):
                    try:
                        start_time = dateutil_parser.isoparse(start_time)
                    except (ValueError, TypeError):
                        start_time = now - timedelta(minutes=15)  # Fallback

                if isinstance(end_time, str):
                    try:
                        end_time = dateutil_parser.isoparse(end_time)
                    except (ValueError, TypeError):
                        end_time = now  # Fallback

                if start_time and end_time and start_time < end_time:
                    total_seconds = (end_time - start_time).total_seconds()
                    num_points = max(1, len(gps_data.get("coordinates", [])) - 1)
                    fraction = i / num_points if num_points > 0 else 0
                    point_time = start_time + timedelta(
                        seconds=total_seconds * fraction
                    )

                    coordinates.append(
                        {
                            "lon": point[0],
                            "lat": point[1],
                            "timestamp": point_time.isoformat(),
                        }
                    )

        return {
            "trip_id": str(trip.get("transactionId", "")),
            "start_time": serialize_datetime(trip.get("startTime")),
            "end_time": serialize_datetime(trip.get("endTime")),
            "coordinates": coordinates,
            "is_active": False,  # This is a recent trip, not an active one
        }
    except Exception as e:
        logger.exception("Error fetching active trip data")
        return None


async def get_active_trip():
    try:
        trip_data = await get_active_trip_data()
        if not trip_data:
            # Return empty data structure instead of 404 error
            return {
                "trip_id": "",
                "start_time": None,
                "end_time": None,
                "coordinates": [],
                "is_active": False,
            }
        return trip_data
    except Exception as e:
        logger.exception("Error in get_active_trip endpoint")
        raise HTTPException(status_code=500, detail=str(e))
