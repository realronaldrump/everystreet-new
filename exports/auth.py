from __future__ import annotations

from fastapi import HTTPException, Request, status


def get_owner_key(request: Request) -> str:
    owner_key = request.headers.get("X-Export-Owner", "").strip()
    return owner_key or "default"


def enforce_owner(job_owner: str | None, request_owner: str) -> None:
    if job_owner != request_owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to access this export job.",
        )
