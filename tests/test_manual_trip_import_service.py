from __future__ import annotations

import io
import json
import zipfile
from unittest.mock import AsyncMock

import pytest

from db.models import Vehicle
from trips.services import manual_trip_import_service as import_module
from trips.services.manual_trip_import_service import (
    MAX_IMPORT_BATCH_SIZE,
    ManualTripImportError,
    ManualTripImportService,
    UploadedTripContainer,
)

IMEI = "359486068397551"


def _trip_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "transactionId": f"{IMEI}-1-1583369315000",
        "hardBrakingCount": 0,
        "hardAccelerationCount": 0,
        "distance": 1.0,
        "gps": {
            "type": "LineString",
            "coordinates": [[-107.0, 39.0], [-106.9815, 39.0]],
        },
        "startTime": "2020-03-05T00:48:35.000Z",
        "endTime": "2020-03-05T00:58:35.000Z",
        "startOdometer": 1000.0,
        "endOdometer": 1001.0,
        "averageSpeed": 20.0,
        "maxSpeed": 40.0,
        "fuelConsumed": 0.05,
        "totalIdleDuration": 0,
        "timeZone": "-0700",
        "imei": IMEI,
    }
    payload.update(overrides)
    return payload


def _json_container(
    payload: dict[str, object],
    *,
    name: str = "trip.json",
) -> UploadedTripContainer:
    return UploadedTripContainer(name=name, content=json.dumps(payload).encode())


def _zip_container(entries: dict[str, bytes]) -> UploadedTripContainer:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return UploadedTripContainer(name="trips.zip", content=buffer.getvalue())


def _service(
    *,
    existing: dict[str, str] | None = None,
    known_vehicle: bool = True,
) -> ManualTripImportService:
    service = ManualTripImportService()
    service._load_existing_sources = AsyncMock(return_value=existing or {})
    vehicles = (
        {IMEI: Vehicle(imei=IMEI, custom_name="Archive car")} if known_vehicle else {}
    )
    service._load_vehicles = AsyncMock(return_value=vehicles)
    return service


@pytest.mark.asyncio
async def test_preview_accepts_complete_bouncie_trip() -> None:
    analysis = await _service().analyze([_json_container(_trip_payload())])

    assert analysis.fingerprint
    assert analysis.json_files == 1
    assert analysis.records_found == 1
    assert len(analysis.records) == 1
    record = analysis.records[0]
    assert record.status == "ready"
    assert record.importable is True
    assert record.vehicle_label == "Archive car"
    assert record.point_count == 2
    assert record.distance == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_preview_accepts_bouncie_string_encoded_geojson() -> None:
    gps = json.dumps(
        {
            "type": "LineString",
            "coordinates": [[-107.0, 39.0], [-106.9815, 39.0]],
        },
    )

    analysis = await _service().analyze(
        [_json_container(_trip_payload(gps=gps))],
    )

    assert analysis.records[0].status == "ready"
    assert analysis.records[0].point_count == 2


@pytest.mark.asyncio
async def test_preview_accepts_bouncie_id_with_epoch_seconds_in_middle() -> None:
    analysis = await _service().analyze(
        [
            _json_container(
                _trip_payload(
                    transactionId=f"{IMEI}-1583369315-202005",
                ),
            ),
        ],
    )

    assert analysis.records[0].status == "ready"


@pytest.mark.asyncio
async def test_preview_surfaces_malformed_json_as_blocked_record() -> None:
    analysis = await _service().analyze(
        [UploadedTripContainer(name="broken.json", content=b'{"transactionId":')],
    )

    assert analysis.records[0].status == "invalid"
    assert analysis.records[0].issues[0].code == "invalid_json"


@pytest.mark.asyncio
async def test_preview_counts_only_adjacent_duplicate_points_as_normalized() -> None:
    payload = _trip_payload(
        gps={
            "type": "LineString",
            "coordinates": [
                [-107.0, 39.0],
                [-107.0, 39.0],
                [999, 39.0],
                [-106.9815, 39.0],
            ],
        },
    )

    analysis = await _service().analyze([_json_container(payload)])

    assert analysis.repeated_points_removed == 1
    assert analysis.records[0].status == "invalid"
    assert "malformed_coordinates" in {
        issue.code for issue in analysis.records[0].issues
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("overrides", "issue_code"),
    [
        ({"endTime": None}, "missing_end_time"),
        (
            {"gps": {"type": "LineString", "coordinates": []}},
            "missing_route_geometry",
        ),
        (
            {
                "startTime": "0001-05-21T20:16:56.000Z",
                "endTime": "0001-05-21T20:26:56.000Z",
            },
            "unsupported_trip_date",
        ),
        ({"distance": -1}, "negative_number"),
        ({"distance": 10**400}, "invalid_number"),
        ({"totalIdleDuration": 601}, "idle_exceeds_duration"),
        ({"timeZone": "\n"}, "invalid_timezone"),
        ({"averageSpeed": 50, "maxSpeed": 20}, "average_exceeds_maximum"),
    ],
)
async def test_preview_blocks_invalidating_trip_data(
    overrides: dict[str, object],
    issue_code: str,
) -> None:
    analysis = await _service().analyze([_json_container(_trip_payload(**overrides))])

    record = analysis.records[0]
    assert record.status == "invalid"
    assert issue_code in {issue.code for issue in record.issues}


