import pytest

from bouncie_credentials import validate_bouncie_credentials


@pytest.mark.asyncio
async def test_validate_bouncie_credentials_missing_fields() -> None:
    ok, message = await validate_bouncie_credentials({})
    assert not ok
    assert message.startswith("Missing required field: ")


@pytest.mark.asyncio
async def test_validate_bouncie_credentials_requires_devices() -> None:
    ok, message = await validate_bouncie_credentials(
        {
            "client_id": "client",
            "client_secret": "secret",
            "redirect_uri": "https://example.com/callback",
            "authorized_devices": [],
        },
    )
    assert not ok
    assert message == "At least one authorized device (IMEI) is required"


@pytest.mark.asyncio
async def test_validate_bouncie_credentials_accepts_valid_payload() -> None:
    ok, message = await validate_bouncie_credentials(
        {
            "client_id": "client",
            "client_secret": "secret",
            "redirect_uri": "https://example.com/callback",
            "authorized_devices": ["111"],
        },
    )
    assert ok
    assert message == ""
