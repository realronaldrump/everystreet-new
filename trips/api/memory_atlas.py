"""Trip Memory Atlas API routes."""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from core.api import api_route
from core.http.session import get_session
from db.models import Trip, TripMemoryPostcard, TripPhotoMoment
from google_photos.services.client import (
    GooglePhotosApiError,
    GooglePhotosClient,
    normalize_picker_media_item,
)
from google_photos.services.credentials import get_google_photos_credentials
from google_photos.services.oauth import (
    GOOGLE_PHOTOS_SCOPE_APPENDONLY,
    GOOGLE_PHOTOS_SCOPE_EDIT_APPCREATED,
    GOOGLE_PHOTOS_SCOPE_PICKER_READONLY,
    GooglePhotosOAuth,
)
from trips.services.memory_atlas_service import (
    build_postcard_image,
    compute_moment_anchor,
    delete_generated_file,
    download_moment_thumbnail,
    extract_trip_coordinates,
    nearest_fraction_for_coordinate,
    select_best_trip_for_moment,
    storage_path_to_url,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class MemoryAtlasAttachRequest(BaseModel):
    """Attach selected media items to a trip."""

    session_id: str | None = None
    media_items: list[dict[str, Any]] | None = None
    clear_existing: bool = False
    download_thumbnails: bool = True


class MemoryAtlasAutoAssignRequest(BaseModel):
    """Auto-assign selected media items to likely trips."""

    session_id: str | None = None
    media_items: list[dict[str, Any]] | None = None
    download_thumbnails: bool = True
    max_time_gap_minutes: int = Field(default=180, ge=5, le=24 * 60)
    max_location_distance_meters: int = Field(default=1500, ge=100, le=25_000)


class MemoryAtlasPostcardRequest(BaseModel):
    """Generate and optionally upload a route postcard."""

    upload_to_google_photos: bool = False
    album_title: str | None = None
    description: str | None = None
    include_moment_limit: int = Field(default=4, ge=1, le=12)


class MemoryAtlasMomentUpdateRequest(BaseModel):
    """Manual anchor update payload for a single moment."""

    lat: float
    lon: float


def _serialize_moment(moment: TripPhotoMoment) -> dict[str, Any]:
    payload = moment.model_dump()
    payload["id"] = str(moment.id)
    capture_time = payload.get("capture_time")
    if hasattr(capture_time, "isoformat"):
        payload["capture_time"] = capture_time.isoformat()
    payload["thumbnail_url"] = storage_path_to_url(payload.get("thumbnail_path"))
    return payload


def _serialize_postcard(postcard: TripMemoryPostcard | None) -> dict[str, Any] | None:
    if not postcard:
        return None
    payload = postcard.model_dump()
    payload["id"] = str(postcard.id)
    payload["image_url"] = storage_path_to_url(payload.get("image_storage_path"))
    created_at = payload.get("created_at")
    if hasattr(created_at, "isoformat"):
        payload["created_at"] = created_at.isoformat()
    return payload


async def _load_trip_or_404(trip_id: str) -> Trip:
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if trip is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found.",
        )
    return trip


async def _collect_session_media_items(session_id: str) -> list[dict[str, Any]]:
    credentials = await get_google_photos_credentials()
    http_session = await get_session()
    token = await GooglePhotosOAuth.get_access_token(
        credentials=credentials,
        required_scopes=[GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
        session=http_session,
    )
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=(
                "Google Photos picker access is not authorized. "
                "Reconnect from Settings > Credentials."
            ),
        )

    all_items: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        try:
            response = await GooglePhotosClient.list_picker_media_items(
                http_session,
                token,
                session_id,
                page_token=page_token,
                page_size=100,
            )
        except GooglePhotosApiError as exc:
            raise HTTPException(
                status_code=exc.status or status.HTTP_502_BAD_GATEWAY,
                detail=exc.message,
            ) from exc

        page_items = response.get("mediaItems") or []
        all_items.extend(page_items)
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    try:
        await GooglePhotosClient.delete_picker_session(http_session, token, session_id)
    except GooglePhotosApiError:
        logger.warning("Unable to delete picker session %s during attach", session_id)

    return all_items


