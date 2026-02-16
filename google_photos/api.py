"""Google Photos API routes."""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from core.api import api_route
from core.http.session import get_session
from db.models import TripMemoryPostcard, TripPhotoMoment
from google_photos.services.client import (
    GooglePhotosApiError,
    GooglePhotosClient,
    normalize_picker_media_item,
)
from google_photos.services.credentials import (
    get_google_photos_credentials,
    update_google_photos_credentials,
)
from google_photos.services.oauth import (
    GOOGLE_PHOTOS_SCOPE_PICKER_READONLY,
    GooglePhotosOAuth,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/google-photos", tags=["google-photos"])

OAUTH_STATE_TTL_SECONDS = 10 * 60
SETTINGS_PATH = "/settings"
_DURATION_SECONDS_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)s\s*$", re.IGNORECASE)
_SAFE_DELETE_ROOT = (Path("static") / "generated" / "memory_atlas").resolve()


class GooglePhotosCredentialsPayload(BaseModel):
    """Credentials payload for Google Photos OAuth client configuration."""

    client_id: str
    client_secret: str
    redirect_uri: str
    postcard_export_enabled: bool = False


def _first_forwarded_value(value: str | None) -> str | None:
    if not value:
        return None
    first = value.split(",")[0].strip()
    return first or None


def _build_redirect_uri(request: Request) -> str:
    scheme = _first_forwarded_value(request.headers.get("x-forwarded-proto"))
    host = _first_forwarded_value(request.headers.get("x-forwarded-host"))
    port = _first_forwarded_value(request.headers.get("x-forwarded-port"))

    scheme = scheme or request.url.scheme
    host = host or request.url.netloc
    if port and host and ":" not in host:
        host = f"{host}:{port}"
    return f"{scheme}://{host}/api/google-photos/callback"


def _duration_to_seconds(value: Any, default_value: int) -> int:
    if value is None:
        return default_value
    if isinstance(value, int | float):
        return max(1, int(value))
    if isinstance(value, str):
        parsed = _DURATION_SECONDS_RE.match(value)
        if parsed:
            return max(1, int(float(parsed.group(1))))
        try:
            return max(1, int(float(value)))
        except ValueError:
            return default_value
    return default_value


def _session_payload(session_data: dict[str, Any]) -> dict[str, Any]:
    polling = session_data.get("pollingConfig") or {}
    return {
        "id": session_data.get("id"),
        "picker_uri": session_data.get("pickerUri"),
        "media_items_set": bool(session_data.get("mediaItemsSet")),
        "expire_time": session_data.get("expireTime"),
        "polling": {
            "poll_interval_seconds": _duration_to_seconds(
                polling.get("pollInterval"),
                2,
            ),
            "timeout_seconds": _duration_to_seconds(polling.get("timeoutIn"), 300),
        },
    }


def _serialize_media_item(item: dict[str, Any]) -> dict[str, Any]:
    capture_time = item.get("capture_time")
    if hasattr(capture_time, "isoformat"):
        capture_time = capture_time.isoformat()
    return {
        "id": item.get("id"),
        "mime_type": item.get("mime_type"),
        "file_name": item.get("file_name"),
        "capture_time": capture_time,
        "lat": item.get("lat"),
        "lon": item.get("lon"),
        "width": item.get("width"),
        "height": item.get("height"),
        "base_url": item.get("base_url"),
    }


def _safe_unlink(path_str: str | None) -> None:
    if not path_str:
        return
    path = Path(path_str)
    if not path.is_absolute():
        path = Path(path_str).resolve()
    try:
        resolved = path.resolve()
    except Exception:
        return
    if _SAFE_DELETE_ROOT not in resolved.parents and resolved != _SAFE_DELETE_ROOT:
        return
    try:
        if resolved.exists() and resolved.is_file():
            resolved.unlink()
    except Exception:
        logger.warning("Unable to delete generated file: %s", resolved)


@router.get("/status", response_model=dict[str, Any])
@api_route(logger)
async def google_photos_status() -> dict[str, Any]:
    credentials = await get_google_photos_credentials()
    expires_at = float(credentials.get("expires_at") or 0)
    now = time.time()
    token_fresh = expires_at > now + 120

    return {
        "status": "success",
        "connected": bool(credentials.get("access_token") and token_fresh),
        "configured": bool(
            credentials.get("client_id")
            and credentials.get("client_secret")
            and credentials.get("redirect_uri")
        ),
        "expires_at": credentials.get("expires_at"),
        "token_fresh": token_fresh,
        "granted_scopes": credentials.get("granted_scopes") or [],
        "postcard_export_enabled": bool(credentials.get("postcard_export_enabled")),
        "last_auth_error": credentials.get("last_auth_error"),
        "last_auth_error_detail": credentials.get("last_auth_error_detail"),
    }


@router.get("/credentials", response_model=dict[str, Any])
@api_route(logger)
async def get_google_photos_credentials_endpoint() -> dict[str, Any]:
    credentials = await get_google_photos_credentials()
    return {"status": "success", "credentials": credentials}


