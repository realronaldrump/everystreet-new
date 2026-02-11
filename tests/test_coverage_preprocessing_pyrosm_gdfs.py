import pandas as pd

from street_coverage.preprocessing import _normalize_pyrosm_gdfs


def test_normalize_pyrosm_gdfs_makes_unique_indexes() -> None:
    # Nodes have duplicate ids (common in some pyrosm outputs) and only lon/lat.
    nodes = pd.DataFrame(
        {
            "id": [1, 1, 2],
            "lon": [-97.0, -97.0, -96.9],
            "lat": [31.5, 31.5, 31.6],
        }
    )

    # Edges have parallel edges between the same nodes but no `key` column.
    edges = pd.DataFrame(
        {
            "u": [1, 1, 1],
            "v": [2, 2, 2],
            "highway": ["residential", "residential", "service"],
        }
    )

    norm_nodes, norm_edges = _normalize_pyrosm_gdfs(nodes, edges)

    assert norm_nodes.index.name == "osmid"
    assert norm_nodes.index.is_unique
    assert {"x", "y"}.issubset(norm_nodes.columns)

    assert isinstance(norm_edges.index, pd.MultiIndex)
    assert list(norm_edges.index.names) == ["u", "v", "key"]
    assert norm_edges.index.is_unique
    # Parallel edges should be preserved by generating distinct keys.
    assert len(norm_edges) == len(edges)
