from __future__ import annotations

import pytest

from routing.gaps import fill_route_gaps
from routing.graph_connectivity import BridgeRoute


@pytest.mark.asyncio
async def test_fill_route_gaps_inserts_bridge_coords_and_reports_stats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Two gaps of ~0.01 degrees lat (~0.69 miles) each, above the 1000ft threshold.
    route_coords = [[0.0, 0.0], [0.0, 0.01], [0.0, 0.02]]

    async def fake_fetch_bridge_route(from_xy, to_xy, request_timeout: float = 30.0):
        fx, fy = from_xy
        tx, ty = to_xy
        mid = [float((fx + tx) / 2.0), float((fy + ty) / 2.0)]
        return BridgeRoute(
            coordinates=[[fx, fy], mid, [tx, ty]],
            distance_m=2000.0,
            duration_s=120.0,
        )

    # fill_route_gaps imports fetch_bridge_route from routing.graph_connectivity at runtime.
    monkeypatch.setattr(
        "routing.graph_connectivity.fetch_bridge_route",
        fake_fetch_bridge_route,
    )

    filled, stats = await fill_route_gaps(route_coords, max_gap_ft=1000.0)

    assert stats.gaps_found == 2
    assert stats.gaps_filled == 2
    assert stats.gaps_unfilled == 0
    assert stats.bridge_distance_m == pytest.approx(4000.0)
    assert stats.bridge_duration_s == pytest.approx(240.0)
    # One insert point per gap: 3 original points + 2 inserts.
    assert len(filled) == 5
    assert filled[0] == [0.0, 0.0]
    assert filled[-1] == [0.0, 0.02]
