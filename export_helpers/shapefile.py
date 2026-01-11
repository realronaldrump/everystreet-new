"""
Shapefile export utilities.

Provides functions to convert GeoJSON data to shapefile format for export.
"""

import io
import logging
import os
import tempfile
import zipfile
from typing import Any

import geopandas as gpd

logger = logging.getLogger(__name__)


async def create_shapefile(
    geojson_data: dict[str, Any],
    output_name: str,
) -> io.BytesIO:
    """
    Convert GeoJSON data to a shapefile ZIP archive.

    Args:
        geojson_data: GeoJSON data dictionary
        output_name: Base name for the output files

    Returns:
        io.BytesIO: Buffer containing the zipped shapefile
    """
    try:
        gdf = gpd.GeoDataFrame.from_features(geojson_data["features"])

        with tempfile.TemporaryDirectory() as tmp_dir:
            out_path = os.path.join(tmp_dir, f"{output_name}.shp")
            gdf.to_file(out_path, driver="ESRI Shapefile")

            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in os.listdir(tmp_dir):
                    with open(os.path.join(tmp_dir, f), "rb") as fh:
                        zf.writestr(f"{output_name}/{f}", fh.read())

            buf.seek(0)
            return buf
    except Exception as e:
        logger.exception("Error creating shapefile: %s", e)
        raise
