import geopandas as gpd
import networkx as nx
from pyrosm import OSM
from shapely.geometry import LineString, Point
from street_coverage.preprocessing import _try_pyrosm_to_graph


def test_pyrosm_conversion_creates_legal_reverse_edges_and_keeps_oneway():
    nodes = gpd.GeoDataFrame(
        {"id": [1, 2, 3], "lon": [-107, -106.999, -106.998], "lat": [39, 39, 39]},
        geometry=[Point(-107, 39), Point(-106.999, 39), Point(-106.998, 39)],
        crs="EPSG:4326",
    )
    edges = gpd.GeoDataFrame(
        {
            "id": [10, 11],
            "u": [1, 2],
            "v": [2, 3],
            "oneway": ["no", "yes"],
            "highway": ["residential", "residential"],
            "length": [86.6, 86.6],
        },
        geometry=[
            LineString([(-107, 39), (-106.999, 39)]),
            LineString([(-106.999, 39), (-106.998, 39)]),
        ],
        crs="EPSG:4326",
    )
    graph = _try_pyrosm_to_graph(OSM, nodes, edges)
    assert isinstance(graph, nx.MultiDiGraph)
    assert graph.has_edge(1, 2) and graph.has_edge(2, 1)
    assert graph.has_edge(2, 3) and not graph.has_edge(3, 2)