def _normalize_media_items(raw_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in raw_items:
        entry = normalize_picker_media_item(item)
        media_item_id = (entry.get("id") or "").strip()
        if not media_item_id:
            continue
        entry["id"] = media_item_id
        normalized.append(entry)
    return normalized


async def _clear_trip_moments(trip: Trip) -> None:
    existing = await TripPhotoMoment.find(TripPhotoMoment.trip_id == trip.id).to_list()
    for moment in existing:
        delete_generated_file(moment.thumbnail_path)
    await TripPhotoMoment.find(TripPhotoMoment.trip_id == trip.id).delete()


async def _upsert_trip_photo_moment(
    *,
    trip: Trip,
    normalized: dict[str, Any],
    session_id: str | None,
    sequence_fraction: float,
    coordinates: list[list[float]],
    download_thumbnails: bool,
    http_session,
    allow_reassignment: bool = False,
    assignment_strategy: str | None = None,
    assignment_confidence: float | None = None,
) -> tuple[TripPhotoMoment, bool]:
    media_item_id = str(normalized.get("id") or "").strip()
    if not media_item_id:
        raise ValueError("media item id is required")

    capture_time = normalized.get("capture_time")
    lat = normalized.get("lat")
    lon = normalized.get("lon")
    anchor = compute_moment_anchor(
        trip=trip,
        coordinates=coordinates,
        lat=lat,
        lon=lon,
        capture_time=capture_time,
        sequence_fraction=sequence_fraction,
    )
    if assignment_confidence is not None:
        blended_confidence = max(
            float(anchor["anchor_confidence"]),
            float(assignment_confidence) * 0.9,
        )
        anchor["anchor_confidence"] = blended_confidence

    thumbnail_path = None
    if download_thumbnails:
        try:
            thumbnail_path = await download_moment_thumbnail(
                session=http_session,
                trip_transaction_id=trip.transactionId or str(trip.id),
                media_item_id=media_item_id,
                mime_type=normalized.get("mime_type"),
                base_url=normalized.get("base_url"),
            )
        except GooglePhotosApiError as exc:
            logger.warning(
                "Thumbnail download failed for media item %s: %s",
                media_item_id,
                exc.message,
            )
        except Exception:
            logger.exception("Thumbnail download failed for media item %s", media_item_id)

    moment = await TripPhotoMoment.find_one(
        TripPhotoMoment.trip_id == trip.id,
        TripPhotoMoment.media_item_id == media_item_id,
    )
    if moment is None and allow_reassignment:
        previous = await TripPhotoMoment.find_one(
            TripPhotoMoment.media_item_id == media_item_id,
        )
        if previous is not None:
            moment = previous

    now = datetime.now(UTC)
    is_existing = moment is not None
    if moment is None:
        moment = TripPhotoMoment(
            trip_id=trip.id,
            trip_transaction_id=trip.transactionId,
            session_id=session_id,
            media_item_id=media_item_id,
            created_at=now,
        )

    moment.trip_id = trip.id
    moment.trip_transaction_id = trip.transactionId
    moment.updated_at = now
    moment.session_id = session_id
    moment.mime_type = normalized.get("mime_type")
    moment.file_name = normalized.get("file_name")
    moment.capture_time = capture_time
    moment.lat = anchor["lat"]
    moment.lon = anchor["lon"]
    moment.anchor_strategy = anchor["anchor_strategy"]
    moment.anchor_confidence = float(anchor["anchor_confidence"])
    moment.anchor_fraction = anchor["anchor_fraction"]
    if assignment_strategy:
        moment.assignment_strategy = assignment_strategy
    if assignment_confidence is not None:
        moment.assignment_confidence = float(assignment_confidence)
    if thumbnail_path:
        moment.thumbnail_path = thumbnail_path

    if is_existing:
        await moment.save()
    else:
        await moment.insert()
    unresolved = moment.anchor_strategy == "manual_review"
    return moment, unresolved


@router.post("/api/trips/{trip_id}/memory-atlas/attach", response_model=dict[str, Any])
@api_route(logger)
async def attach_trip_memory_atlas(
    trip_id: str,
    payload: MemoryAtlasAttachRequest,
) -> dict[str, Any]:
    trip = await _load_trip_or_404(trip_id)

    raw_media_items = list(payload.media_items or [])
    if payload.session_id and not raw_media_items:
        raw_media_items = await _collect_session_media_items(payload.session_id)
    if not raw_media_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No media items were provided for attachment.",
        )
    media_items = _normalize_media_items(raw_media_items)
    if not media_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid media items were found in the request.",
        )

    if payload.clear_existing:
        await _clear_trip_moments(trip)

    coordinates = extract_trip_coordinates(trip)
    total_items = max(1, len(media_items))
    attached = 0
    unresolved = 0

    http_session = await get_session()
    for index, normalized in enumerate(media_items):
        _, is_unresolved = await _upsert_trip_photo_moment(
            trip=trip,
            normalized=normalized,
            session_id=payload.session_id,
            sequence_fraction=index / total_items,
            coordinates=coordinates,
            download_thumbnails=payload.download_thumbnails,
            http_session=http_session,
        )
        if is_unresolved:
            unresolved += 1
        attached += 1

    moments = await TripPhotoMoment.find(TripPhotoMoment.trip_id == trip.id).to_list()
    serialized = [_serialize_moment(moment) for moment in moments]
    return {
        "status": "success",
        "message": f"Attached {attached} media items to trip memory atlas.",
        "attached_count": attached,
        "skipped_count": len(raw_media_items) - len(media_items),
        "unresolved_count": unresolved,
        "moments": serialized,
    }


