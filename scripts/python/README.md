# Python Scripts

These scripts are intended for production maintenance.

## Available scripts

- `seed_geo_coverage_boundaries.py`: seed state and city boundaries for the
  regional coverage explorer.
- `python -m street_coverage.maintenance`: read-only deployed coverage audit.
  With `--recalculate --area-id <id>` (or explicit `--all-areas`), first writes
  a restricted coverage snapshot under `data/graphs/coverage-backups`, then
  queues the app's sequential street rebuild and historical recalculation.
  This changes derived coverage and requires authorization for that operation.
  It never writes Historical Trips. Deliver the command through the normal
  GitHub pipeline before running it in an existing deployed app container.

## Usage

Run from the repo root on the production mini PC so imports and environment
settings resolve:

```bash
python scripts/python/seed_geo_coverage_boundaries.py
```
