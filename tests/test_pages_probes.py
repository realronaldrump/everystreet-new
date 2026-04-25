from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import pages as pages_api


def test_root_head_probe_returns_ok_without_body() -> None:
    app = FastAPI()
    app.include_router(pages_api.router)
    client = TestClient(app)

    response = client.head("/")

    assert response.status_code == 200
    assert response.content == b""
