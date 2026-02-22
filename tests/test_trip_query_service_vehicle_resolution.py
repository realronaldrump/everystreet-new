from trips.services.trip_query_service import (
    _is_preferred_vehicle_candidate,
    _normalize_identifier,
    _select_vehicle_for_trip,
)


def test_normalize_identifier_trims_and_handles_missing():
    assert _normalize_identifier(None) is None
    assert _normalize_identifier("") is None
    assert _normalize_identifier("  ") is None
    assert _normalize_identifier("  imei-123  ") == "imei-123"
    assert _normalize_identifier(123) == "123"


def test_select_vehicle_prefers_imei_when_vin_conflicts():
    vehicle_by_vin = {
        "VIN-CONFLICT": {
            "imei": "imei-other",
            "custom_name": "Wrong Vehicle",
        },
    }
    vehicle_by_imei = {
        "imei-expected": {
            "imei": "imei-expected",
            "custom_name": "Expected Vehicle",
        },
    }

    selected = _select_vehicle_for_trip(
        vin="VIN-CONFLICT",
        imei="imei-expected",
        vehicle_by_vin=vehicle_by_vin,
        vehicle_by_imei=vehicle_by_imei,
    )

    assert selected is not None
    assert selected.get("custom_name") == "Expected Vehicle"


def test_select_vehicle_accepts_matching_vin_and_imei():
    vehicle = {
        "imei": "imei-123",
        "vin": "VIN-123",
        "custom_name": "Same Vehicle",
    }
    selected = _select_vehicle_for_trip(
        vin="VIN-123",
        imei="imei-123",
        vehicle_by_vin={"VIN-123": vehicle},
        vehicle_by_imei={"imei-123": vehicle},
    )

    assert selected is vehicle


def test_vehicle_candidate_priority_prefers_active_then_recent():
    inactive_recent = {
        "is_active": False,
        "updated_at": "2026-02-20T12:00:00Z",
    }
    active_older = {
        "is_active": True,
        "updated_at": "2025-01-01T12:00:00Z",
    }
    active_newer = {
        "is_active": True,
        "updated_at": "2026-02-20T12:00:00Z",
    }

    assert _is_preferred_vehicle_candidate(active_older, inactive_recent)
    assert _is_preferred_vehicle_candidate(active_newer, active_older)

