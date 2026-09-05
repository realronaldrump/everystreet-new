import geopandas as gpd
import networkx as nx
from pyrosm import OSM
from shapely.geometry import LineString, Point
from street_coverage.preprocessing import _try_pyrosm_to_graph


def test_missing_osm_names_do_not_become_named_streets():
    from street_coverage.ingestion import _coerce_name

    assert _coerce_name(float("nan")) is None
    assert _coerce_name([float("nan"), None, " Main Street "]) == "Main Street"
    assert _coerce_name("  ") is None


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


def test_real_pbf_pipeline_preserves_parallel_edges_access_and_graphml(tmp_path):
    import shutil
    import subprocess

    import pytest
    from shapely.geometry import box
    from core.osmnx_graphml import load_graphml_robust
    from street_coverage.preprocessing import _build_graph_in_process

    osmium = shutil.which("osmium")
    if not osmium:
        pytest.skip("CI provides osmium for the PBF conversion fixture")
    xml = tmp_path / "streets.osm"
    xml.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="coverage-regression">
<node id="1" version="1" lat="39" lon="-107"/>
<node id="2" version="1" lat="39" lon="-106.999"/>
<node id="3" version="1" lat="39" lon="-106.998"/>
<node id="4" version="1" lat="39.001" lon="-106.999"/>
<node id="5" version="1" lat="39" lon="-106.997"/>
<node id="6" version="1" lat="39.002" lon="-107"/>
<node id="7" version="1" lat="39.002" lon="-106.999"/>
<way id="10" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/>
<tag k="highway" v="residential"/><tag k="name" v="Main"/><tag k="oneway" v="no"/></way>
<way id="11" version="1"><nd ref="1"/><nd ref="4"/><nd ref="3"/>
<tag k="highway" v="residential"/><tag k="name" v="Parallel"/><tag k="oneway" v="no"/></way>
<way id="12" version="1"><nd ref="3"/><nd ref="5"/>
<tag k="highway" v="residential"/><tag k="oneway" v="yes"/></way>
<way id="13" version="1"><nd ref="6"/><nd ref="7"/>
<tag k="highway" v="residential"/><tag k="access" v="private"/><tag k="motorcar" v="yes"/></way>
</osm>""")
    pbf = tmp_path / "streets.osm.pbf"
    subprocess.run([osmium, "cat", str(xml), "-o", str(pbf)], check=True)
    path = tmp_path / "streets.graphml"
    _build_graph_in_process(pbf, box(-107.1, 38.9, -106.9, 39.1), path, None)
    graph = load_graphml_robust(path)
    assert graph.graph["simplified"]
    assert graph.number_of_edges(1, 3) == graph.number_of_edges(3, 1) == 2
    assert graph.has_edge(3, 5) and not graph.has_edge(5, 3)
    assert graph.has_edge(6, 7) and graph.has_edge(7, 6)
    assert not graph.has_node(2) and not graph.has_node(4)
    assert all(data.get("name") != "nan" for _, _, data in graph.edges(data=True))
    assert "name" not in next(iter(graph.get_edge_data(3, 5).values()))