@pytest.mark.asyncio
async def test_preview_warns_when_odometer_and_distance_disagree() -> None:
    analysis = await _service().analyze(
        [_json_container(_trip_payload(endOdometer=1010.0))],
    )

    record = analysis.records[0]
    assert record.status == "warning"
    assert "odometer_distance_mismatch" in {issue.code for issue in record.issues}


@pytest.mark.asyncio
async def test_preview_requires_imei_in_fleet_registry() -> None:
    analysis = await _service(known_vehicle=False).analyze(
        [_json_container(_trip_payload())],
    )

    record = analysis.records[0]
    assert record.status == "invalid"
    assert "unknown_imei" in {issue.code for issue in record.issues}


@pytest.mark.asyncio
async def test_preview_normalizes_identity_whitespace_with_warning() -> None:
    transaction_id = str(_trip_payload()["transactionId"])
    analysis = await _service().analyze(
        [
            _json_container(
                _trip_payload(
                    transactionId=f" {transaction_id} ",
                    imei=f" {IMEI} ",
                ),
            ),
        ],
    )

    record = analysis.records[0]
    assert record.status == "warning"
    assert record.payload["transactionId"] == transaction_id
    assert record.payload["imei"] == IMEI


@pytest.mark.asyncio
async def test_preview_strips_app_owned_fields_from_import_payload() -> None:
    analysis = await _service().analyze(
        [
            _json_container(
                _trip_payload(
                    source="live",
                    matchedGps={
                        "type": "LineString",
                        "coordinates": [[0, 0], [1, 1]],
                    },
                    inactive=True,
                    coverage_emitted_at="2020-03-05T00:58:35.000Z",
                ),
            ),
        ],
    )

    record = analysis.records[0]
    assert record.status == "warning"
    assert "unsupported_fields_ignored" in {issue.code for issue in record.issues}
    assert record.payload is not None
    assert "source" not in record.payload
    assert "matchedGps" not in record.payload
    assert "inactive" not in record.payload
    assert "coverage_emitted_at" not in record.payload


@pytest.mark.asyncio
async def test_existing_bouncie_trip_is_idempotently_excluded() -> None:
    transaction_id = str(_trip_payload()["transactionId"])
    analysis = await _service(existing={transaction_id: "bouncie"}).analyze(
        [_json_container(_trip_payload())],
    )

    record = analysis.records[0]
    assert record.status == "existing"
    assert record.importable is False
    assert "already_exists" in {issue.code for issue in record.issues}


@pytest.mark.asyncio
async def test_identical_duplicate_files_use_one_trip_with_warning() -> None:
    payload = _trip_payload()
    analysis = await _service().analyze(
        [
            _json_container(payload, name="first.json"),
            _json_container(payload, name="second.json"),
        ],
    )

    assert analysis.duplicate_copies == 1
    assert len(analysis.records) == 1
    assert analysis.records[0].status == "warning"
    assert "duplicate_copy" in {issue.code for issue in analysis.records[0].issues}


@pytest.mark.asyncio
async def test_conflicting_duplicate_transaction_ids_are_blocked() -> None:
    analysis = await _service().analyze(
        [
            _json_container(_trip_payload(), name="first.json"),
            _json_container(_trip_payload(distance=2.0), name="second.json"),
        ],
    )

    assert analysis.records[0].status == "invalid"
    assert "conflicting_duplicate" in {
        issue.code for issue in analysis.records[0].issues
    }


@pytest.mark.asyncio
async def test_zip_input_is_read_without_extracting_to_disk() -> None:
    payload = json.dumps(_trip_payload()).encode()
    analysis = await _service().analyze(
        [_zip_container({"nested/trip.json": payload})],
    )

    assert analysis.json_files == 1
    assert analysis.records[0].status == "ready"
    assert analysis.records[0].source_files == ["trips.zip:nested/trip.json"]


