from pathlib import Path

import pytest
from shapely.geometry import box

import street_coverage.preprocessing as preprocess_module


def test_extract_required_without_osmium(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_path = tmp_path / "large.osm.pbf"
    source_path.write_bytes(b"0" * (2 * 1024 * 1024))

    monkeypatch.setenv("OSM_AREA_EXTRACT_THRESHOLD_MB", "1")
    monkeypatch.setenv("OSM_AREA_EXTRACT_REQUIRED", "1")
    monkeypatch.setenv("OSM_EXTRACTS_PATH", str(tmp_path))

    def fake_run(*_args, **_kwargs):
        raise FileNotFoundError

    monkeypatch.setattr(preprocess_module.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as exc:
        preprocess_module._maybe_extract_area_pbf(
            source_path,
            box(0, 0, 1, 1),
            "loc",
            require_extract=True,
            threshold_mb=1,
        )

    assert "osmium" in str(exc.value).lower()


def test_build_graph_with_limit_uses_subprocess(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = {"value": False}

    def fake_subprocess(_osm_path, _routing_polygon, _graph_path, _max_mb) -> None:
        called["value"] = True

    monkeypatch.setattr(
        preprocess_module,
        "_build_graph_in_subprocess",
        fake_subprocess,
    )

    preprocess_module._build_graph_with_limit(
        Path("dummy.osm"),
        box(0, 0, 1, 1),
        Path("dummy.graphml"),
        max_mb=1,
    )

    assert called["value"] is True
