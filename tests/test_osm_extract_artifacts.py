from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from db_helpers import init_mock_beanie

import map_data.services as map_services
import tasks.map_data as map_data_tasks
from db.models import CoverageArea, Job, Street
from map_data.extracts import build_local_osm_artifact_status, describe_osm_extract
from map_data.models import GeoServiceHealth, MapServiceConfig
from map_data.progress import MapBuildProgress


@pytest.fixture
async def extract_db():
    return await init_mock_beanie(
        MapServiceConfig,
        GeoServiceHealth,
        Job,
        CoverageArea,
        Street,
    )


@pytest.mark.asyncio
async def test_local_osm_artifact_status_marks_mixed_extracts_stale(
    extract_db,
    tmp_path: Path,
) -> None:
    _ = extract_db
    pbf_path = tmp_path / "coverage.osm.pbf"
    pbf_path.write_bytes(b"osm")
    metadata = describe_osm_extract(pbf_path)

    config = await MapServiceConfig.get_or_create()
    config.status = MapServiceConfig.STATUS_READY
    config.active_extract_id = metadata["id"]
    config.active_extract_algorithm = metadata["algorithm"]
    config.active_extract_path = metadata["path"]
    config.active_extract_size_bytes = metadata["size_bytes"]
    config.active_extract_mtime_ns = metadata["mtime_ns"]
    config.active_extract_mtime = datetime.fromtimestamp(
        metadata["mtime_ns"] / 1_000_000_000,
        UTC,
    )
    config.nominatim_extract_id = metadata["id"]
    config.valhalla_extract_id = "old-extract"
    config.geocoding_ready = True
    config.routing_ready = True
    await config.save()

    health = await GeoServiceHealth.get_or_create()
    health.nominatim_has_data = True
    health.valhalla_has_data = True
    await health.save()

    graph_path = tmp_path / "area.graphml"
    graph_path.write_text("<graphml />", encoding="utf-8")
    area = CoverageArea(
        display_name="Test Area",
        status="ready",
        health="healthy",
        graph_extract_id=metadata["id"],
        graph_path=str(graph_path),
        osm_extract_id=metadata["id"],
        coverage_backfill_extract_id="old-extract",
        last_synced=datetime.now(UTC),
    )
    await area.insert()

    await Street(
        segment_id=f"{area.id}-{area.area_version}-0",
        area_id=area.id,
        area_version=area.area_version,
        geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        osm_extract_id=metadata["id"],
    ).insert()

    status = await build_local_osm_artifact_status(
        config=config,
        health=health,
        is_building=False,
    )

    artifacts = {artifact["key"]: artifact for artifact in status["artifacts"]}
    assert status["status"] == "stale"
    assert artifacts["nominatim"]["status"] == "current"
    assert artifacts["valhalla"]["status"] == "stale"
    assert artifacts["graphml"]["status"] == "current"
    assert artifacts["streets"]["status"] == "current"
    assert artifacts["backfill"]["status"] == "stale"
    assert status["coverage"]["areas_needing_rebuild_count"] == 1


@pytest.mark.asyncio
async def test_local_osm_artifact_status_ignores_empty_coverage_inventory(
    extract_db,
    tmp_path: Path,
) -> None:
    _ = extract_db
    pbf_path = tmp_path / "coverage.osm.pbf"
    pbf_path.write_bytes(b"osm")
    metadata = describe_osm_extract(pbf_path)

    config = await MapServiceConfig.get_or_create()
    config.status = MapServiceConfig.STATUS_READY
    config.active_extract_id = metadata["id"]
    config.active_extract_algorithm = metadata["algorithm"]
    config.active_extract_path = metadata["path"]
    config.active_extract_size_bytes = metadata["size_bytes"]
    config.active_extract_mtime_ns = metadata["mtime_ns"]
    config.active_extract_mtime = datetime.fromtimestamp(
        metadata["mtime_ns"] / 1_000_000_000,
        UTC,
    )
    config.nominatim_extract_id = metadata["id"]
    config.valhalla_extract_id = metadata["id"]
    config.geocoding_ready = True
    config.routing_ready = True
    await config.save()

    health = await GeoServiceHealth.get_or_create()
    health.nominatim_has_data = True
    health.valhalla_has_data = True
    await health.save()

    status = await build_local_osm_artifact_status(
        config=config,
        health=health,
        is_building=False,
    )

    artifacts = {artifact["key"]: artifact for artifact in status["artifacts"]}
    assert status["status"] == "current"
    assert status["stale_artifact_count"] == 0
    assert artifacts["nominatim"]["status"] == "current"
    assert artifacts["valhalla"]["status"] == "current"
    assert artifacts["graphml"]["status"] == "not_applicable"
    assert artifacts["streets"]["status"] == "not_applicable"
    assert artifacts["backfill"]["status"] == "not_applicable"


@pytest.mark.asyncio
async def test_cancel_map_setup_clears_pending_extract(
    extract_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = extract_db
    config = await MapServiceConfig.get_or_create()
    config.status = MapServiceConfig.STATUS_BUILDING
    config.pending_extract_id = "osm-pending"
    config.pending_extract_path = "/tmp/pending.osm.pbf"
    config.pending_extract_started_at = datetime.now(UTC)
    await config.save()

    progress = await MapBuildProgress.get_or_create()
    progress.active_job_id = None
    await progress.save()

    async def fake_status(*, force_refresh: bool = False) -> dict:
        _ = force_refresh
        refreshed = await MapServiceConfig.get_or_create()
        return {
            "status": refreshed.status,
            "pending_extract_id": refreshed.pending_extract_id,
            "pending_extract_path": refreshed.pending_extract_path,
        }

    monkeypatch.setattr(map_services, "_cleanup_map_setup_artifacts", dict)
    monkeypatch.setattr(map_services, "get_map_services_status", fake_status)

    result = await map_services.cancel_map_setup()
    refreshed = await MapServiceConfig.get_or_create()

    assert result["status"] == MapServiceConfig.STATUS_NOT_CONFIGURED
    assert result["pending_extract_id"] is None
    assert refreshed.pending_extract_id is None
    assert refreshed.pending_extract_path is None
    assert refreshed.pending_extract_started_at is None


@pytest.mark.asyncio
async def test_stalled_map_setup_clears_pending_extract(extract_db) -> None:
    _ = extract_db
    now = datetime.now(UTC)

    config = await MapServiceConfig.get_or_create()
    config.status = MapServiceConfig.STATUS_BUILDING
    config.pending_extract_id = "osm-pending"
    config.pending_extract_path = "/tmp/pending.osm.pbf"
    config.pending_extract_started_at = now - timedelta(minutes=30)
    await config.save()

    progress = await MapBuildProgress.get_or_create()
    progress.active_job_id = None
    progress.started_at = now - timedelta(minutes=30)
    progress.last_progress_at = now - timedelta(minutes=30)
    await progress.save()

    result = await map_data_tasks._monitor_map_services_logic()
    refreshed = await MapServiceConfig.get_or_create()

    assert result["restarted"] is True
    assert refreshed.status == MapServiceConfig.STATUS_ERROR
    assert refreshed.pending_extract_id is None
    assert refreshed.pending_extract_path is None
    assert refreshed.pending_extract_started_at is None
