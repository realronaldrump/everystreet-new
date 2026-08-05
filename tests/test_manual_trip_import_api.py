from __future__ import annotations

import json
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from trips.api import manual_import
from trips.services.manual_trip_import_service import MAX_IMPORT_BATCH_SIZE


class _FakeAnalysis:
    fingerprint = "reviewed-fingerprint"

    @staticmethod
    def to_payload() -> dict[str, object]:
        return {
            "fingerprint": "reviewed-fingerprint",
            "summary": {"importable": 1},
            "records": [],
        }


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(manual_import.router)
    return TestClient(app)


def test_preview_accepts_multipart_trip_files(monkeypatch) -> None:
    service = AsyncMock()
    service.analyze.return_value = _FakeAnalysis()
    monkeypatch.setattr(manual_import, "manual_import_service", service)

    response = _client().post(
        "/api/trips/manual-import/preview",
        files=[("files", ("trip.json", b"{}", "application/json"))],
    )

    assert response.status_code == 200
    assert response.json()["fingerprint"] == "reviewed-fingerprint"
    service.analyze.assert_awaited_once()


def test_commit_rejects_files_that_changed_after_review(monkeypatch) -> None:
    service = AsyncMock()
    service.analyze.return_value = _FakeAnalysis()
    monkeypatch.setattr(manual_import, "manual_import_service", service)

    response = _client().post(
        "/api/trips/manual-import/commit",
        files=[("files", ("trip.json", b"{}", "application/json"))],
        data={
            "fingerprint": "different-fingerprint",
            "selected_ids": json.dumps(["trip-1"]),
        },
    )

    assert response.status_code == 409
    service.import_selected.assert_not_awaited()


def test_commit_revalidates_and_imports_the_selected_batch(monkeypatch) -> None:
    service = AsyncMock()
    analysis = _FakeAnalysis()
    service.analyze.return_value = analysis
    service.import_selected.return_value = {
        "status": "success",
        "completed_ids": ["trip-1"],
        "failed_ids": [],
    }
    monkeypatch.setattr(manual_import, "manual_import_service", service)

    response = _client().post(
        "/api/trips/manual-import/commit",
        files=[("files", ("trip.json", b"{}", "application/json"))],
        data={
            "fingerprint": "reviewed-fingerprint",
            "selected_ids": json.dumps(["trip-1"]),
        },
    )

    assert response.status_code == 200
    assert response.json()["completed_ids"] == ["trip-1"]
    assert service.analyze.await_args.kwargs["requested_ids"] == {"trip-1"}
    service.import_selected.assert_awaited_once_with(analysis, ["trip-1"])


def test_commit_rejects_oversized_batches_before_scanning(monkeypatch) -> None:
    service = AsyncMock()
    monkeypatch.setattr(manual_import, "manual_import_service", service)

    response = _client().post(
        "/api/trips/manual-import/commit",
        files=[("files", ("trip.json", b"{}", "application/json"))],
        data={
            "fingerprint": "reviewed-fingerprint",
            "selected_ids": json.dumps(
                [f"trip-{index}" for index in range(MAX_IMPORT_BATCH_SIZE + 1)]
            ),
        },
    )

    assert response.status_code == 400
    service.analyze.assert_not_awaited()
