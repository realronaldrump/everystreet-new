import os
import unittest

import httpx
import pytest

pytestmark = pytest.mark.integration


class GeoIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        if not os.getenv("RUN_TAILNET_INTEGRATION"):
            self.skipTest("RUN_TAILNET_INTEGRATION not set")

    def test_valhalla_status(self) -> None:
        url = os.getenv("VALHALLA_STATUS_URL")
        if not url:
            self.skipTest("VALHALLA_STATUS_URL not set")
        response = httpx.get(url, timeout=10.0)
        assert response.status_code == 200

    def test_nominatim_search(self) -> None:
        url = os.getenv("NOMINATIM_SEARCH_URL")
        if not url:
            self.skipTest("NOMINATIM_SEARCH_URL not set")
        response = httpx.get(
            url,
            params={"q": "Waco, Texas", "format": "json", "limit": 1},
            headers={
                "User-Agent": os.getenv("NOMINATIM_USER_AGENT", "EveryStreet/1.0"),
            },
            timeout=10.0,
        )
        assert response.status_code == 200

    def test_nominatim_reverse(self) -> None:
        url = os.getenv("NOMINATIM_REVERSE_URL")
        if not url:
            self.skipTest("NOMINATIM_REVERSE_URL not set")
        response = httpx.get(
            url,
            params={
                "lat": 31.5493,
                "lon": -97.1467,
                "format": "json",
            },
            headers={
                "User-Agent": os.getenv("NOMINATIM_USER_AGENT", "EveryStreet/1.0"),
            },
            timeout=10.0,
        )
        assert response.status_code == 200
