import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from db.models import AppSettings, BouncieCredentials
from map_data.models import MapServiceConfig
from setup.services import setup_service


@pytest.fixture
async def setup_db():
    client = AsyncMongoMockClient()
    await init_beanie(
        database=client["test_db"],
        document_models=[AppSettings, BouncieCredentials, MapServiceConfig],
    )
    return client


@pytest.fixture(autouse=True)
def _mock_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get_mapbox_token() -> str:
        return "pk.testtoken1234567890"

    def fake_validate_mapbox_token(_token: str) -> None:
        return None

    async def fake_bouncie_credentials():
        return {
            "client_id": "client",
            "client_secret": "secret",
            "redirect_uri": "https://example.com/callback",
            "authorized_devices": ["device-1"],
        }

    monkeypatch.setattr(setup_service, "get_mapbox_token", fake_get_mapbox_token)
    monkeypatch.setattr(
        setup_service,
        "validate_mapbox_token",
        fake_validate_mapbox_token,
    )
    monkeypatch.setattr(
        setup_service,
        "get_bouncie_credentials",
        fake_bouncie_credentials,
    )


@pytest.mark.asyncio
async def test_setup_status_requires_coverage(setup_db) -> None:
    map_config = await MapServiceConfig.get_or_create()
    map_config.status = MapServiceConfig.STATUS_NOT_CONFIGURED
    map_config.selected_states = []
    await map_config.save()

    status = await setup_service.get_setup_status()

    assert status["required_complete"] is False
    assert status["steps"]["coverage"]["complete"] is False


@pytest.mark.asyncio
async def test_setup_status_complete_when_ready(setup_db) -> None:
    map_config = await MapServiceConfig.get_or_create()
    map_config.status = MapServiceConfig.STATUS_READY
    map_config.selected_states = ["CA"]
    await map_config.save()

    status = await setup_service.get_setup_status()

    assert status["required_complete"] is True
    assert status["steps"]["coverage"]["complete"] is True
