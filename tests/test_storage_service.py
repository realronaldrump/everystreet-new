from __future__ import annotations

from pathlib import Path

import pytest

from admin.services import admin_service, storage_service


async def _no_compose_project() -> None:
    return None


async def _compose_project() -> str:
    return "everystreet"


def _write_bytes(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


@pytest.mark.asyncio
async def test_get_storage_snapshot_includes_app_storage_sources(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)

    exports_path = tmp_path / "cache" / "exports" / "artifact.zip"
    graphs_path = tmp_path / "data" / "graphs" / "area.graphml"
    osm_root = tmp_path / "osm-data"
    osm_file = osm_root / "coverage" / "coverage.osm.pbf"

    _write_bytes(exports_path, 128)
    _write_bytes(graphs_path, 256)
    _write_bytes(osm_file, 512)

    monkeypatch.setenv("OSM_EXTRACTS_PATH", str(osm_root))
    monkeypatch.setattr(storage_service, "_infer_compose_project", _no_compose_project)

    async def _list_volumes(_filters: list[str]) -> tuple[list[str], str | None]:
        return [], None

    monkeypatch.setattr(storage_service, "_list_volumes", _list_volumes)

    snapshot = await storage_service.StorageService.get_storage_snapshot()
    source_by_id = {source["id"]: source for source in snapshot["sources"]}

    assert source_by_id["exports_cache"]["size_bytes"] == 128
    assert source_by_id["routing_graphs"]["size_bytes"] == 256
    assert source_by_id["osm_extracts_path"]["size_bytes"] == 512
    assert snapshot["total_bytes"] == 896


@pytest.mark.asyncio
async def test_get_storage_snapshot_uses_osm_volume_without_double_counting_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)

    osm_root = tmp_path / "osm-data"
    _write_bytes(osm_root / "coverage" / "coverage.osm.pbf", 1024)

    monkeypatch.setenv("OSM_EXTRACTS_PATH", str(osm_root))
    monkeypatch.setattr(storage_service, "_infer_compose_project", _compose_project)

    async def _list_volumes(filters: list[str]) -> tuple[list[str], str | None]:
        joined = " ".join(filters)
        if "com.docker.compose.project=everystreet" in joined:
            return ["everystreet_osm_extracts"], None
        return [], None

    async def _get_volume_sizes() -> tuple[dict[str, int], str | None]:
        return {}, None

    async def _inspect_volume(
        _name: str,
    ) -> tuple[dict[str, object] | None, str | None]:
        return (
            {
                "Labels": {
                    "com.docker.compose.volume": "osm_extracts",
                    "com.docker.compose.project": "everystreet",
                },
                "UsageData": {"Size": 2048},
            },
            None,
        )

    monkeypatch.setattr(storage_service, "_list_volumes", _list_volumes)
    monkeypatch.setattr(storage_service, "_get_volume_sizes", _get_volume_sizes)
    monkeypatch.setattr(storage_service, "_inspect_volume", _inspect_volume)

    snapshot = await storage_service.StorageService.get_storage_snapshot()
    source_ids = {source["id"] for source in snapshot["sources"]}
    source_by_id = {source["id"]: source for source in snapshot["sources"]}

    assert "osm_extracts_path" not in source_ids
    assert source_by_id["osm_extracts"]["size_bytes"] == 2048
    assert snapshot["total_bytes"] == 2048


@pytest.mark.asyncio
async def test_list_volumes_passes_timeout_seconds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_kwargs: dict[str, object] = {}

    async def _fake_run_docker(_cmd: list[str], **kwargs: object):
        captured_kwargs.update(kwargs)
        return 0, "", ""

    monkeypatch.setattr(storage_service, "run_docker", _fake_run_docker)

    await storage_service._list_volumes([])

    assert captured_kwargs.get("timeout_seconds") == storage_service._DOCKER_TIMEOUT
    assert "timeout" not in captured_kwargs


@pytest.mark.asyncio
async def test_get_storage_info_adds_mongodb_logical_source_without_mongo_volume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _snapshot() -> dict[str, object]:
        return {
            "total_bytes": 384,
            "total_mb": 0.0,
            "updated_at": "2026-03-02T12:00:00+00:00",
            "sources": [
                {"id": "mongo_data", "size_bytes": None},
                {"id": "exports_cache", "size_bytes": 128},
                {"id": "routing_graphs", "size_bytes": 256},
            ],
        }

    class _FakeDB:
        async def command(self, _command: str) -> dict[str, int]:
            return {"storageSize": 1000, "indexSize": 500}

    class _FakeDBManager:
        db = _FakeDB()

    monkeypatch.setattr(admin_service.StorageService, "get_storage_snapshot", _snapshot)
    monkeypatch.setattr(admin_service, "db_manager", _FakeDBManager())

    result = await admin_service.AdminService.get_storage_info()
    source_by_id = {source["id"]: source for source in result["sources"]}

    assert result["database_logical_bytes"] == 1500
    assert result["total_bytes"] == 1884
    assert source_by_id["mongodb_logical"]["size_bytes"] == 1500


@pytest.mark.asyncio
async def test_get_storage_info_skips_mongodb_logical_when_mongo_volume_known(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _snapshot() -> dict[str, object]:
        return {
            "total_bytes": 4096,
            "total_mb": 0.0,
            "updated_at": "2026-03-02T12:00:00+00:00",
            "sources": [
                {"id": "mongo_data", "size_bytes": 3072},
                {"id": "exports_cache", "size_bytes": 1024},
            ],
        }

    class _FakeDB:
        async def command(self, _command: str) -> dict[str, int]:
            return {"storageSize": 1000, "indexSize": 500}

    class _FakeDBManager:
        db = _FakeDB()

    monkeypatch.setattr(admin_service.StorageService, "get_storage_snapshot", _snapshot)
    monkeypatch.setattr(admin_service, "db_manager", _FakeDBManager())

    result = await admin_service.AdminService.get_storage_info()
    source_ids = {source["id"] for source in result["sources"]}

    assert result["database_logical_bytes"] == 1500
    assert result["total_bytes"] == 4096
    assert "mongodb_logical" not in source_ids
