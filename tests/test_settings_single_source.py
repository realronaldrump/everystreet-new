from __future__ import annotations

import os

import pytest
from db_helpers import init_mock_beanie

import config
from core import service_config
from core.settings_snapshot import (
    PUBLISHED_SETTING_NAMES,
    publish_user_settings,
    user_setting,
)
from db.models import AppSettings
from street_coverage.public_road_filter import get_include_service_roads

_ENV_VARS = (
    "NOMINATIM_USER_AGENT",
    "GEOFABRIK_MIRROR",
    "OSM_EXTRACTS_PATH",
    "COVERAGE_INCLUDE_SERVICE_ROADS",
    "COVERAGE_TRIP_MODE",
)


@pytest.fixture(autouse=True)
def clean_settings_state(monkeypatch: pytest.MonkeyPatch):
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    service_config.reset_service_config_state()
    yield
    service_config.reset_service_config_state()


@pytest.fixture
async def settings_db():
    return await init_mock_beanie(AppSettings, database_name="test_settings_db")


def test_stored_setting_is_used_when_no_environment_override() -> None:
    publish_user_settings({"osm_extracts_path": "/custom/osm"})
    assert config.get_osm_extracts_path() == "/custom/osm"


def test_environment_variable_wins_as_operator_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish_user_settings({"osm_extracts_path": "/custom/osm"})
    monkeypatch.setenv("OSM_EXTRACTS_PATH", "/operator/osm")
    assert config.get_osm_extracts_path() == "/operator/osm"


def test_falls_back_to_default_before_settings_are_loaded() -> None:
    assert config.get_osm_extracts_path() == config.DEFAULT_OSM_EXTRACTS_PATH
    assert config.get_geofabrik_mirror() == config.DEFAULT_GEOFABRIK_MIRROR
    assert config.get_nominatim_user_agent() == config.DEFAULT_NOMINATIM_USER_AGENT


def test_include_service_roads_reads_the_stored_setting() -> None:
    publish_user_settings({"coverageIncludeServiceRoads": False})
    assert get_include_service_roads() is False

    publish_user_settings({"coverageIncludeServiceRoads": True})
    assert get_include_service_roads() is True


def test_include_service_roads_environment_override_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publish_user_settings({"coverageIncludeServiceRoads": True})
    monkeypatch.setenv("COVERAGE_INCLUDE_SERVICE_ROADS", "false")
    assert get_include_service_roads() is False


@pytest.mark.asyncio
async def test_loading_settings_does_not_write_to_the_environment(
    settings_db,
) -> None:
    """The worker cannot be invalidated, so settings must not stick in env."""
    del settings_db
    await AppSettings(osm_extracts_path="/from/db").insert()

    await service_config.get_service_config()

    assert config.get_osm_extracts_path() == "/from/db"
    for name in _ENV_VARS:
        assert name not in os.environ


@pytest.mark.asyncio
async def test_cache_refetches_after_ttl_expires(
    settings_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del settings_db
    monkeypatch.setenv("SETTINGS_CACHE_TTL_SECONDS", "0")
    stored = AppSettings(osm_extracts_path="/first")
    await stored.insert()

    await service_config.get_service_config()
    assert user_setting("osm_extracts_path") == "/first"

    # Stand in for another process saving a change.
    stored.osm_extracts_path = "/second"
    await stored.save()

    await service_config.get_service_config()
    assert user_setting("osm_extracts_path") == "/second"


@pytest.mark.asyncio
async def test_cache_is_reused_within_the_ttl(
    settings_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del settings_db
    monkeypatch.setenv("SETTINGS_CACHE_TTL_SECONDS", "3600")
    stored = AppSettings(osm_extracts_path="/first")
    await stored.insert()

    await service_config.get_service_config()
    stored.osm_extracts_path = "/second"
    await stored.save()

    await service_config.get_service_config()
    assert user_setting("osm_extracts_path") == "/first"

    await service_config.get_service_config(force_refresh=True)
    assert user_setting("osm_extracts_path") == "/second"


def test_published_names_all_exist_on_the_settings_model() -> None:
    for name in PUBLISHED_SETTING_NAMES:
        assert name in AppSettings.model_fields
