import pytest
from beanie import init_beanie
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

import setup_api
from db.models import SetupSession
from setup_api import (
    SetupSessionAdvanceRequest,
    SetupSessionRequest,
    advance_setup_session,
    create_or_resume_setup_session,
    get_setup_session,
)


@pytest.fixture
async def setup_session_db():
    client = AsyncMongoMockClient()
    await init_beanie(database=client["test_db"], document_models=[SetupSession])
    return client


@pytest.fixture(autouse=True)
def _mock_setup_status(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_status():
        return {
            "setup_completed": False,
            "setup_completed_at": None,
            "required_complete": False,
            "steps": {
                "bouncie": {"complete": False, "missing": [], "required": True},
                "mapbox": {
                    "complete": False,
                    "missing": [],
                    "error": None,
                    "required": True,
                },
                "region": {"complete": False, "required": False},
            },
        }

    monkeypatch.setattr(setup_api, "get_setup_status", fake_status)


@pytest.mark.asyncio
async def test_setup_session_idempotent_create(setup_session_db) -> None:
    payload = SetupSessionRequest(client_id="tab-1")
    first = await create_or_resume_setup_session(payload)
    second = await create_or_resume_setup_session(payload)

    assert first["session"]["id"] == second["session"]["id"]


@pytest.mark.asyncio
async def test_setup_session_advance_idempotent(setup_session_db) -> None:
    payload = SetupSessionRequest(client_id="tab-1")
    session = await create_or_resume_setup_session(payload)
    session_id = session["session"]["id"]
    version = session["session"]["version"]

    advance_payload = SetupSessionAdvanceRequest(
        client_id="tab-1",
        current_step="bouncie",
        next_step="mapbox",
        version=version,
        idempotency_key="advance-1",
    )

    first = await advance_setup_session(session_id, advance_payload)
    second = await advance_setup_session(session_id, advance_payload)

    assert first["session"]["version"] == second["session"]["version"]


@pytest.mark.asyncio
async def test_setup_session_rejects_stale_version(setup_session_db) -> None:
    payload = SetupSessionRequest(client_id="tab-1")
    session = await create_or_resume_setup_session(payload)
    session_id = session["session"]["id"]
    version = session["session"]["version"]

    await advance_setup_session(
        session_id,
        SetupSessionAdvanceRequest(
            client_id="tab-1",
            current_step="bouncie",
            next_step="mapbox",
            version=version,
            idempotency_key="advance-1",
        ),
    )

    with pytest.raises(HTTPException) as raised:
        await advance_setup_session(
            session_id,
            SetupSessionAdvanceRequest(
                client_id="tab-1",
                current_step="bouncie",
                next_step="mapbox",
                version=version,
                idempotency_key="advance-2",
            ),
        )

    assert raised.value.status_code == 409


@pytest.mark.asyncio
async def test_setup_session_multi_tab_read_only(setup_session_db) -> None:
    payload = SetupSessionRequest(client_id="tab-1")
    session = await create_or_resume_setup_session(payload)
    session_id = session["session"]["id"]

    tab_two = await get_setup_session(client_id="tab-2")

    assert tab_two["session"]["id"] == session_id
    assert tab_two["client"]["is_owner"] is False