@router.post("/credentials", response_model=dict[str, Any])
@api_route(logger)
async def save_google_photos_credentials(
    payload: GooglePhotosCredentialsPayload,
) -> dict[str, Any]:
    client_id = payload.client_id.strip()
    client_secret = payload.client_secret.strip()
    redirect_uri = payload.redirect_uri.strip()

    if not client_id or not client_secret or not redirect_uri:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Google Photos client id, client secret, and redirect URI are required.",
        )

    existing = await get_google_photos_credentials()
    credentials_changed = (
        existing.get("client_id") != client_id
        or existing.get("client_secret") != client_secret
        or existing.get("redirect_uri") != redirect_uri
    )

    update_data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "postcard_export_enabled": bool(payload.postcard_export_enabled),
    }
    if credentials_changed:
        update_data.update(
            {
                "access_token": None,
                "refresh_token": None,
                "expires_at": None,
                "granted_scopes": [],
                "oauth_state": None,
                "oauth_state_expires_at": None,
                "last_auth_error": None,
                "last_auth_error_detail": None,
                "last_auth_error_at": None,
            },
        )

    success = await update_google_photos_credentials(update_data)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save Google Photos credentials.",
        )

    return {
        "status": "success",
        "message": (
            "Google Photos credentials saved. Reconnect to authorize access."
            if credentials_changed
            else "Google Photos credentials saved."
        ),
    }


@router.get("/authorize", response_model=None)
@api_route(logger)
async def authorize_google_photos(
    request: Request,
    mode: Annotated[Literal["picker", "postcard_export"], Query()] = "picker",
) -> RedirectResponse:
    credentials = await get_google_photos_credentials()
    client_id = (credentials.get("client_id") or "").strip()
    client_secret = (credentials.get("client_secret") or "").strip()
    redirect_uri = (credentials.get("redirect_uri") or "").strip()

    if not client_id or not client_secret:
        return RedirectResponse(
            url=(
                f"{SETTINGS_PATH}?google_photos_error="
                + quote("Save your Google Photos client credentials first.", safe="")
            ),
            status_code=302,
        )

    expected_redirect = _build_redirect_uri(request)
    if not redirect_uri:
        redirect_uri = expected_redirect
        await update_google_photos_credentials({"redirect_uri": redirect_uri})
    elif redirect_uri != expected_redirect:
        logger.info(
            "Stored Google Photos redirect URI differs from request-derived URI; using stored value. stored=%s expected=%s",
            redirect_uri,
            expected_redirect,
        )

    state = GooglePhotosOAuth.generate_state()
    state_expires_at = time.time() + OAUTH_STATE_TTL_SECONDS
    await update_google_photos_credentials(
        {"oauth_state": state, "oauth_state_expires_at": state_expires_at},
    )

    auth_url = GooglePhotosOAuth.build_authorize_url(
        client_id=client_id,
        redirect_uri=redirect_uri,
        state=state,
        request_postcard_scopes=(mode == "postcard_export"),
    )
    return RedirectResponse(url=auth_url, status_code=302)


@router.get("/callback", response_model=None)
@api_route(logger)
async def google_photos_oauth_callback(
    code: Annotated[str | None, Query()] = None,
    state: Annotated[str | None, Query()] = None,
    error: Annotated[str | None, Query()] = None,
) -> RedirectResponse:
    credentials = await get_google_photos_credentials()
    stored_state = credentials.get("oauth_state")
    stored_state_expires_at = credentials.get("oauth_state_expires_at")

    if error:
        await update_google_photos_credentials(
            {
                "oauth_state": None,
                "oauth_state_expires_at": None,
                "last_auth_error": "oauth_error",
                "last_auth_error_detail": error,
                "last_auth_error_at": time.time(),
            },
        )
        return RedirectResponse(
            url=f"{SETTINGS_PATH}?google_photos_error=" + quote(error, safe=""),
            status_code=302,
        )

    if stored_state:
        if not state:
            return RedirectResponse(
                url=f"{SETTINGS_PATH}?google_photos_error=missing_state",
                status_code=302,
            )
        if state != stored_state:
            await update_google_photos_credentials(
                {"oauth_state": None, "oauth_state_expires_at": None},
            )
            return RedirectResponse(
                url=f"{SETTINGS_PATH}?google_photos_error=state_mismatch",
                status_code=302,
            )
        if GooglePhotosOAuth.state_expired(stored_state_expires_at):
            await update_google_photos_credentials(
                {"oauth_state": None, "oauth_state_expires_at": None},
            )
            return RedirectResponse(
                url=f"{SETTINGS_PATH}?google_photos_error=state_expired",
                status_code=302,
            )

    if not code:
        return RedirectResponse(
            url=f"{SETTINGS_PATH}?google_photos_error=missing_code",
            status_code=302,
        )

    session = await get_session()
    ok = await GooglePhotosOAuth.exchange_authorization_code(
        code=code,
        credentials=credentials,
        session=session,
    )
    if not ok:
        return RedirectResponse(
            url=f"{SETTINGS_PATH}?google_photos_error=token_exchange_failed",
            status_code=302,
        )

    return RedirectResponse(
        url=f"{SETTINGS_PATH}?google_photos_connected=true",
        status_code=302,
    )


