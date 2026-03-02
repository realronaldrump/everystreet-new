"""Seed city and state boundary data for unified geo coverage."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import geopandas as gpd
import pandas as pd
from dotenv import load_dotenv
from shapely.geometry import mapping

# Load env vars first.
load_dotenv()

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.manager import db_manager
from db.models import CityBoundary, StateBoundaryCache

logger = logging.getLogger("seed_geo_coverage_boundaries")

try:
    from shapely.validation import make_valid as _make_valid
except Exception:
    try:
        from shapely import make_valid as _make_valid
    except Exception:
        _make_valid = None

DEFAULT_CENSUS_YEAR = os.getenv("GEO_COVERAGE_CENSUS_YEAR", "2024")
DEFAULT_STATES_URL = os.getenv(
    "GEO_COVERAGE_STATES_URL",
    f"https://www2.census.gov/geo/tiger/GENZ{DEFAULT_CENSUS_YEAR}/shp/cb_{DEFAULT_CENSUS_YEAR}_us_state_500k.zip",
)
DEFAULT_PLACES_URL = os.getenv(
    "GEO_COVERAGE_PLACES_URL",
    f"https://www2.census.gov/geo/tiger/GENZ{DEFAULT_CENSUS_YEAR}/shp/cb_{DEFAULT_CENSUS_YEAR}_us_place_500k.zip",
)
DEFAULT_PLACE_PER_STATE_URL_TEMPLATE = os.getenv(
    "GEO_COVERAGE_PLACES_URL_TEMPLATE",
    f"https://www2.census.gov/geo/tiger/GENZ{DEFAULT_CENSUS_YEAR}/shp/cb_{DEFAULT_CENSUS_YEAR}_{{state_fips}}_place_500k.zip",
)
DEFAULT_SIMPLIFY_TOLERANCE = float(os.getenv("GEO_COVERAGE_SIMPLIFY_TOLERANCE", "0.01"))


def _normalize_geometry(geom):
    if geom is None or geom.is_empty:
        return None
    if geom.is_valid:
        return geom
    fixed = _make_valid(geom) if _make_valid else geom.buffer(0)
    if fixed is None or fixed.is_empty or not fixed.is_valid:
        return None
    return fixed


def _is_included_place(classfp: str | None) -> bool:
    if not classfp:
        return False
    normalized = str(classfp).strip().upper()
    # Census place classes:
    # C* = incorporated place variants, U* = CDP variants.
    return normalized.startswith("C") or normalized.startswith("U")


def _territory_code_from_state_abbr(state_abbr: str | None) -> str | None:
    if not state_abbr:
        return None
    normalized = str(state_abbr).strip().upper()
    if normalized in {"AS", "GU", "MP", "PR", "VI"}:
        return normalized
    return None


def _to_wgs84(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if gdf.crs is None:
        return gdf.set_crs(epsg=4326)
    if gdf.crs.to_epsg() == 4326:
        return gdf
    return gdf.to_crs(epsg=4326)


async def _upsert_state_boundaries(
    *,
    states_gdf: gpd.GeoDataFrame,
    source: str,
    simplify_tolerance: float,
) -> None:
    features = []

    for _, row in states_gdf.iterrows():
        geom = _normalize_geometry(row.geometry)
        if geom is None:
            continue

        if simplify_tolerance > 0:
            simplified = geom.simplify(simplify_tolerance, preserve_topology=True)
            normalized = _normalize_geometry(simplified)
            geom = normalized or geom

        state_fips = str(row.get("STATEFP") or "").zfill(2)
        state_name = str(row.get("NAME") or "Unknown")
        state_abbr = str(row.get("STUSPS") or "")

        features.append(
            {
                "type": "Feature",
                "id": state_fips,
                "properties": {
                    "stateFips": state_fips,
                    "name": state_name,
                    "abbr": state_abbr,
                },
                "geometry": mapping(geom),
            }
        )

    cache = await StateBoundaryCache.get("states_boundaries")
    if cache:
        cache.source = source
        cache.feature_collection = {"type": "FeatureCollection", "features": features}
        cache.updated_at = datetime.now(UTC)
        await cache.save()
    else:
        await StateBoundaryCache(
            source=source,
            feature_collection={"type": "FeatureCollection", "features": features},
            updated_at=datetime.now(UTC),
        ).insert()

    logger.info("Upserted state boundary cache with %d features", len(features))


async def _upsert_city_boundaries(
    *,
    places_gdf: gpd.GeoDataFrame,
    state_name_by_fips: dict[str, str],
    state_abbr_by_fips: dict[str, str],
    source: str,
    simplify_tolerance: float,
) -> dict[str, int]:
    per_state_counts: dict[str, int] = {}
    upserted = 0
    skipped = 0

    for _, row in places_gdf.iterrows():
        classfp = str(row.get("CLASSFP") or "")
        if not _is_included_place(classfp):
            skipped += 1
            continue

        city_id = str(row.get("GEOID") or "").strip()
        state_fips = str(row.get("STATEFP") or "").zfill(2)
        city_name = str(row.get("NAME") or "").strip()

        if not city_id or not state_fips or not city_name:
            skipped += 1
            continue

        geom = _normalize_geometry(row.geometry)
        if geom is None:
            skipped += 1
            continue

        if simplify_tolerance > 0:
            simplified = geom.simplify(simplify_tolerance, preserve_topology=True)
            normalized = _normalize_geometry(simplified)
            geom = normalized or geom

        try:
            centroid = geom.centroid
            centroid_coords = [float(centroid.x), float(centroid.y)]
            min_x, min_y, max_x, max_y = geom.bounds
            bbox = [float(min_x), float(min_y), float(max_x), float(max_y)]
        except Exception:
            skipped += 1
            continue

        state_name = state_name_by_fips.get(state_fips)
        state_abbr = state_abbr_by_fips.get(state_fips)

        existing = await CityBoundary.get(city_id)
        if existing:
            existing.name = city_name
            existing.state_fips = state_fips
            existing.state_name = state_name
            existing.territory_code = _territory_code_from_state_abbr(state_abbr)
            existing.classfp = classfp
            existing.centroid = centroid_coords
            existing.bbox = bbox
            existing.geometry = mapping(geom)
            existing.source = source
            existing.updated_at = datetime.now(UTC)
            await existing.save()
        else:
            await CityBoundary(
                id=city_id,
                name=city_name,
                state_fips=state_fips,
                state_name=state_name,
                territory_code=_territory_code_from_state_abbr(state_abbr),
                classfp=classfp,
                centroid=centroid_coords,
                bbox=bbox,
                geometry=mapping(geom),
                source=source,
                updated_at=datetime.now(UTC),
            ).insert()

        upserted += 1
        per_state_counts[state_fips] = per_state_counts.get(state_fips, 0) + 1

    logger.info("Upserted %d city boundaries (%d skipped)", upserted, skipped)
    return per_state_counts


def _load_places_gdf(
    *,
    places_url: str,
    per_state_template: str,
    state_fips_values: list[str],
) -> tuple[gpd.GeoDataFrame, str]:
    try:
        gdf = gpd.read_file(places_url)
        return gdf, places_url
    except Exception as exc:
        logger.warning(
            "Failed to load national places URL %s (%s). Falling back to per-state downloads.",
            places_url,
            exc,
        )

    frames = []
    loaded_urls = []
    for state_fips in state_fips_values:
        url = per_state_template.format(state_fips=state_fips)
        try:
            frame = gpd.read_file(url)
            frames.append(frame)
            loaded_urls.append(url)
        except Exception as exc:
            logger.warning("Skipping state %s place file %s (%s)", state_fips, url, exc)

    if not frames:
        msg = "Unable to load any place boundary datasets"
        raise RuntimeError(msg)

    combined = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)
    return combined, ",".join(loaded_urls)


async def seed_boundaries(
    *,
    states_url: str,
    places_url: str,
    per_state_template: str,
    simplify_tolerance: float,
) -> None:
    logger.info("Loading states dataset: %s", states_url)
    states_gdf = _to_wgs84(gpd.read_file(states_url))

    required_state_cols = {"STATEFP", "STUSPS", "NAME"}
    missing_state_cols = required_state_cols - set(states_gdf.columns)
    if missing_state_cols:
        msg = f"States dataset missing required columns: {sorted(missing_state_cols)}"
        raise RuntimeError(msg)

    state_fips_values = sorted({str(value).zfill(2) for value in states_gdf["STATEFP"].tolist()})

    logger.info("Loading places dataset")
    raw_places_gdf, places_source = _load_places_gdf(
        places_url=places_url,
        per_state_template=per_state_template,
        state_fips_values=state_fips_values,
    )
    places_gdf = _to_wgs84(raw_places_gdf)

    required_place_cols = {"GEOID", "STATEFP", "NAME", "CLASSFP"}
    missing_place_cols = required_place_cols - set(places_gdf.columns)
    if missing_place_cols:
        msg = f"Places dataset missing required columns: {sorted(missing_place_cols)}"
        raise RuntimeError(msg)

    state_name_by_fips = {
        str(row["STATEFP"]).zfill(2): str(row["NAME"]) for _, row in states_gdf.iterrows()
    }
    state_abbr_by_fips = {
        str(row["STATEFP"]).zfill(2): str(row["STUSPS"]) for _, row in states_gdf.iterrows()
    }

    await _upsert_state_boundaries(
        states_gdf=states_gdf,
        source=states_url,
        simplify_tolerance=simplify_tolerance,
    )

    counts = await _upsert_city_boundaries(
        places_gdf=places_gdf,
        state_name_by_fips=state_name_by_fips,
        state_abbr_by_fips=state_abbr_by_fips,
        source=places_source,
        simplify_tolerance=simplify_tolerance,
    )

    logger.info("City boundary counts by state:")
    for state_fips in sorted(counts):
        logger.info("  %s: %d", state_fips, counts[state_fips])


async def main_async(args: argparse.Namespace) -> None:
    await db_manager.init_beanie()
    await seed_boundaries(
        states_url=args.states_url,
        places_url=args.places_url,
        per_state_template=args.places_per_state_template,
        simplify_tolerance=args.simplify_tolerance,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--states-url", default=DEFAULT_STATES_URL)
    parser.add_argument("--places-url", default=DEFAULT_PLACES_URL)
    parser.add_argument(
        "--places-per-state-template",
        default=DEFAULT_PLACE_PER_STATE_URL_TEMPLATE,
        help="Template used when national places URL is unavailable; supports {state_fips}.",
    )
    parser.add_argument("--simplify-tolerance", type=float, default=DEFAULT_SIMPLIFY_TOLERANCE)
    return parser.parse_args()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
    )
    args = parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
