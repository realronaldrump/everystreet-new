# Export Spec (v1)

Version: 1

## Entities
- `trips` (Trip documents)
- `matched_trips` (Trips with `matchedGps` present)
- `streets` (Coverage street segments for a coverage area)
- `boundaries` (Coverage area boundary polygon)
- `undriven_streets` (Coverage street segments with status `undriven`)

## Formats
- `trips`: `json`, `csv`, `geojson`
- `matched_trips`: `json`, `csv`, `geojson`
- `streets`: `geojson`
- `boundaries`: `geojson`
- `undriven_streets`: `geojson`

## Filters
- Trip filters: `start_date`, `end_date` (calendar date on `startTime`), `imei`, `status[]`, `include_invalid`
- Coverage exports: `area_id` (required)

## Output Package
All exports are delivered as a zip archive with this structure:

```
manifest.json
trips.{json|csv|geojson}
matched_trips.{json|csv|geojson}
coverage/streets.geojson
coverage/boundaries.geojson
coverage/undriven_streets.geojson
```

### manifest.json
Includes:
- `spec_version`
- `generated_at` (UTC ISO string)
- `job_id`
- `filters` (trip filters, if provided)
- `area` (coverage area metadata, if provided)
- `items[]` with filenames and record counts

## Notes
- JSON and CSV exports include explicit nulls for missing fields.
- GeoJSON exports include properties derived from current models and can include `geometry: null` if missing.
- Trips are filtered by `matchedGps != null` for `matched_trips` exports.