@pytest.mark.asyncio
async def test_zip_path_traversal_is_rejected() -> None:
    container = _zip_container({"../trip.json": json.dumps(_trip_payload()).encode()})

    with pytest.raises(ManualTripImportError, match="unsafe path"):
        await _service().analyze([container])


@pytest.mark.asyncio
async def test_multiple_archives_share_one_uncompressed_size_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(import_module, "MAX_ARCHIVE_UNCOMPRESSED_BYTES", 10)
    first = _zip_container({"first.json": b"{}" * 3})
    second = _zip_container({"second.json": b"{}" * 3})

    with pytest.raises(ManualTripImportError, match="total archive size limit"):
        await _service().analyze([first, second])


@pytest.mark.asyncio
async def test_selected_import_uses_bouncie_historical_pipeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _service()
    analysis = await service.analyze([_json_container(_trip_payload())])
    process = AsyncMock(
        return_value={
            "processed_transaction_ids": [analysis.records[0].transaction_id],
            "counters": {"inserted": 1},
        },
    )
    bump_revision = AsyncMock()
    monkeypatch.setattr(import_module, "process_bouncie_trips", process)
    monkeypatch.setattr(import_module, "bump_trip_map_revision", bump_revision)

    result = await service.import_selected(
        analysis,
        [str(analysis.records[0].transaction_id)],
    )

    assert result["status"] == "success"
    assert result["inserted"] == 1
    kwargs = process.await_args.kwargs
    assert kwargs["mode"] == "insert_only"
    assert kwargs["do_map_match"] is False
    assert kwargs["do_geocode"] is True
    assert kwargs["do_coverage"] is True
    assert kwargs["sync_mobility"] is True
    assert kwargs["bump_revision"] is False
    bump_revision.assert_awaited_once()


@pytest.mark.asyncio
async def test_selected_import_never_forwards_app_owned_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _service()
    analysis = await service.analyze(
        [
            _json_container(
                _trip_payload(
                    source="live",
                    matchedGps={
                        "type": "LineString",
                        "coordinates": [[0, 0], [1, 1]],
                    },
                    inactive=True,
                ),
            ),
        ],
    )
    process = AsyncMock(
        return_value={
            "processed_transaction_ids": [analysis.records[0].transaction_id],
            "counters": {"inserted": 1},
        },
    )
    monkeypatch.setattr(import_module, "process_bouncie_trips", process)
    monkeypatch.setattr(import_module, "bump_trip_map_revision", AsyncMock())

    await service.import_selected(
        analysis,
        [str(analysis.records[0].transaction_id)],
    )

    forwarded = process.await_args.args[0][0]
    assert "source" not in forwarded
    assert "matchedGps" not in forwarded
    assert "inactive" not in forwarded


@pytest.mark.asyncio
async def test_selected_existing_trip_is_successful_without_rewriting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transaction_id = str(_trip_payload()["transactionId"])
    service = _service(existing={transaction_id: "bouncie"})
    analysis = await service.analyze([_json_container(_trip_payload())])
    process = AsyncMock()
    monkeypatch.setattr(import_module, "process_bouncie_trips", process)

    result = await service.import_selected(analysis, [transaction_id])

    assert result["completed_ids"] == [transaction_id]
    assert result["already_present"] == 1
    process.assert_not_awaited()


@pytest.mark.asyncio
async def test_insert_race_is_resolved_as_idempotently_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transaction_id = str(_trip_payload()["transactionId"])
    service = _service()
    service._load_existing_sources = AsyncMock(
        side_effect=[{}, {transaction_id: "bouncie"}],
    )
    analysis = await service.analyze([_json_container(_trip_payload())])
    process = AsyncMock(
        return_value={
            "processed_transaction_ids": [],
            "counters": {"skipped_existing": 1},
        },
    )
    monkeypatch.setattr(import_module, "process_bouncie_trips", process)

    result = await service.import_selected(analysis, [transaction_id])

    assert result["status"] == "success"
    assert result["completed_ids"] == [transaction_id]
    assert result["already_present"] == 1


@pytest.mark.asyncio
async def test_import_enforces_small_request_batches() -> None:
    service = _service()
    analysis = await service.analyze([_json_container(_trip_payload())])

    with pytest.raises(ManualTripImportError, match="at most"):
        await service.import_selected(
            analysis,
            [f"trip-{index}" for index in range(MAX_IMPORT_BATCH_SIZE + 1)],
        )
