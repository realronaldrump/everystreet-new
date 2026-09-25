from unittest.mock import AsyncMock, patch

import pytest
from coverage_helpers import area_with_streets, coverage_database, drive
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from api import map_bundle


@pytest.fixture
async def bundle_db(monkeypatch):
    monkeypatch.setattr(map_bundle, "_get_cached_body", AsyncMock(return_value=None))
    monkeypatch.setattr(map_bundle, "_set_cached_body", AsyncMock())
    return await coverage_database()


def _client():
    app = FastAPI()
    app.include_router(map_bundle.router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_coverage_bundle_filters_by_status_and_revalidates_before_reading(
    bundle_db,
):
    area, ids = await area_with_streets([1, 1])
    await drive(area, {ids[0]: [[0, 1]]})
    path = f"/api/map/coverage/areas/{area.id}/bundle"
    async with _client() as client:
        everything = await client.get(path)
        driven = await client.get(path, params={"status": "driven"})
        undriven = await client.get(path, params={"status": "undriven"})
        with patch.object(map_bundle.Street, "get_pymongo_collection") as streets:
            cached = await client.get(
                path, headers={"If-None-Match": everything.headers["etag"]}
            )

    assert everything.status_code == 200
    statuses = {row["id"]: row["status"] for row in everything.json()["segments"]}
    assert statuses == {ids[0]: "driven", ids[1]: "undriven"}
    assert [row["id"] for row in driven.json()["segments"]] == [ids[0]]
    assert [row["id"] for row in undriven.json()["segments"]] == [ids[1]]
    assert cached.status_code == 304
    streets.assert_not_called()


async def test_coverage_bundle_revision_changes_when_coverage_changes(bundle_db):
    area, ids = await area_with_streets([1, 1])
    path = f"/api/map/coverage/areas/{area.id}/bundle"
    async with _client() as client:
        before = await client.get(path)
        await drive(area, {ids[1]: [[0, 1]]})
        after = await client.get(
            path, headers={"If-None-Match": before.headers["etag"]}
        )

    assert after.status_code == 200
    assert after.headers["etag"] != before.headers["etag"]
    statuses = {row["id"]: row["status"] for row in after.json()["segments"]}
    assert statuses[ids[1]] == "driven"
