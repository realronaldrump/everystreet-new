import pytest
from db_helpers import init_mock_beanie
from network_blocker import install_network_blocker

from db.models import GasFillup, Trip, Vehicle


@pytest.fixture(autouse=True)
def _default_test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAPBOX_TOKEN", "pk.test-token-12345678901234567890")
    monkeypatch.setenv("OSM_DATA_PATH", "/data/osm/test.osm")
    install_network_blocker(monkeypatch)


@pytest.fixture
async def beanie_db():
    return await init_mock_beanie(Trip, GasFillup, Vehicle)
