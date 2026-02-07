"""Trip ingest issues service.

This module records fetch/validation/processing problems in a durable,
user-facing log for Settings -> Data.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId

from db.models import TripIngestIssue

logger = logging.getLogger(__name__)


def _clean_message(message: str | None, *, limit: int = 240) -> str:
    text = (message or "").strip() or "Unknown error"
    text = text.replace("\r", " ").replace("\n", " ")
    if len(text) > limit:
        text = text[: limit - 3] + "..."
    return text


def _fingerprint(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()  # nosec - non-crypto dedupe key


class TripIngestIssueService:
    """High-level API for recording and querying ingest issues."""

    @staticmethod
    async def record_issue(
        *,
        issue_type: str,
        message: str | None,
        source: str | None = None,
        transaction_id: str | None = None,
        imei: str | None = None,
        details: dict[str, Any] | None = None,
        resolved: bool | None = None,
    ) -> TripIngestIssue | None:
        """
        Upsert an issue record, incrementing count for repeat occurrences.

        The upsert key ("fingerprint") is based on (issue_type, source, identifiers, message).
        """
        issue_type = (issue_type or "").strip() or "unknown"
        source = (source or "").strip() or None
        transaction_id = (transaction_id or "").strip() or None
        imei = (imei or "").strip() or None
        msg = _clean_message(message)
        details = details if isinstance(details, dict) else None

        now = datetime.now(UTC)

        fp_payload: dict[str, Any] = {
            "issue_type": issue_type,
            "source": source,
            "transaction_id": transaction_id,
            "imei": imei,
            "message": msg,
        }
        fp = _fingerprint(fp_payload)

        try:
            existing = await TripIngestIssue.find_one(TripIngestIssue.fingerprint == fp)
            if existing:
                existing.last_seen_at = now
                existing.occurrences = int(getattr(existing, "occurrences", 0) or 0) + 1
                existing.message = msg
                if details is not None:
                    existing.details = details
                # If the issue reoccurs, bring it back to the user's attention.
                existing.resolved = bool(resolved) if resolved is not None else False
                if existing.resolved:
                    existing.resolved_at = now
                else:
                    existing.resolved_at = None
                await existing.save()
                return existing

            issue = TripIngestIssue(
                created_at=now,
                last_seen_at=now,
                issue_type=issue_type,
                source=source,
                transactionId=transaction_id,
                imei=imei,
                message=msg,
                details=details,
                occurrences=1,
                resolved=bool(resolved) if resolved is not None else False,
                resolved_at=now if resolved else None,
                fingerprint=fp,
            )
            await issue.insert()
            return issue
        except Exception:
            logger.exception("Failed to record trip ingest issue")
            return None

    @staticmethod
    async def list_issues(
        *,
        page: int = 1,
        limit: int = 50,
        issue_type: str | None = None,
        include_resolved: bool = False,
        search: str | None = None,
    ) -> dict[str, Any]:
        safe_page = max(1, int(page or 1))
        safe_limit = max(1, min(200, int(limit or 50)))

        query: dict[str, Any] = {}
        if issue_type:
            query["issue_type"] = issue_type
        if not include_resolved:
            query["resolved"] = {"$ne": True}

        if search:
            s = str(search).strip()
            if s:
                # Basic substring match across a few high-signal fields.
                query["$or"] = [
                    {"message": {"$regex": s, "$options": "i"}},
                    {"transactionId": {"$regex": s, "$options": "i"}},
                    {"imei": {"$regex": s, "$options": "i"}},
                    {"source": {"$regex": s, "$options": "i"}},
                ]

        cursor = TripIngestIssue.find(query).sort("-last_seen_at")
        total = await cursor.count()
        docs = await cursor.skip((safe_page - 1) * safe_limit).limit(safe_limit).to_list()

        def serialize(doc: TripIngestIssue) -> dict[str, Any]:
            return {
                "id": str(doc.id) if getattr(doc, "id", None) else None,
                "created_at": doc.created_at,
                "last_seen_at": doc.last_seen_at,
                "issue_type": doc.issue_type,
                "source": doc.source,
                "transaction_id": doc.transactionId,
                "imei": doc.imei,
                "message": doc.message,
                "details": doc.details,
                "occurrences": int(doc.occurrences or 1),
                "resolved": bool(doc.resolved),
                "resolved_at": doc.resolved_at,
            }

        issues = [serialize(d) for d in docs]

        # Small stats payload for UI chips.
        open_total = await TripIngestIssue.find({"resolved": {"$ne": True}}).count()

        type_counts: dict[str, int] = {}
        for t in ("fetch_error", "validation_failed", "process_error"):
            type_counts[t] = await TripIngestIssue.find(
                {"resolved": {"$ne": True}, "issue_type": t},
            ).count()

        return {
            "status": "success",
            "issues": issues,
            "count": total,
            "page": safe_page,
            "limit": safe_limit,
            "open_total": open_total,
            "open_counts": type_counts,
        }

    @staticmethod
    async def resolve_issue(issue_id: str) -> bool:
        if not issue_id:
            return False
        try:
            oid = PydanticObjectId(issue_id)
        except Exception:
            return False

        issue = await TripIngestIssue.get(oid)
        if not issue:
            return False

        issue.resolved = True
        issue.resolved_at = datetime.now(UTC)
        await issue.save()
        return True

    @staticmethod
    async def delete_issue(issue_id: str) -> bool:
        if not issue_id:
            return False
        try:
            oid = PydanticObjectId(issue_id)
        except Exception:
            return False

        issue = await TripIngestIssue.get(oid)
        if not issue:
            return False

        await issue.delete()
        return True
