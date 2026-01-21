import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np
import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient
from network_blocker import install_network_blocker


# pytest-cov imports the coverage library; load the app's package for app imports.
def _install_local_coverage_package() -> None:
    coverage_init = ROOT / "coverage" / "__init__.py"
    if not coverage_init.exists():
        return

    coverage_py = sys.modules.get("coverage")
    if coverage_py is not None:
        sys.modules["coverage_py"] = coverage_py

    spec = importlib.util.spec_from_file_location(
        "coverage",
        coverage_init,
        submodule_search_locations=[str(ROOT / "coverage")],
    )
    if not spec or not spec.loader:
        return

    module = importlib.util.module_from_spec(spec)
    sys.modules["coverage"] = module
    spec.loader.exec_module(module)


_install_local_coverage_package()

_ = np

from db.models import Trip  # noqa: E402


@pytest.fixture(autouse=True)
def _default_test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAPBOX_TOKEN", "pk.test-token-12345678901234567890")
    monkeypatch.setenv("OSM_DATA_PATH", "/data/osm/test.osm")
    install_network_blocker(monkeypatch)


@pytest.fixture
async def beanie_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(database=database, document_models=[Trip])
    return database
