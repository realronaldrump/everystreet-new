"""Exercise saved street-filter settings across the real process boundary."""

import json
from pathlib import Path

import pytest
from shapely.geometry import box

from core.osmnx_graphml import load_graphml_robust
from core.settings_snapshot import clear_user_settings, publish_user_settings
from street_coverage.preprocessing import _build_graph_in_subprocess
from street_coverage.public_road_filter import (
    GRAPH_ROAD_FILTER_SIGNATURE_KEY,
    GRAPH_ROAD_FILTER_STATS_KEY,
    get_public_road_filter_signature,
)


@pytest.mark.parametrize(
    ("saved_include", "environment_override", "expected_include"),
    [
        (False, None, False),
        (True, None, True),
        (False, "true", True),
        (True, "false", False),
    ],
)
def test_spawned_graph_builder_honors_service_policy(
    tmp_path, monkeypatch, saved_include, environment_override, expected_include
):
    monkeypatch.delenv("COVERAGE_INCLUDE_SERVICE_ROADS", raising=False)
    if environment_override is not None:
        monkeypatch.setenv("COVERAGE_INCLUDE_SERVICE_ROADS", environment_override)
    publish_user_settings({"coverageIncludeServiceRoads": saved_include})
    try:
        expected_signature = get_public_road_filter_signature()
        fixture = Path(__file__).parent / "fixtures" / "sample.osm"
        osm_path = tmp_path / "service-roads.osm"
        osm_path.write_text(
            fixture.read_text().replace(
                "</osm>",
                """<node id="23" lat="31.5510" lon="-97.1460" />
<node id="24" lat="31.5510" lon="-97.1450" />
<way id="1200"><nd ref="23"/><nd ref="24"/>
<tag k="highway" v="service"/><tag k="name" v="Public Service Road"/></way>
</osm>""",
            )
        )
        graph_path = tmp_path / "streets.graphml"
        # Zero disables resource limits, not spawning: use the actual worker and
        # XML reader, classifier, simplification, and GraphML publication path.
        _build_graph_in_subprocess(
            osm_path, box(-97.15, 31.54, -97.14, 31.56), graph_path, 0, None
        )
        graph = load_graphml_robust(graph_path)
        names = {data.get("name") for _, _, data in graph.edges(data=True)}
        assert ("Public Service Road" in names) is expected_include
        assert "Driveable Way" in names
        assert "Parking Aisle" not in names
        assert "Service Alley" not in names
        assert "Private Road" not in names
        assert graph.graph[GRAPH_ROAD_FILTER_SIGNATURE_KEY] == expected_signature
        audit = json.loads(graph.graph[GRAPH_ROAD_FILTER_STATS_KEY])
        assert audit["road_filter_signature"] == expected_signature
        reason = (
            "exclude_service_subtype" if expected_include else "exclude_service_policy"
        )
        assert audit["excluded_by_reason"][reason] > 0
    finally:
        clear_user_settings()


async def test_ingestion_reloads_saved_policy_before_loading_graph(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock

    from db_helpers import init_mock_beanie

    from core import service_config
    from db.models import AppSettings, CoverageArea, Job
    from street_coverage import ingestion
    from street_coverage.public_road_filter import get_include_service_roads

    await init_mock_beanie(CoverageArea, Job)
    monkeypatch.delenv("COVERAGE_INCLUDE_SERVICE_ROADS", raising=False)
    service_config.reset_service_config_state()
    try:
        saved = AppSettings(coverageIncludeServiceRoads=True)
        await saved.insert()
        await service_config.get_service_config()
        # Simulate a different web process saving the new preference while the
        # coverage worker still holds the previous setting in its cache.
        await saved.set({"coverageIncludeServiceRoads": False})
        assert get_include_service_roads() is True
        area = CoverageArea(
            display_name="Saved policy regression",
            boundary={
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            },
            bounding_box=[0, 0, 1, 1],
        )
        await area.insert()
        job = Job(job_type="area_ingestion", area_id=area.id)
        await job.insert()
        observed = []

        async def stop_at_graph(*_args):
            observed.append(get_include_service_roads())
            raise asyncio.CancelledError

        monkeypatch.setattr(
            ingestion,
            "_load_osm_streets_from_graph",
            AsyncMock(side_effect=stop_at_graph),
        )
        # An explicit trip mode must not bypass loading the street-filter setting.
        await ingestion._run_ingestion_pipeline(area.id, job.id, trip_mode="both")
        assert observed == [False]
    finally:
        service_config.reset_service_config_state()
