from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from core.static_files import (
    IMMUTABLE,
    REVALIDATE,
    CacheControlStaticFiles,
    versioned_cache_control,
)


def test_current_build_assets_are_immutable() -> None:
    assert versioned_cache_control("3361", "3361") == IMMUTABLE


def test_other_or_unknown_versions_revalidate() -> None:
    assert versioned_cache_control("3360", "3361") == REVALIDATE
    assert versioned_cache_control("Unknown", "Unknown") == REVALIDATE
    assert versioned_cache_control("", "") == REVALIDATE


def test_unversioned_scripts_revalidate(tmp_path: Path) -> None:
    (tmp_path / "app.js").write_text("export {};")
    (tmp_path / "car.webp").write_bytes(b"RIFF")
    app = FastAPI()
    files = CacheControlStaticFiles(directory=tmp_path)
    app.mount("/static", files, name="static")

    @app.get("/static-v/{version}/{path:path}")
    async def versioned(version: str, path: str, request: Request):
        response = await files.get_response(path, request.scope)
        response.headers["Cache-Control"] = versioned_cache_control(version, "7")
        return response

    client = TestClient(app)
    assert client.get("/static/app.js").headers["cache-control"] == REVALIDATE
    assert "cache-control" not in client.get("/static/car.webp").headers
    assert client.get("/static-v/7/app.js").headers["cache-control"] == IMMUTABLE
    assert client.get("/static-v/6/app.js").headers["cache-control"] == REVALIDATE
