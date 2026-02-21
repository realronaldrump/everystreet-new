#!/usr/bin/env python3
"""One-time Google Photos decommission purge utility.

Dry-run is the default behavior. Pass --execute to perform deletion.
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from db.manager import db_manager

TARGET_COLLECTIONS = (
    "google_photos_credentials",
    "trip_photo_moments",
    "trip_memory_postcards",
)
GENERATED_ROOT = REPO_ROOT / "static" / "generated" / "memory_atlas"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Purge Google Photos integration data and generated memory atlas files."
        ),
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply deletion. Without this flag, the script only reports what would be deleted.",
    )
    parser.add_argument(
        "--max-file-preview",
        type=int,
        default=20,
        help="Maximum number of generated files to print in dry-run mode.",
    )
    return parser.parse_args()


def _safe_generated_root(root: Path) -> Path:
    resolved = root.resolve()
    expected = (REPO_ROOT / "static" / "generated" / "memory_atlas").resolve()
    if resolved != expected:
        raise ValueError(f"Unsafe generated root path: {resolved}")
    return resolved


def _list_generated_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [p for p in root.rglob("*") if p.is_file()]


async def _collection_counts() -> dict[str, int]:
    await db_manager.init_beanie()
    db = db_manager.db
    counts: dict[str, int] = {}
    for name in TARGET_COLLECTIONS:
        counts[name] = await db[name].count_documents({})
    return counts


async def _purge_collections() -> dict[str, int]:
    db = db_manager.db
    deleted: dict[str, int] = {}
    for name in TARGET_COLLECTIONS:
        result = await db[name].delete_many({})
        deleted[name] = int(getattr(result, "deleted_count", 0))
    return deleted


def _print_report(
    *,
    execute: bool,
    counts: dict[str, int],
    generated_files: list[Path],
    max_file_preview: int,
) -> None:
    mode = "EXECUTE" if execute else "DRY-RUN"
    print(f"[{mode}] Google Photos purge report")
    print("")
    print("MongoDB collections:")
    for name in TARGET_COLLECTIONS:
        print(f"  - {name}: {counts.get(name, 0)}")
    print("")
    print(f"Generated files under {GENERATED_ROOT}: {len(generated_files)}")
    if not execute and generated_files:
        preview_limit = max(0, max_file_preview)
        for path in generated_files[:preview_limit]:
            try:
                rel = path.relative_to(REPO_ROOT)
                print(f"  - {rel.as_posix()}")
            except Exception:
                print(f"  - {path}")
        if len(generated_files) > preview_limit:
            remaining = len(generated_files) - preview_limit
            print(f"  ... and {remaining} more file(s)")
    print("")


async def main() -> int:
    args = parse_args()
    load_dotenv()

    generated_root = _safe_generated_root(GENERATED_ROOT)
    generated_files = _list_generated_files(generated_root)
    counts = await _collection_counts()

    _print_report(
        execute=args.execute,
        counts=counts,
        generated_files=generated_files,
        max_file_preview=args.max_file_preview,
    )

    if not args.execute:
        print("No changes were made. Re-run with --execute to apply purge.")
        return 0

    deleted_counts = await _purge_collections()
    files_deleted = len(generated_files)
    if generated_root.exists():
        shutil.rmtree(generated_root)

    print("Applied purge:")
    for name in TARGET_COLLECTIONS:
        print(f"  - {name}: deleted {deleted_counts.get(name, 0)} document(s)")
    print(f"  - static/generated/memory_atlas: deleted {files_deleted} file(s)")
    print("Purge complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
