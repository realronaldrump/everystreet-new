"""Tests for the Bouncie OAuth callback and automatic vehicle sync."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import Request
from fastapi.responses import RedirectResponse

from setup.routes.bouncie import (
    _build_redirect_uri,
    _sync_vehicles_after_auth,
    bouncie_oauth_callback,
)


@pytest.fixture
def mock_request():
    """Create a mock FastAPI request."""
    request = MagicMock(spec=Request)
    request.url.scheme = "https"
    request.url.netloc = "example.com"
    request.headers = {}
    return request


@pytest.fixture
def mock_request_with_proxy():
    """Create a mock request behind a reverse proxy."""
    request = MagicMock(spec=Request)
    request.url.scheme = "http"
    request.url.netloc = "localhost:8000"
    request.headers = {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "myapp.example.com",
    }
    return request


class TestBuildRedirectUri:
    """Tests for _build_redirect_uri helper."""

    def test_direct_request(self, mock_request):
        """Test redirect URI building for direct requests."""
        uri = _build_redirect_uri(mock_request)
        assert uri == "https://example.com/api/bouncie/callback"

    def test_proxied_request(self, mock_request_with_proxy):
        """Test redirect URI building for proxied requests."""
        uri = _build_redirect_uri(mock_request_with_proxy)
        assert uri == "https://myapp.example.com/api/bouncie/callback"


class TestBouncieOAuthCallback:
    """Tests for the OAuth callback handler."""

    @pytest.mark.asyncio
    async def test_callback_with_error(self):
        """Test callback handling when OAuth returns an error."""
        response = await bouncie_oauth_callback(code=None, error="access_denied")

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=access_denied" in response.headers["location"]

    @pytest.mark.asyncio
    async def test_callback_missing_code(self):
        """Test callback handling when code is missing."""
        response = await bouncie_oauth_callback(code=None, error=None)

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=missing_code" in response.headers["location"]

    @pytest.mark.asyncio
    async def test_callback_storage_failure(self, monkeypatch: pytest.MonkeyPatch):
        """Test callback handling when credential storage fails."""
        monkeypatch.setattr(
            "setup.routes.bouncie.update_bouncie_credentials",
            AsyncMock(return_value=False),
        )

        response = await bouncie_oauth_callback(code="test_code", error=None)

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=storage_failed" in response.headers["location"]

    @pytest.mark.asyncio
    async def test_callback_token_exchange_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Test callback handling when token exchange fails."""
        monkeypatch.setattr(
            "setup.routes.bouncie.update_bouncie_credentials",
            AsyncMock(return_value=True),
        )
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "client_id": "test",
                    "client_secret": "secret",
                    "redirect_uri": "http://test/callback",
                    "authorization_code": "test_code",
                }
            ),
        )

        mock_session = AsyncMock()
        monkeypatch.setattr(
            "core.http.session.get_session", AsyncMock(return_value=mock_session)
        )

        # Mock BouncieOAuth to return None (failure)
        mock_oauth = MagicMock()
        mock_oauth.get_access_token = AsyncMock(return_value=None)
        monkeypatch.setattr("setup.services.bouncie_oauth.BouncieOAuth", mock_oauth)

        response = await bouncie_oauth_callback(code="test_code", error=None)

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=" in response.headers["location"]
        assert "access%20token" in response.headers["location"].lower()

    @pytest.mark.asyncio
    async def test_callback_success_with_vehicles(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Test successful callback with automatic vehicle sync."""
        monkeypatch.setattr(
            "setup.routes.bouncie.update_bouncie_credentials",
            AsyncMock(return_value=True),
        )
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "client_id": "test",
                    "client_secret": "secret",
                    "redirect_uri": "http://test/callback",
                    "authorization_code": "test_code",
                }
            ),
        )

        mock_session = AsyncMock()
        monkeypatch.setattr(
            "core.http.session.get_session", AsyncMock(return_value=mock_session)
        )

        # Mock BouncieOAuth to return a token
        mock_oauth = MagicMock()
        mock_oauth.get_access_token = AsyncMock(return_value="test_token")
        monkeypatch.setattr("setup.services.bouncie_oauth.BouncieOAuth", mock_oauth)

        # Mock vehicle sync to return 2 vehicles
        monkeypatch.setattr(
            "setup.routes.bouncie._sync_vehicles_after_auth",
            AsyncMock(return_value=2),
        )

        response = await bouncie_oauth_callback(code="test_code", error=None)

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_connected=true" in response.headers["location"]
        assert "vehicles_synced=2" in response.headers["location"]


class TestSyncVehiclesAfterAuth:
    """Tests for the automatic vehicle sync."""

    @pytest.mark.asyncio
    async def test_sync_no_vehicles(self, monkeypatch: pytest.MonkeyPatch):
        """Test sync when no vehicles are returned."""
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=[])
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.get = MagicMock(return_value=mock_response)

        count = await _sync_vehicles_after_auth(mock_session, "test_token")

        assert count == 0

    @pytest.mark.asyncio
    async def test_sync_api_error(self, monkeypatch: pytest.MonkeyPatch):
        """Test sync when API returns an error."""
        mock_response = AsyncMock()
        mock_response.status = 401
        mock_response.text = AsyncMock(return_value="unauthorized")
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.get = MagicMock(return_value=mock_response)

        count = await _sync_vehicles_after_auth(mock_session, "test_token")

        assert count == 0

    @pytest.mark.asyncio
    async def test_sync_with_vehicles(self, monkeypatch: pytest.MonkeyPatch):
        """Test successful sync with vehicles."""
        vehicles = [
            {
                "imei": "123456789012345",
                "vin": "ABC123",
                "model": {"make": "Toyota", "name": "Camry", "year": 2022},
                "nickName": "My Car",
            },
            {
                "imei": "987654321098765",
                "vin": "XYZ789",
                "model": {"make": "Honda", "name": "Civic", "year": 2023},
            },
        ]

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=vehicles)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.get = MagicMock(return_value=mock_response)

        # Mock Vehicle model
        mock_vehicle_class = MagicMock()
        mock_vehicle_class.find_one = AsyncMock(return_value=None)
        mock_vehicle_instance = MagicMock()
        mock_vehicle_instance.insert = AsyncMock()
        mock_vehicle_class.return_value = mock_vehicle_instance

        monkeypatch.setattr(
            "db.models.Vehicle",
            mock_vehicle_class,
        )

        monkeypatch.setattr(
            "setup.routes.bouncie.update_bouncie_credentials",
            AsyncMock(return_value=True),
        )

        count = await _sync_vehicles_after_auth(mock_session, "test_token")

        assert count == 2

    @pytest.mark.asyncio
    async def test_sync_exception_handling(self, monkeypatch: pytest.MonkeyPatch):
        """Test that sync handles exceptions gracefully."""
        mock_session = MagicMock()
        mock_session.get = MagicMock(side_effect=Exception("Network error"))

        count = await _sync_vehicles_after_auth(mock_session, "test_token")

        assert count == 0  # Should not crash, just return 0
