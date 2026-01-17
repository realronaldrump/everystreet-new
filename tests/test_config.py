import os
import unittest
from unittest.mock import patch

import pytest

import config


class ValhallaConfigTests(unittest.TestCase):
    def test_require_valhalla_route_url_missing(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(RuntimeError):
                config.require_valhalla_route_url()

    def test_require_valhalla_route_url_present(self) -> None:
        with patch.dict(
            os.environ,
            {"VALHALLA_ROUTE_URL": "http://100.108.79.105:8004/route"},
            clear=True,
        ):
            assert (
                config.require_valhalla_route_url()
                == "http://100.108.79.105:8004/route"
            )


class NominatimConfigTests(unittest.TestCase):
    def test_require_nominatim_user_agent_missing(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(RuntimeError):
                config.require_nominatim_user_agent()

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

    def test_require_mapbox_token_reads_env(self) -> None:
        with patch.dict(
            os.environ,
            {"MAPBOX_TOKEN": "pk.test-token-12345678901234567890"},
            clear=True,
        ):
            assert config.require_mapbox_token() == "pk.test-token-12345678901234567890"


if __name__ == "__main__":
    unittest.main()
