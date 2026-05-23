"""Owner authentication routes."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse

from core.auth import (
    TooManyLoginAttemptsError,
    check_login_rate_limit,
    clear_auth_session,
    clear_failed_login_attempts,
    get_client_ip,
    get_request_auth_context,
    mark_owner_session,
    record_failed_login,
    sanitize_next_path,
    validate_form_csrf_token,
    verify_owner_password,
)
from core.template_context import render_template

logger = logging.getLogger(__name__)
router = APIRouter(tags=["auth"])


async def _render_login_page(
    request: Request,
    *,
    next_path: str,
    error_message: str | None = None,
    status_code: int = status.HTTP_200_OK,
) -> HTMLResponse:
    return await render_template(
        request,
        "login.html",
        status_code=status_code,
        login_next=next_path,
        login_error=error_message,
    )


@router.get("/login", response_class=HTMLResponse, response_model=None)
async def login_page(
    request: Request,
    next_path: Annotated[str | None, Query(alias="next")] = None,
):
    """Render the owner login page."""
    next_path = sanitize_next_path(next_path)
    auth_context = get_request_auth_context(request)
    if auth_context.is_owner:
        return RedirectResponse(url=next_path, status_code=status.HTTP_303_SEE_OTHER)
    return await _render_login_page(request, next_path=next_path)


@router.post("/login", response_class=HTMLResponse, response_model=None)
async def login_submit(
    request: Request,
    password: str = Form(default=""),
    next_path: Annotated[str | None, Form(alias="next")] = None,
):
    """Authenticate the owner session."""
    next_path = sanitize_next_path(next_path)
    ip_address = get_client_ip(request)

    try:
        await check_login_rate_limit(ip_address)
    except TooManyLoginAttemptsError:
        return await _render_login_page(
            request,
            next_path=next_path,
            error_message="Too many failed logins. Try again in 15 minutes.",
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        )

    if not verify_owner_password(password):
        await record_failed_login(ip_address)
        return await _render_login_page(
            request,
            next_path=next_path,
            error_message="Incorrect password.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    mark_owner_session(request)
    await clear_failed_login_attempts(ip_address)
    logger.info("Owner login succeeded from %s", ip_address)
    return RedirectResponse(url=next_path, status_code=status.HTTP_303_SEE_OTHER)


@router.post("/logout", response_model=None)
async def logout_submit(
    request: Request,
    csrf_token: str = Form(default=""),
):
    """Clear the current owner session."""
    if not validate_form_csrf_token(request, csrf_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid CSRF token.",
        )
    clear_auth_session(request)
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)


@router.get("/api/auth/session")
async def auth_session(request: Request) -> dict[str, object]:
    """Return the current auth/session state for the frontend."""
    return get_request_auth_context(request).to_payload()
