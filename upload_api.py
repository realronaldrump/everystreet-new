import json
import logging
import os
from datetime import datetime, timezone

import gpxpy
from dateutil import parser as dateutil_parser
from fastapi import APIRouter, File, HTTPException, UploadFile, status

from trip_processor import TripProcessor
from trip_service import TripService
from utils import calculate_distance

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

# Initialize TripService
trip_service = TripService(MAPBOX_ACCESS_TOKEN)

# Helper functions moved from app.py


async def process_and_store_trip(trip: dict, source: str = "upload") -> None:
    """Process and store a trip using TripService.

    Args:
        trip: Trip data dictionary
        source: The source of the trip ('upload', 'upload_gpx', 'upload_geojson')

    """
    await trip_service.process_uploaded_trip(trip, source)


async def process_geojson_trip(
    geojson_data: dict,
) -> list[dict] | None:
    """Process GeoJSON trip data into trip dictionaries.

    Args:
        geojson_data: GeoJSON data with trip features

    Returns:
        List of trip dictionaries, or None if processing failed

    """
    try:
        feats = geojson_data.get("features", [])
        trips = []
        for f in feats:
            props = f.get("properties", {})
            geom = f.get("geometry", {})
            stime_str = props.get("start_time")
            etime_str = props.get("end_time")
            tid = props.get(
                "transaction_id",
                f"geojson-{int(datetime.now().timestamp())}",
            )
            stime_parsed = (
                dateutil_parser.isoparse(stime_str)
                if stime_str
                else datetime.now(timezone.utc)
            )
            etime_parsed = (
                dateutil_parser.isoparse(etime_str) if etime_str else stime_parsed
            )
            trip_geo = {
                "type": geom.get("type"),
                "coordinates": geom.get("coordinates"),
            }
            dist_miles = calculate_distance(geom.get("coordinates", []))
            trips.append(
                {
                    "transactionId": tid,
                    "startTime": stime_parsed,
                    "endTime": etime_parsed,
                    "gps": trip_geo,
                    "distance": dist_miles,
                    "imei": "UPLOADED",
                    "source": "upload_geojson",
                },
            )
        return trips
    except Exception:
        logger.exception("Error in process_geojson_trip")
        return None


# API Endpoint


@router.post("/api/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
):
    """Upload GPX or GeoJSON files and process them into the trips
    collection.
    """
    try:
        count = 0
        for file in files:
            filename = file.filename.lower() if file.filename else "unknown_file"
            content_data = await file.read()

            if filename.endswith(".gpx"):
                try:
                    gpx_obj = gpxpy.parse(content_data)
                    for track in gpx_obj.tracks:
                        for seg in track.segments:
                            if not seg.points or len(seg.points) < 2:
                                continue
                            coords = [
                                [
                                    p.longitude,
                                    p.latitude,
                                ]
                                for p in seg.points
                            ]
                            times = [p.time for p in seg.points if p.time]
                            if not times:
                                continue
                            st = min(times)
                            en = max(times)
                            trip_dict = {
                                "transactionId": f"GPX-{st.strftime('%Y%m%d%H%M%S')}-{filename}",
                                "startTime": st,
                                "endTime": en,
                                "gps": {
                                    "type": "LineString",
                                    "coordinates": coords,
                                },
                                "imei": "UPLOADED",
                                "source": "upload_gpx",
                            }

                            # Standardize GPS for GPX upload
                            standardized_gpx_gps = None
                            if coords:
                                # Deduplicate and determine Point/LineString
                                unique_gpx_coords = []
                                if coords:
                                    unique_gpx_coords.append(coords[0])
                                    for i in range(1, len(coords)):
                                        if coords[i] != coords[i - 1]:
                                            unique_gpx_coords.append(coords[i])

                                if len(unique_gpx_coords) == 1:
                                    standardized_gpx_gps = {
                                        "type": "Point",
                                        "coordinates": unique_gpx_coords[0],
                                    }
                                elif len(unique_gpx_coords) >= 2:
                                    standardized_gpx_gps = {
                                        "type": "LineString",
                                        "coordinates": unique_gpx_coords,
                                    }
                                else:  # No valid unique points
                                    logger.warning(
                                        f"GPX segment for {filename} produced no valid unique coordinates."
                                    )

                            if standardized_gpx_gps:
                                trip_dict["gps"] = standardized_gpx_gps
                                # Calculate distance based on the final unique coordinates
                                trip_dict["distance"] = calculate_distance(
                                    standardized_gpx_gps.get("coordinates", [])
                                )

                                await process_and_store_trip(
                                    trip_dict,
                                    source="upload_gpx",
                                )
                                count += 1
                            else:
                                logger.warning(
                                    f"Skipping GPX track/segment in {filename} due to no valid GPS data after standardization."
                                )

                except Exception as gpx_err:
                    logger.error(
                        "Error processing GPX file %s in /api/upload: %s",
                        filename,
                        gpx_err,
                    )
                    continue

            elif filename.endswith(".geojson"):
                try:
                    data_geojson = json.loads(content_data)
                    trips = await process_geojson_trip(data_geojson)
                    if trips:  # trips is a list of trip_dicts from process_geojson_trip
                        processed_one_from_file = False
                        for t in trips:
                            # t['gps'] is already a validated GeoJSON dict or None
                            if t.get("gps") is not None:
                                await process_and_store_trip(
                                    t,
                                    source="upload_geojson",
                                )
                                count += 1
                                processed_one_from_file = True
                            else:
                                logger.warning(
                                    f"Skipping trip with transactionId {t.get('transactionId', 'N/A')} "
                                    f"from GeoJSON file {filename} in /api/upload due to invalid/missing GPS after validation."
                                )
                        if not processed_one_from_file and trips:
                            logger.warning(
                                f"GeoJSON file {filename} in /api/upload contained trips, but none had valid GPS after processing."
                            )
                except json.JSONDecodeError:
                    logger.warning(
                        "Invalid geojson: %s",
                        filename,
                    )
                    continue
                except Exception as geojson_err:
                    logger.error(
                        "Error processing GeoJSON file %s in /api/upload: %s",
                        filename,
                        geojson_err,
                    )
                    continue

        return {
            "status": "success",
            "message": f"Processed {count} trips",
        }
    except Exception as e:
        logger.exception("Error uploading files: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
