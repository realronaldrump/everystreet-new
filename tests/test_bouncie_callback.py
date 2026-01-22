"""Tests for the Bouncie OAuth callback and automatic vehicle sync."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import Request
from fastapi.responses import RedirectResponse

from setup.routes.bouncie import (
    _build_redirect_uri,
    _sync_vehicles_after_auth,
    bouncie_oauth_callback,
    initiate_bouncie_auth,
    BOUNCIE_AUTH_BASE,
    BouncieVehicleSyncError,
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


class TestBouncieAuthorize:
    """Tests for the OAuth authorization initiation."""

    @pytest.mark.asyncio
    async def test_authorize_generates_state(
        self,
        monkeypatch: pytest.MonkeyPatch,
        mock_request,
    ):
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "client_id": "client",
                    "client_secret": "secret",
                    "redirect_uri": "https://example.com/api/bouncie/callback",
                    "authorization_code": "",
                }
            ),
        )
        update = AsyncMock(return_value=True)
        monkeypatch.setattr("setup.routes.bouncie.update_bouncie_credentials", update)
        monkeypatch.setattr("setup.routes.bouncie._generate_oauth_state", lambda: "state123")

        response = await initiate_bouncie_auth(mock_request)

        assert isinstance(response, RedirectResponse)
        url = response.headers["location"]
        parsed = urlparse(url)
        assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == BOUNCIE_AUTH_BASE
        params = parse_qs(parsed.query)
        assert params["client_id"][0] == "client"
        assert params["redirect_uri"][0] == "https://example.com/api/bouncie/callback"
        assert params["response_type"][0] == "code"
        assert params["state"][0] == "state123"
        update.assert_awaited()

    @pytest.mark.asyncio
    async def test_authorize_skips_when_connected(
        self,
        monkeypatch: pytest.MonkeyPatch,
        mock_request,
    ):
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "client_id": "client",
                    "client_secret": "secret",
                    "redirect_uri": "https://example.com/api/bouncie/callback",
                    "authorization_code": "auth_code",
                    "authorized_devices": ["imei-1"],
                }
            ),
        )
        monkeypatch.setattr(
            "core.http.session.get_session",
            AsyncMock(return_value=AsyncMock()),
        )
        mock_oauth = MagicMock()
        mock_oauth.get_access_token = AsyncMock(return_value="token")
        monkeypatch.setattr("setup.services.bouncie_oauth.BouncieOAuth", mock_oauth)
        sync = AsyncMock(return_value=1)
        monkeypatch.setattr("setup.routes.bouncie._sync_vehicles_after_auth", sync)

        response = await initiate_bouncie_auth(mock_request)

        assert isinstance(response, RedirectResponse)
        assert "bouncie_connected=true" in response.headers["location"]
        assert "vehicles_synced=0" in response.headers["location"]
        sync.assert_not_called()


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
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "oauth_state": "state123",
                    "oauth_state_expires_at": time.time() + 300,
                }
            ),
        )

        response = await bouncie_oauth_callback(
            code="test_code",
            error=None,
            state="state123",
        )

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
                    "oauth_state": "state123",
                    "oauth_state_expires_at": time.time() + 300,
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

        response = await bouncie_oauth_callback(
            code="test_code",
            error=None,
            state="state123",
        )

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=token_exchange_failed" in response.headers["location"]

    @pytest.mark.asyncio
    async def test_callback_state_mismatch(self, monkeypatch: pytest.MonkeyPatch):
        """Test callback handling when state does not match."""
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "oauth_state": "state123",
                    "oauth_state_expires_at": time.time() + 300,
                }
            ),
        )

        response = await bouncie_oauth_callback(
            code="test_code",
            error=None,
            state="wrong_state",
        )

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=state_mismatch" in response.headers["location"]

    @pytest.mark.asyncio
    async def test_callback_missing_state(self, monkeypatch: pytest.MonkeyPatch):
        """Test callback handling when state is missing."""
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "oauth_state": "state123",
                    "oauth_state_expires_at": time.time() + 300,
                }
            ),
        )

        response = await bouncie_oauth_callback(
            code="test_code",
            error=None,
            state=None,
        )

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=missing_state" in response.headers["location"]

    @pytest.mark.asyncio
    async def test_callback_state_expired(self, monkeypatch: pytest.MonkeyPatch):
        """Test callback handling when state is expired."""
        monkeypatch.setattr(
            "setup.routes.bouncie.get_bouncie_credentials",
            AsyncMock(
                return_value={
                    "oauth_state": "state123",
                    "oauth_state_expires_at": time.time() - 10,
                }
            ),
        )

        response = await bouncie_oauth_callback(
            code="test_code",
            error=None,
            state="state123",
        )

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_error=state_expired" in response.headers["location"]

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
                    "oauth_state": "state123",
                    "oauth_state_expires_at": time.time() + 300,
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

        response = await bouncie_oauth_callback(
            code="test_code",
            error=None,
            state="state123",
        )

        assert isinstance(response, RedirectResponse)
        assert response.status_code == 302
        assert "bouncie_connected=true" in response.headers["location"]
        assert "vehicles_synced=2" in response.headers["location"]


class TestBouncieOAuthEndToEnd:
    """Mocked end-to-end OAuth flow."""

    @pytest.mark.asyncio
    async def test_end_to_end_oauth_flow(
        self,
        monkeypatch: pytest.MonkeyPatch,
        mock_request,
    ):
        store = {
            "client_id": "client",
            "client_secret": "secret",
            "redirect_uri": "https://example.com/api/bouncie/callback",
            "authorization_code": "",
            "authorized_devices": [],
            "oauth_state": None,
            "oauth_state_expires_at": None,
        }

        async def fake_get():
            return dict(store)

        async def fake_update(update_data):
            store.update(update_data)
            return True

        monkeypatch.setattr("setup.routes.bouncie.get_bouncie_credentials", fake_get)
        monkeypatch.setattr("setup.routes.bouncie.update_bouncie_credentials", fake_update)
        monkeypatch.setattr("setup.routes.bouncie._generate_oauth_state", lambda: "state123")
        monkeypatch.setattr(
            "core.http.session.get_session",
            AsyncMock(return_value=AsyncMock()),
        )
        mock_oauth = MagicMock()
        mock_oauth.get_access_token = AsyncMock(return_value="token")
        monkeypatch.setattr("setup.services.bouncie_oauth.BouncieOAuth", mock_oauth)
        monkeypatch.setattr(
            "setup.routes.bouncie._sync_vehicles_after_auth",
            AsyncMock(return_value=2),
        )

        auth_response = await initiate_bouncie_auth(mock_request)
        assert isinstance(auth_response, RedirectResponse)
        params = parse_qs(urlparse(auth_response.headers["location"]).query)
        state = params["state"][0]

        callback_response = await bouncie_oauth_callback(
            code="test_code",
            error=None,
            state=state,
        )

        assert isinstance(callback_response, RedirectResponse)
        assert "bouncie_connected=true" in callback_response.headers["location"]
        assert "vehicles_synced=2" in callback_response.headers["location"]
        assert store["authorization_code"] == "test_code"
        assert store["oauth_state"] is None

class TestSyncVehiclesAfterAuth:
    """Tests for the automatic vehicle sync."""

    @pytest.mark.asyncio
    async def test_sync_no_vehicles(self, monkeypatch: pytest.MonkeyPatch):
        """Test sync when no vehicles are returned."""
        monkeypatch.setattr(
            "setup.routes.bouncie.fetch_all_vehicles",
            AsyncMock(return_value=[]),
        )
        mock_session = MagicMock()

        count = await _sync_vehicles_after_auth(mock_session, "test_token")

        assert count == 0

    @pytest.mark.asyncio
    async def test_sync_api_error(self, monkeypatch: pytest.MonkeyPatch):
        """Test sync when API returns an error."""
        from setup.services.bouncie_api import BouncieUnauthorizedError

        monkeypatch.setattr(
            "setup.routes.bouncie.fetch_all_vehicles",
            AsyncMock(side_effect=BouncieUnauthorizedError("unauthorized", status=401)),
        )
        mock_session = MagicMock()

        with pytest.raises(BouncieVehicleSyncError):
            await _sync_vehicles_after_auth(mock_session, "test_token")

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

        monkeypatch.setattr(
            "setup.routes.bouncie.fetch_all_vehicles",
            AsyncMock(return_value=vehicles),
        )

        mock_session = MagicMock()

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
        monkeypatch.setattr(
            "setup.routes.bouncie.fetch_all_vehicles",
            AsyncMock(side_effect=Exception("Network error")),
        )
        mock_session = MagicMock()

        with pytest.raises(BouncieVehicleSyncError):
            await _sync_vehicles_after_auth(mock_session, "test_token")
