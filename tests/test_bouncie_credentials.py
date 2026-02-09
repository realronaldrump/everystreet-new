import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import BouncieCredentials
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
    validate_bouncie_credentials,
)


@pytest.fixture
async def bouncie_db():
    client = AsyncMongoMockClient()
    await init_beanie(database=client["test_db"], document_models=[BouncieCredentials])
    return client


@pytest.mark.asyncio
async def test_validate_bouncie_credentials_missing_fields() -> None:
    ok, message = await validate_bouncie_credentials({})
    assert not ok
    assert message.startswith("Missing required field: ")


@pytest.mark.asyncio
async def test_validate_bouncie_credentials_requires_devices() -> None:
    # It is now valid to have no devices
    ok, message = await validate_bouncie_credentials(
        {
            "client_id": "client",
            "client_secret": "secret",
            "redirect_uri": "https://example.com/callback",
            "authorized_devices": [],
        },
    )
    assert ok
    assert message == ""


@pytest.mark.asyncio
async def test_validate_bouncie_credentials_accepts_valid_payload() -> None:
    ok, message = await validate_bouncie_credentials(
        {
            "client_id": "client",
            "client_secret": "secret",
            "redirect_uri": "https://example.com/callback",
            "authorized_devices": ["111"],
        },
    )
    assert ok
    assert message == ""


@pytest.mark.asyncio
async def test_get_bouncie_credentials_returns_defaults(bouncie_db) -> None:
    """get_bouncie_credentials should return defaults when no credentials exist."""
    result = await get_bouncie_credentials()

    assert result["client_id"] == ""
    assert result["client_secret"] == ""
    assert result["fetch_concurrency"] == 12
    assert result["authorized_devices"] == []
    assert result["oauth_state"] is None
    assert result["oauth_state_expires_at"] is None


@pytest.mark.asyncio
async def test_get_bouncie_credentials_returns_stored_values(bouncie_db) -> None:
    """get_bouncie_credentials should return stored values from database."""
    creds = BouncieCredentials(
        id="bouncie_credentials",
        client_id="test-client",
        client_secret="test-secret",
        redirect_uri="https://example.com/cb",
        authorized_devices=["imei-1", "imei-2"],
        fetch_concurrency=5,
    )
    await creds.insert()

    result = await get_bouncie_credentials()

    assert result["client_id"] == "test-client"
    assert result["client_secret"] == "test-secret"
    assert result["authorized_devices"] == ["imei-1", "imei-2"]
    assert result["fetch_concurrency"] == 5


@pytest.mark.asyncio
async def test_update_bouncie_credentials_creates_new(bouncie_db) -> None:
    """update_bouncie_credentials should create credentials if they don't exist."""
    result = await update_bouncie_credentials(
        {
            "client_id": "new-client",
            "client_secret": "new-secret",
            "authorized_devices": "device-1,device-2",
        },
    )

    assert result is True

    creds = await BouncieCredentials.find_one(
        BouncieCredentials.id == "bouncie_credentials",
    )
    assert creds is not None
    assert creds.client_id == "new-client"
    assert creds.authorized_devices == ["device-1", "device-2"]


@pytest.mark.asyncio
async def test_update_bouncie_credentials_updates_existing(bouncie_db) -> None:
    """update_bouncie_credentials should update existing credentials."""
    existing = BouncieCredentials(
        id="bouncie_credentials",
        client_id="old-client",
        client_secret="old-secret",
    )
    await existing.insert()

    result = await update_bouncie_credentials(
        {
            "client_id": "updated-client",
            "fetch_concurrency": 20,
        },
    )

    assert result is True

    creds = await BouncieCredentials.find_one(
        BouncieCredentials.id == "bouncie_credentials",
    )
    assert creds.client_id == "updated-client"
    assert creds.client_secret == "old-secret"  # unchanged
    assert creds.fetch_concurrency == 20


@pytest.mark.asyncio
async def test_update_bouncie_credentials_sets_oauth_state(bouncie_db) -> None:
    """update_bouncie_credentials should store oauth state values."""
    result = await update_bouncie_credentials(
        {
            "oauth_state": "state123",
            "oauth_state_expires_at": 12345.0,
        },
    )

    assert result is True
    creds = await BouncieCredentials.find_one(
        BouncieCredentials.id == "bouncie_credentials",
    )
    assert creds.oauth_state == "state123"
    assert creds.oauth_state_expires_at == 12345.0


@pytest.mark.asyncio
async def test_update_bouncie_credentials_clamps_concurrency(bouncie_db) -> None:
    """update_bouncie_credentials should ignore out-of-range fetch_concurrency updates."""
    await update_bouncie_credentials({"fetch_concurrency": 100})

    creds = await BouncieCredentials.find_one(
        BouncieCredentials.id == "bouncie_credentials",
    )
    assert creds.fetch_concurrency == 12  # Should remain default

    await update_bouncie_credentials({"fetch_concurrency": 0})
    creds = await BouncieCredentials.find_one(
        BouncieCredentials.id == "bouncie_credentials",
    )
    assert creds.fetch_concurrency == 12  # Should remain default