@router.post("/api/trips/memory-atlas/auto-assign", response_model=dict[str, Any])
@api_route(logger)
async def auto_assign_trip_memory_atlas(
    payload: MemoryAtlasAutoAssignRequest,
) -> dict[str, Any]:
    raw_media_items = list(payload.media_items or [])
    if payload.session_id and not raw_media_items:
        raw_media_items = await _collect_session_media_items(payload.session_id)
    if not raw_media_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No media items were provided for auto-assignment.",
        )

    media_items = _normalize_media_items(raw_media_items)
    if not media_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid media items were found for auto-assignment.",
        )

    max_gap_seconds = int(payload.max_time_gap_minutes) * 60
    max_gap_delta = timedelta(seconds=max_gap_seconds)
    capture_times = [
        item["capture_time"] for item in media_items if item.get("capture_time") is not None
    ]
    if capture_times:
        query_start = min(capture_times) - max_gap_delta
        query_end = max(capture_times) + max_gap_delta
        trips = await Trip.find(
            {
                "endTime": {"$gte": query_start},
                "startTime": {"$lte": query_end},
            },
        ).sort((Trip.startTime, 1)).to_list()
    else:
        trips = await Trip.find_all().sort((Trip.startTime, 1)).to_list()

    if not trips:
        unmatched_count = len(media_items)
        return {
            "status": "success",
            "message": "No trips were found for automatic memory assignment.",
            "assigned_count": 0,
            "unmatched_count": unmatched_count,
            "skipped_count": len(raw_media_items) - len(media_items),
            "unresolved_count": 0,
            "trips_updated": [],
            "unmatched_media_item_ids": [item["id"] for item in media_items[:50]],
        }

    coordinates_by_trip_id = {str(trip.id): extract_trip_coordinates(trip) for trip in trips}
    trips_by_id = {str(trip.id): trip for trip in trips}
    assignments: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    unmatched_media_item_ids: list[str] = []

    for item in media_items:
        match = select_best_trip_for_moment(
            trips=trips,
            coordinates_by_trip_id=coordinates_by_trip_id,
            capture_time=item.get("capture_time"),
            lat=item.get("lat"),
            lon=item.get("lon"),
            max_time_gap_seconds=max_gap_seconds,
            max_location_distance_meters=float(payload.max_location_distance_meters),
        )
        target_trip = match.get("trip")
        if target_trip is None:
            unmatched_media_item_ids.append(item["id"])
            continue
        assignments[str(target_trip.id)].append((item, match))

    http_session = await get_session()
    assigned_count = 0
    unresolved_count = 0
    trips_updated: list[dict[str, Any]] = []

    for trip_key, assigned_items in assignments.items():
        trip = trips_by_id.get(trip_key)
        if trip is None:
            continue
        coordinates = coordinates_by_trip_id.get(trip_key) or []
        per_trip_total = max(1, len(assigned_items))
        per_trip_attached = 0
        per_trip_unresolved = 0

        for idx, (normalized, match) in enumerate(assigned_items):
            _, is_unresolved = await _upsert_trip_photo_moment(
                trip=trip,
                normalized=normalized,
                session_id=payload.session_id,
                sequence_fraction=idx / per_trip_total,
                coordinates=coordinates,
                download_thumbnails=payload.download_thumbnails,
                http_session=http_session,
                allow_reassignment=True,
                assignment_strategy=str(match.get("strategy") or "auto"),
                assignment_confidence=float(match.get("confidence") or 0.0),
            )
            assigned_count += 1
            per_trip_attached += 1
            if is_unresolved:
                unresolved_count += 1
                per_trip_unresolved += 1

        trips_updated.append(
            {
                "trip_id": trip.transactionId,
                "attached_count": per_trip_attached,
                "unresolved_count": per_trip_unresolved,
            },
        )

    trips_updated.sort(
        key=lambda row: (
            -int(row.get("attached_count", 0)),
            str(row.get("trip_id") or ""),
        ),
    )
    unmatched_count = len(unmatched_media_item_ids)
    skipped_count = len(raw_media_items) - len(media_items)
    return {
        "status": "success",
        "message": (
            f"Auto-assigned {assigned_count} media item(s) across "
            f"{len(trips_updated)} trip(s)."
        ),
        "assigned_count": assigned_count,
        "unmatched_count": unmatched_count,
        "skipped_count": skipped_count,
        "unresolved_count": unresolved_count,
        "trips_updated": trips_updated,
        "unmatched_media_item_ids": unmatched_media_item_ids[:50],
    }


