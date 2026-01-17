import importlib.util
import sys
from pathlib import Path

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

ROOT = Path(__file__).resolve().parents[1]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


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

from db.models import Trip  # noqa: E402


@pytest.fixture(autouse=True)
def _default_test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAPBOX_TOKEN", "pk.test-token-12345678901234567890")
    monkeypatch.setenv("VALHALLA_BASE_URL", "http://valhalla.test")
    monkeypatch.setenv("VALHALLA_STATUS_URL", "http://valhalla.test/status")
    monkeypatch.setenv("VALHALLA_ROUTE_URL", "http://valhalla.test/route")
    monkeypatch.setenv("VALHALLA_TRACE_ROUTE_URL", "http://valhalla.test/trace_route")
    monkeypatch.setenv(
        "VALHALLA_TRACE_ATTRIBUTES_URL",
        "http://valhalla.test/trace_attributes",
    )
    monkeypatch.setenv("NOMINATIM_BASE_URL", "http://nominatim.test")
    monkeypatch.setenv("NOMINATIM_SEARCH_URL", "http://nominatim.test/search")
    monkeypatch.setenv("NOMINATIM_REVERSE_URL", "http://nominatim.test/reverse")
    monkeypatch.setenv("NOMINATIM_USER_AGENT", "EveryStreet/1.0 (test)")


@pytest.fixture
async def beanie_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(database=database, document_models=[Trip])
    return database
