"""Inspect deployed coverage; back up scoped data before a requested recalculation.

Run only from the deployed image: python -m street_coverage.maintenance.
The default operation is read-only. Recalculation uses the normal sequential job
service and never changes Historical Trips.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import math
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path

from beanie import PydanticObjectId, init_beanie
from bson import BSON, json_util

from db.manager import db_manager
from db.models import (
    ALL_DOCUMENT_MODELS,
    CoverageArea,
    CoverageDriveEvent,
    CoverageGoal,
    CoverageJournalEntry,
    CoverageJournalRollup,
    CoverageMission,
    CoverageOverride,
    CoverageState,
    CoverageStatusEvent,
    GeneratedRoute,
    Street,
)
from routing.constants import GRAPH_STORAGE_DIR
from street_coverage.intervals import covered_fraction
from street_coverage.matching import MATCHING_VERSION
from street_coverage.stats import calculate_area_stats

BACKUP_MODELS = (
    CoverageArea,
    Street,
    CoverageState,
    CoverageDriveEvent,
    CoverageOverride,
    CoverageStatusEvent,
    CoverageJournalEntry,
    CoverageJournalRollup,
    CoverageGoal,
    CoverageMission,
    GeneratedRoute,
)


async def audit_area(area):
    """Compare independent state totals, interval math, and the published journal."""
    totals = await calculate_area_stats(area.id)
    errors = []
    for key, value in totals.items():
        actual = getattr(area, key)
        if isinstance(value, float):
            same = math.isclose(actual, value, rel_tol=1e-9, abs_tol=1e-8)
        else:
            same = actual == value
        if not same:
            errors.append(f"{key}: cached={actual}, derived={value}")
    streets = await Street.find(
        {"area_id": area.id, "area_version": area.area_version}
    ).to_list()
    lengths = {street.segment_id: street.length_miles for street in streets}
    bad_states = 0
    for state in await CoverageState.find({"area_id": area.id}).to_list():
        fraction = covered_fraction(state.intervals)
        bad_states += int(
            state.segment_id not in lengths
            or not math.isclose(state.coverage_fraction, fraction, abs_tol=1e-9)
            or not math.isclose(
                state.covered_length_miles,
                lengths.get(state.segment_id, 0) * fraction,
                abs_tol=1e-8,
            )
            or (state.status == "driven" and fraction < 1 - 1e-9)
            or (state.status == "undriveable" and fraction != 0)
        )
    if bad_states:
        errors.append(f"{bad_states} states violate interval or inventory invariants")
    if area.coverage_matching_version != MATCHING_VERSION:
        errors.append(
            "Historical coverage needs recalculation with the current matcher"
        )
    rollup = await CoverageJournalRollup.find_one(
        {"area_id": area.id, "area_version": area.area_version}
    )
    journal_miles = None
    if rollup:
        rows = await CoverageJournalEntry.find(
            {
                "area_id": area.id,
                "area_version": area.area_version,
                "revision": rollup.revision,
                "kind": "contribution",
            }
        ).to_list()
        journal_miles = math.fsum(row.data["new_miles"] for row in rows)
        if not math.isclose(journal_miles, totals["driven_length_miles"], abs_tol=1e-8):
            errors.append("Journal gains disagree with covered mileage")
    if rollup is None or rollup.revision != area.journal_revision:
        errors.append("Journal publication is pending")
    latest = await CoverageArea.get(area.id)
    if (
        latest.area_version != area.area_version
        or latest.journal_revision != area.journal_revision
    ):
        errors.append("Coverage changed during this read; repeat the audit")
    return {
        "area_id": str(area.id),
        "display_name": area.display_name,
        "area_version": area.area_version,
        "coverage_revision": area.journal_revision,
        "status": area.status,
        "matching_version": area.coverage_matching_version,
        "metrics": totals,
        "journal_miles": journal_miles,
        "consistent": not errors,
        "errors": errors,
    }


async def backup_areas(areas, directory: Path):
    """Snapshot only coverage-owned collections; write restricted BSON archives."""
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    ids = [area.id for area in areas]
    client = CoverageArea.get_pymongo_collection().database.client
    manifest = {
        "created_at": datetime.now(UTC).isoformat(),
        "area_ids": [str(value) for value in ids],
        "collections": {},
        "graphs": [],
    }
    async with client.start_session(snapshot=True) as session:
        for model in BACKUP_MODELS:
            collection = model.get_pymongo_collection()
            query = {"_id" if model is CoverageArea else "area_id": {"$in": ids}}
            target = directory / f"{collection.name}.bson.gz"
            count, digest = 0, hashlib.sha256()
            with gzip.open(target, "wb") as stream:
                async for document in collection.find(query, session=session):
                    payload = BSON.encode(document)
                    stream.write(payload)
                    digest.update(payload)
                    count += 1
            target.chmod(0o600)
            manifest["collections"][collection.name] = {
                "documents": count,
                "sha256_uncompressed": digest.hexdigest(),
            }
    for area in areas:
        if area.graph_path and Path(area.graph_path).is_file():
            target = directory / f"{area.id}-{area.area_version}.graphml"
            shutil.copyfile(area.graph_path, target)
            target.chmod(0o600)
            manifest["graphs"].append(target.name)
    path = directory / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    path.chmod(0o600)
    return path


async def run(args):
    await init_beanie(
        database=db_manager.db, document_models=ALL_DOCUMENT_MODELS, skip_indexes=True
    )
    query = (
        {"_id": {"$in": [PydanticObjectId(value) for value in args.area_id]}}
        if args.area_id
        else {}
    )
    areas = await CoverageArea.find(query).sort("display_name").to_list()
    if args.area_id and len(areas) != len(set(args.area_id)):
        raise ValueError("One or more selected areas no longer exist")
    if args.recalculate:
        if not areas or (not args.area_id and not args.all_areas):
            raise ValueError("Recalculation requires explicit --area-id or --all-areas")
        from street_coverage.api.areas import (
            BatchRecalculateRequest,
            queue_batch_recalculate,
        )

        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        backup = await backup_areas(
            areas, GRAPH_STORAGE_DIR / "coverage-backups" / stamp
        )
        print(json.dumps({"backup_manifest": str(backup)}), flush=True)
        result = await queue_batch_recalculate(
            BatchRecalculateRequest(
                area_ids=[area.id for area in areas],
                trip_mode="both",
                rebuild_policy="always",
            )
        )
        print(json_util.dumps(result.model_dump()), flush=True)
    else:
        for area in areas:
            print(json_util.dumps(await audit_area(area)), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--area-id", action="append", default=[])
    parser.add_argument("--all-areas", action="store_true")
    parser.add_argument("--recalculate", action="store_true")
    os.umask(0o077)
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