@router.get("/api/trips/{trip_id}/memory-atlas", response_model=dict[str, Any])
@api_route(logger)
async def get_trip_memory_atlas(trip_id: str) -> dict[str, Any]:
    trip = await _load_trip_or_404(trip_id)
    moments = await TripPhotoMoment.find(TripPhotoMoment.trip_id == trip.id).sort(
        (TripPhotoMoment.capture_time, 1),
        (TripPhotoMoment.created_at, 1),
    ).to_list()
    postcard_rows = await TripMemoryPostcard.find(
        TripMemoryPostcard.trip_id == trip.id,
    ).sort(
        (TripMemoryPostcard.created_at, -1),
    ).limit(1).to_list()
    postcard = postcard_rows[0] if postcard_rows else None

    return {
        "status": "success",
        "trip_id": trip.transactionId,
        "moments": [_serialize_moment(moment) for moment in moments],
        "postcard": _serialize_postcard(postcard),
    }


@router.post("/api/trips/{trip_id}/memory-atlas/postcard", response_model=dict[str, Any])
@api_route(logger)
async def generate_trip_memory_postcard(
    trip_id: str,
    payload: MemoryAtlasPostcardRequest,
) -> dict[str, Any]:
    trip = await _load_trip_or_404(trip_id)
    moments = await TripPhotoMoment.find(TripPhotoMoment.trip_id == trip.id).sort(
        (TripPhotoMoment.capture_time, 1),
        (TripPhotoMoment.created_at, 1),
    ).to_list()
    moment_payloads = [_serialize_moment(moment) for moment in moments][: payload.include_moment_limit]
    image_storage_path = build_postcard_image(trip=trip, moments=moment_payloads)

    google_album_id: str | None = None
    google_media_item_id: str | None = None
    upload_error: str | None = None

    if payload.upload_to_google_photos:
        credentials = await get_google_photos_credentials()
        if not credentials.get("postcard_export_enabled"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Postcard export is disabled in Google Photos settings. "
                    "Enable it and reconnect first."
                ),
            )

        http_session = await get_session()
        token = await GooglePhotosOAuth.get_access_token(
            credentials=credentials,
            required_scopes=[
                GOOGLE_PHOTOS_SCOPE_APPENDONLY,
                GOOGLE_PHOTOS_SCOPE_EDIT_APPCREATED,
            ],
            session=http_session,
        )
        if not token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Google Photos postcard export is not authorized.",
            )

        try:
            postcard_bytes = Path(image_storage_path).read_bytes()
            ext = Path(image_storage_path).suffix.lower()
            content_type = "image/png" if ext == ".png" else "image/svg+xml"
            upload_token = await GooglePhotosClient.upload_bytes(
                http_session,
                token,
                file_name=Path(image_storage_path).name,
                content_type=content_type,
                payload=postcard_bytes,
            )

            album_title = payload.album_title
            if not album_title:
                trip_start = trip.startTime or datetime.now(UTC)
                stamp = trip_start.strftime("%Y-%m-%d")
                album_title = f"EveryStreet Memory Atlas - {stamp}"

            album = await GooglePhotosClient.create_album(
                http_session,
                token,
                title=album_title,
            )
            google_album_id = album.get("id")

            batch = await GooglePhotosClient.batch_create_media_item(
                http_session,
                token,
                upload_token=upload_token,
                file_name=Path(image_storage_path).name,
                description=payload.description or f"Route memory postcard for trip {trip_id}",
                album_id=google_album_id,
            )
            results = batch.get("newMediaItemResults") or []
            first = results[0] if results else {}
            google_media_item_id = (
                (first.get("mediaItem") or {}).get("id")
                if isinstance(first, dict)
                else None
            )
        except GooglePhotosApiError as exc:
            upload_error = exc.message
        except Exception as exc:
            logger.exception("Failed to upload postcard to Google Photos")
            upload_error = str(exc)

    postcard = TripMemoryPostcard(
        trip_id=trip.id,
        trip_transaction_id=trip.transactionId,
        image_storage_path=image_storage_path,
        google_album_id=google_album_id,
        google_media_item_id=google_media_item_id,
    )
    await postcard.insert()

    serialized = _serialize_postcard(postcard) or {}
    return {
        "status": "success",
        "message": "Trip memory postcard generated.",
        "postcard": serialized,
        "upload_error": upload_error,
    }


@router.patch(
    "/api/trips/{trip_id}/memory-atlas/moments/{moment_id}",
    response_model=dict[str, Any],
)
@api_route(logger)
async def update_trip_memory_moment_anchor(
    trip_id: str,
    moment_id: str,
    payload: MemoryAtlasMomentUpdateRequest,
) -> dict[str, Any]:
    trip = await _load_trip_or_404(trip_id)
    try:
        moment_obj_id = PydanticObjectId(moment_id)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid moment id.",
        ) from exc

    moment = await TripPhotoMoment.find_one(
        TripPhotoMoment.id == moment_obj_id,
        TripPhotoMoment.trip_id == trip.id,
    )
    if moment is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Memory moment not found for trip.",
        )

    coordinates = extract_trip_coordinates(trip)
    fraction = nearest_fraction_for_coordinate(coordinates, payload.lon, payload.lat)
    moment.lat = payload.lat
    moment.lon = payload.lon
    moment.anchor_fraction = fraction
    moment.anchor_strategy = "manual_map_click"
    moment.anchor_confidence = 0.72
    moment.updated_at = datetime.now(UTC)
    await moment.save()

    return {
        "status": "success",
        "message": "Memory moment anchor updated.",
        "moment": _serialize_moment(moment),
    }
