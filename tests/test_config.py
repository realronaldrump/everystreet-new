import os
import unittest
from unittest.mock import patch

import pytest

import config


class ValhallaConfigTests(unittest.TestCase):
    def test_require_valhalla_route_url_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            assert config.require_valhalla_route_url() == "http://valhalla:8002/route"

    def test_require_valhalla_route_url_ignores_env(self) -> None:
        with patch.dict(
            os.environ,
            {"VALHALLA_ROUTE_URL": "http://100.108.79.105:8004/route"},
            clear=True,
        ):
            assert config.require_valhalla_route_url() == "http://valhalla:8002/route"

    def test_require_valhalla_trace_route_url_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            assert (
                config.require_valhalla_trace_route_url()
                == "http://valhalla:8002/trace_route"
            )


class NominatimConfigTests(unittest.TestCase):
    def test_require_nominatim_user_agent_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            assert config.require_nominatim_user_agent() == "EveryStreet/1.0"

    def test_require_nominatim_user_agent_present(self) -> None:
        with patch.dict(
            os.environ,
            {"NOMINATIM_USER_AGENT": "EveryStreet/1.0"},
            clear=True,
        ):
            assert config.require_nominatim_user_agent() == "EveryStreet/1.0"


class MapboxConfigTests(unittest.TestCase):
    def test_validate_mapbox_token_requires_prefix(self) -> None:
        with pytest.raises(RuntimeError):
            config.validate_mapbox_token("sk.invalid")

    def test_validate_mapbox_token_requires_length(self) -> None:
        with pytest.raises(RuntimeError):
            config.validate_mapbox_token("pk.short")

    def test_validate_mapbox_token_requires_hardcoded_value(self) -> None:
        with pytest.raises(RuntimeError):
            config.validate_mapbox_token("pk.test-token-12345678901234567890")

    def test_require_mapbox_token_returns_hardcoded_token(self) -> None:
        with patch.dict(
            os.environ,
            {"MAPBOX_TOKEN": "pk.other-token-12345678901234567890"},
            clear=True,
        ):
            assert config.require_mapbox_token() == config.MAPBOX_PUBLIC_ACCESS_TOKEN


class OsmDataPathTests(unittest.TestCase):
    def test_require_osm_data_path_missing(self) -> None:
        with patch.dict(os.environ, {}, clear=True), pytest.raises(RuntimeError):
            config.require_osm_data_path()

    def test_require_osm_data_path_present(self) -> None:
        with patch.dict(
            os.environ,
            {"OSM_DATA_PATH": "/data/osm/test.osm"},
            clear=True,
        ):
            assert config.require_osm_data_path() == "/data/osm/test.osm"


if __name__ == "__main__":
    unittest.main()
