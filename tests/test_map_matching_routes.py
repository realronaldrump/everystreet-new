from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from map_matching.routes import router as map_matching_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(map_matching_router)
    return app


def test_create_map_matching_job() -> None:
    app = _create_app()

    with patch(
        "map_matching.routes.service.enqueue_job",
        new=AsyncMock(return_value={"status": "queued", "job_id": "job-1"}),
    ):
        client = TestClient(app)
        response = client.post("/api/map_matching/jobs", json={"mode": "unmatched"})

    assert response.status_code == 200
    assert response.json()["job_id"] == "job-1"


def test_get_map_matching_job() -> None:
    app = _create_app()

    with patch(
        "map_matching.routes.service.get_job",
        new=AsyncMock(return_value={"job_id": "job-2", "stage": "running"}),
    ):
        client = TestClient(app)
        response = client.get("/api/map_matching/jobs/job-2")

    assert response.status_code == 200
    assert response.json()["job_id"] == "job-2"


def test_list_map_matching_jobs() -> None:
    app = _create_app()

    with patch(
        "map_matching.routes.service.list_jobs",
        new=AsyncMock(return_value={"total": 1, "jobs": []}),
    ):
        client = TestClient(app)
        response = client.get("/api/map_matching/jobs")

    assert response.status_code == 200
    assert response.json()["total"] == 1
