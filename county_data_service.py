"""Helpers for loading and storing county topology data in MongoDB.

This module centralizes access to the county TopoJSON documents so the data
can be served from the database instead of static files on disk.

If the requested topology is missing, it will be fetched from a stable CDN
source and cached in MongoDB for subsequent requests.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from typing import Any

import httpx

from db.models import CountyTopology

logger = logging.getLogger(__name__)

COUNTY_TOPOLOGY_COLLECTION = "county_topology"

DEFAULT_TOPOLOGY_VARIANT = "standard"
TOPOLOGY_VARIANTS: dict[str, dict[str, str]] = {
    "standard": {
        "id": "counties_10m",
        "projection": "unprojected",
        "source": os.getenv(
            "COUNTY_TOPOLOGY_URL",
            "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json",
        ),
    },
    "albers": {
        "id": "counties_albers_10m",
        "projection": "albers",
        "source": os.getenv(
            "COUNTY_TOPOLOGY_ALBERS_URL",
            "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-albers-10m.json",
        ),
    },
}

TOPOLOGY_ALIASES: dict[str, str] = {
    "default": DEFAULT_TOPOLOGY_VARIANT,
    "unprojected": DEFAULT_TOPOLOGY_VARIANT,
}


def _resolve_variant_key(requested: str | None) -> str:
    """Normalize a requested projection/variant string."""

    if not requested:
        return DEFAULT_TOPOLOGY_VARIANT

    normalized = requested.lower().strip()
    normalized = TOPOLOGY_ALIASES.get(normalized, normalized)
    if normalized not in TOPOLOGY_VARIANTS:
        logger.warning(
            "Unknown county topology variant '%s'. Falling back to '%s'.",
            requested,
            DEFAULT_TOPOLOGY_VARIANT,
        )
        return DEFAULT_TOPOLOGY_VARIANT
    return normalized


async def get_county_topology_document(
    projection: str | None = None,
    *,
    ensure_available: bool = True,
) -> dict[str, Any] | None:
    """Fetch a county TopoJSON document from MongoDB.

    If ``ensure_available`` is True and the document is missing, the data will
    be downloaded from the configured source URL and stored in the database
    before being returned.
    """

    variant_key = _resolve_variant_key(projection)
    variant = TOPOLOGY_VARIANTS[variant_key]

    document = await CountyTopology.get(variant["id"])
    if document and document.topology:
        return document.model_dump()

    if not ensure_available:
        return None

    return await _download_and_store_topology(variant_key, variant)


async def _download_and_store_topology(
    variant_key: str, variant: dict[str, str]
) -> dict[str, Any]:
    """Download a topology file from its source URL and persist it."""

    logger.info(
        "Downloading county topology for variant '%s' from %s",
        variant_key,
        variant["source"],
    )

    async with httpx.AsyncClient() as client:
        response = await client.get(variant["source"], timeout=30)
        response.raise_for_status()
        topology_data: dict[str, Any] = response.json()

    document = {
        "_id": variant["id"],
        "projection": variant.get("projection", variant_key),
        "source": variant["source"],
        "topology": topology_data,
        "updated_at": datetime.now(UTC),
    }

    collection = db_manager.get_collection(COUNTY_TOPOLOGY_COLLECTION)
    await collection.replace_one({"_id": variant["id"]}, document, upsert=True)
    logger.info("Stored county topology variant '%s' in MongoDB", variant_key)
    return document


async def refresh_county_topology(projection: str | None = None) -> dict[str, Any]:
    """Force a fresh download for the requested projection."""

    variant_key = _resolve_variant_key(projection)
    variant = TOPOLOGY_VARIANTS[variant_key]
    return await _download_and_store_topology(variant_key, variant)