@router.post("/picker/sessions", response_model=dict[str, Any])
@api_route(logger)
async def create_picker_session() -> dict[str, Any]:
    credentials = await get_google_photos_credentials()
    session = await get_session()
    token = await GooglePhotosOAuth.get_access_token(
        credentials=credentials,
        required_scopes=[GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
        session=session,
    )
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=(
                "Google Photos is not authorized for picker access. "
                "Reconnect from Settings > Credentials."
            ),
        )

    try:
        session_data = await GooglePhotosClient.create_picker_session(session, token)
    except GooglePhotosApiError as exc:
        raise HTTPException(
            status_code=exc.status or status.HTTP_502_BAD_GATEWAY,
            detail=exc.message,
        ) from exc

    return {"status": "success", "session": _session_payload(session_data)}


@router.get("/picker/sessions/{session_id}", response_model=dict[str, Any])
@api_route(logger)
async def poll_picker_session(session_id: str) -> dict[str, Any]:
    credentials = await get_google_photos_credentials()
    session = await get_session()
    token = await GooglePhotosOAuth.get_access_token(
        credentials=credentials,
        required_scopes=[GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
        session=session,
    )
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google Photos picker access is not authorized.",
        )

    try:
        session_data = await GooglePhotosClient.get_picker_session(
            session,
            token,
            session_id,
        )
    except GooglePhotosApiError as exc:
        raise HTTPException(
            status_code=exc.status or status.HTTP_502_BAD_GATEWAY,
            detail=exc.message,
        ) from exc

    return {"status": "success", "session": _session_payload(session_data)}


@router.get("/picker/sessions/{session_id}/media-items", response_model=dict[str, Any])
@api_route(logger)
async def list_picker_media_items(
    session_id: str,
    page_token: str | None = None,
    page_size: int = 100,
    delete_session: bool = True,
) -> dict[str, Any]:
    credentials = await get_google_photos_credentials()
    session = await get_session()
    token = await GooglePhotosOAuth.get_access_token(
        credentials=credentials,
        required_scopes=[GOOGLE_PHOTOS_SCOPE_PICKER_READONLY],
        session=session,
    )
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google Photos picker access is not authorized.",
        )

    try:
        response = await GooglePhotosClient.list_picker_media_items(
            session,
            token,
            session_id,
            page_token=page_token,
            page_size=page_size,
        )
    except GooglePhotosApiError as exc:
        raise HTTPException(
            status_code=exc.status or status.HTTP_502_BAD_GATEWAY,
            detail=exc.message,
        ) from exc

    media_items = response.get("mediaItems") or []
    normalized = [_serialize_media_item(normalize_picker_media_item(item)) for item in media_items]
    next_page_token = response.get("nextPageToken")

    session_deleted = False
    if delete_session and not next_page_token:
        try:
            await GooglePhotosClient.delete_picker_session(session, token, session_id)
            session_deleted = True
        except GooglePhotosApiError:
            logger.warning("Unable to delete picker session %s", session_id)

    return {
        "status": "success",
        "media_items": normalized,
        "next_page_token": next_page_token,
        "session_deleted": session_deleted,
    }


@router.delete("/disconnect", response_model=dict[str, Any])
@api_route(logger)
async def disconnect_google_photos(purge_data: bool = False) -> dict[str, Any]:
    credentials = await get_google_photos_credentials()
    session = await get_session()
    await GooglePhotosOAuth.revoke_tokens(credentials=credentials, session=session)

    update_data = {
        "access_token": None,
        "refresh_token": None,
        "expires_at": None,
        "granted_scopes": [],
        "oauth_state": None,
        "oauth_state_expires_at": None,
        "last_auth_error": None,
        "last_auth_error_detail": None,
        "last_auth_error_at": None,
    }
    success = await update_google_photos_credentials(update_data)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to clear Google Photos tokens.",
        )

    removed_moments = 0
    removed_postcards = 0
    if purge_data:
        moments = await TripPhotoMoment.find_all().to_list()
        postcards = await TripMemoryPostcard.find_all().to_list()
        for moment in moments:
            _safe_unlink(moment.thumbnail_path)
        for postcard in postcards:
            _safe_unlink(postcard.image_storage_path)

        deleted_moments = await TripPhotoMoment.find_all().delete()
        deleted_postcards = await TripMemoryPostcard.find_all().delete()
        removed_moments = int(getattr(deleted_moments, "deleted_count", 0))
        removed_postcards = int(getattr(deleted_postcards, "deleted_count", 0))

    return {
        "status": "success",
        "message": "Disconnected Google Photos.",
        "removed_moments": removed_moments,
        "removed_postcards": removed_postcards,
    }
