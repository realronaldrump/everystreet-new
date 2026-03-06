from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import status as status_api


def test_liveness_probe_returns_ok() -> None:
    app = FastAPI()
    app.include_router(status_api.router)
    client = TestClient(app)

    response = client.get("/api/status/live")

    assert response.status_code == 200
    assert response.json() == {"ok": True}
