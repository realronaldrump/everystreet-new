from __future__ import annotations

import asyncio
import shutil
import subprocess

import pytest
from shapely.geometry import box

from map_data.coverage import build_trip_coverage_extract_from_geometry

# A county boundary (relation 900) is a ring from node 1, inside the trip
# corridor, out through nodes 3, 7 and 4. Way 101 (with node 7) lies entirely
# outside the corridor, so only a strategy that completes boundary relations
# keeps it. A road (way 200) also lies entirely outside and must stay out.
_OSM_XML = """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="coverage-extract-regression">
<node id="1" version="1" lat="39.00" lon="-107.00"/>
<node id="3" version="1" lat="40.00" lon="-107.00"/>
<node id="7" version="1" lat="40.20" lon="-107.50"/>
<node id="4" version="1" lat="40.00" lon="-108.00"/>
<node id="5" version="1" lat="40.50" lon="-108.50"/>
<node id="6" version="1" lat="40.51" lon="-108.50"/>
<way id="100" version="1"><nd ref="1"/><nd ref="3"/></way>
<way id="101" version="1"><nd ref="3"/><nd ref="7"/><nd ref="4"/></way>
<way id="102" version="1"><nd ref="4"/><nd ref="1"/></way>
<way id="200" version="1"><nd ref="5"/><nd ref="6"/>
<tag k="highway" v="residential"/></way>
<relation id="900" version="1">
<member type="way" ref="100" role="outer"/>
<member type="way" ref="101" role="outer"/>
<member type="way" ref="102" role="outer"/>
<tag k="type" v="boundary"/><tag k="boundary" v="administrative"/>
<tag k="admin_level" v="6"/><tag k="name" v="Test County"/>
</relation>
</osm>"""


def test_trip_coverage_extract_keeps_touched_boundaries_whole(tmp_path):
    osmium = shutil.which("osmium")
    if not osmium:
        pytest.skip("CI provides osmium for the extract fixture")
    xml = tmp_path / "source.osm"
    xml.write_text(_OSM_XML)
    source = tmp_path / "source.osm.pbf"
    subprocess.run([osmium, "cat", str(xml), "-o", str(source)], check=True)

    corridor = box(-107.05, 38.95, -106.95, 39.05)
    output = asyncio.run(
        build_trip_coverage_extract_from_geometry(
            str(source),
            corridor,
            coverage_dir=str(tmp_path / "coverage"),
        ),
    )

    assert output is not None
    extracted = subprocess.run(
        [osmium, "cat", output, "-f", "opl"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    ids = {line.split(" ", 1)[0] for line in extracted.splitlines() if line}
    assert {"r900", "w100", "w101", "w102", "n7"} <= ids
    assert "w200" not in ids
    assert "n5" not in ids
