# Test Plan for GeoJSON Standardization

This test plan covers the verification of changes made to standardize GPS data handling across various modules. The goal is to ensure that `gps` (and `matchedGps`) fields are consistently stored and processed as valid GeoJSON `Point` or `LineString` objects, or `null`.

## 1. Unit Tests

### 1.1. `live_tracking.py` (`_standardize_and_validate_gps_data` equivalent logic, or direct tests if refactored into helpers)
   - **Test Case 1.1.1**: `process_trip_start` with valid `lat` and `lon` in `start_data` -> `gps` is `{"type": "Point", "coordinates": [lon, lat]}`.
   - **Test Case 1.1.2**: `process_trip_start` with missing `lat` or `lon` -> `gps` is `{"type": "Point", "coordinates": []}`.
   - **Test Case 1.1.3**: `process_trip_data` with an initial `Point` trip and new valid coordinates -> `gps` becomes a `LineString` including the initial point and new points.
   - **Test Case 1.1.4**: `process_trip_data` with an existing `LineString` and new unique coordinates -> new coordinates are appended to `gps.coordinates`.
   - **Test Case 1.1.5**: `process_trip_data` with new duplicate coordinates -> `gps.coordinates` remains unchanged (or reflects deduplication).
   - **Test Case 1.1.6**: `process_trip_data` with invalid coordinate data (e.g., non-numeric, out of range) in `trip_data_points` -> invalid points are skipped, valid ones form the GeoJSON.
   - **Test Case 1.1.7**: `process_trip_end` and `cleanup_stale_trips_logic`:
      - Input `gps` is `LineString` with < 2 distinct points -> `gps` in archive becomes `Point` or `null`.
      - Input `gps` is `Point` with invalid coordinates -> `gps` in archive becomes `null`.
      - Input `gps` is valid `LineString` with >= 2 points -> `gps` in archive remains that `LineString`.
      - Old `coordinates` field is successfully removed/absent in archived documents.

### 1.2. `trip_processor.py`
   - **Test Case 1.2.1**: `_standardize_and_validate_gps_data`
      - Input: Raw coordinate array `[[lon1, lat1], [lon2, lat2]]` -> Output: Valid GeoJSON `LineString`.
      - Input: Raw coordinate array `[[lon, lat]]` -> Output: Valid GeoJSON `Point`.
      - Input: Raw coordinate array with non-numeric values -> Output: `None`.
      - Input: Raw coordinate array with out-of-range coordinates -> Valid coordinates retained, invalid ones skipped. Output: `Point`, `LineString`, or `None`.
      - Input: Raw coordinate array `[[lon, lat], [lon, lat]]` (duplicate) -> Output: GeoJSON `Point`.
      - Input: JSON string `"{ \"type\": \"LineString\", \"coordinates\": [...] }"` -> Output: Parsed and validated GeoJSON `LineString` or `Point` or `None`.
      - Input: JSON string `"[ [lon, lat], ... ]"` -> Output: Parsed and validated GeoJSON `LineString` or `Point` or `None`.
      - Input: JSON string `"{ \"foo\": \"bar\" }"` (invalid GPS structure) -> Output: `None`.
      - Input: Dictionary `{"type": "Point", "coordinates": [lon, lat]}` (valid) -> Output: Same valid GeoJSON `Point`.
      - Input: Dictionary `{"type": "LineString", "coordinates": [[lon,lat]]}` (invalid LineString) -> Output: GeoJSON `Point`.
      - Input: Dictionary `{"type": "Polygon", ...}` -> Output: `None`.
      - Input: Python list `[{'lat': lat, 'lon': lon}, ...]` -> Output: Valid GeoJSON `LineString` or `Point`.
      - Input: `None` or empty list/dict -> Output: `None`.
   - **Test Case 1.2.2**: `validate()` method correctly fails if `self.processed_data['gps']` is `None` after standardization (and `gps` is required).
   - **Test Case 1.2.3**: `process_basic()` correctly extracts `start_coord` and `end_coord` from a standardized `Point` and `LineString` in `self.processed_data['gps']`. Distance calculation for `Point` is 0.
   - **Test Case 1.2.4**: `map_match()` skips API call if `gps` is `Point`. Correctly uses `coordinates` from `LineString`. Ensures `matchedGps` is valid GeoJSON.
   - **Test Case 1.2.5**: `save()` correctly saves the standardized `gps` (and `matchedGps`) GeoJSON object.

### 1.3. `app.py` (Upload Handlers)
   - **Test Case 1.3.1**: GPX file upload (`/api/upload`):
      - Valid GPX with one track segment -> `trip_dict['gps']` is valid GeoJSON `LineString` or `Point`.
      - GPX with coordinates resulting in one unique point -> `trip_dict['gps']` is GeoJSON `Point`.
      - GPX with invalid coordinates (e.g. non-numeric) -> Skips problematic points, forms valid GeoJSON from remaining, or skips segment if no valid points.
   - **Test Case 1.3.2**: `process_geojson_trip` function (used by GeoJSON upload):
      - Valid GeoJSON `FeatureCollection` with `LineString` features -> `gps` field in output trips is valid GeoJSON `LineString`.
      - Valid GeoJSON `FeatureCollection` with `Point` features -> `gps` field is valid GeoJSON `Point`.
      - GeoJSON feature with malformed coordinates -> `gps` field is `None` for that trip.
      - GeoJSON feature with non-Point/LineString geometry -> `gps` field is `None`.
      - GeoJSON LineString with one unique point -> `gps` field becomes a `Point`.

### 1.4. `export_helpers.py`
   - **Test Case 1.4.1**: `create_geojson` with a trip list:
      - `gps` is valid GeoJSON `Point` -> Correct GeoJSON `Feature` created.
      - `gps` is valid GeoJSON `LineString` -> Correct GeoJSON `Feature` created.
      - `gps` is `None` or invalid dict -> Trip is skipped.
   - **Test Case 1.4.2**: `create_gpx` with a trip list:
      - `gps` is valid GeoJSON `Point` -> GPX track with one point created.
      - `gps` is valid GeoJSON `LineString` -> GPX track with multiple points created.
      - `gps` is `None` or invalid dict -> Trip is skipped.

## 2. Integration Tests

   - **Test Case 2.1 (Bouncie Webhook to DB)**: Simulate a Bouncie `tripStart`, `tripData`, `tripMetrics`, `tripEnd` sequence. Verify:
      - `live_trips` collection: `gps` field is `Point` on start, evolves to `LineString` with `tripData`.
      - `archived_live_trips` collection: `gps` field is valid GeoJSON `Point` or `LineString` upon `tripEnd`. Old `coordinates` field is absent.
   - **Test Case 2.2 (GPX Upload to DB)**: Upload a GPX file via `/api/upload`. Verify:
      - `trips` collection: Document has `gps` field as valid GeoJSON `Point` or `LineString`.
   - **Test Case 2.3 (GeoJSON Upload to DB)**: Upload a GeoJSON file via `/api/upload`. Verify:
      - `trips` collection: Documents have `gps` field as valid GeoJSON `Point` or `LineString`, or `null` if input was invalid.
   - **Test Case 2.4 (Full Trip Processing via `TripProcessor`)**: Provide a raw trip dictionary (simulating Bouncie data before `live_tracking.py` processing, or a direct API input if such an endpoint exists) to `TripProcessor`. Run `process()` and `save()`. Verify:
      - `trips` collection: `gps` and `matchedGps` (if map matching ran) are valid GeoJSON or `null`.
      - `matched_trips` collection: `matchedGps` is valid GeoJSON.

## 3. Migration Script Tests (`migrate_gps_field.py`)

   - **Test Case 3.1**: Empty collection -> Script runs without errors, no changes.
   - **Test Case 3.2**: Collection with documents already having valid GeoJSON `Point` in `gps`/`matchedGps` -> Documents are counted as "already correct", no unintended modifications.
   - **Test Case 3.3**: Collection with documents already having valid GeoJSON `LineString` in `gps`/`matchedGps` -> Counted as "already correct".
   - **Test Case 3.4**: `gps` field is a JSON string `"[ [lon, lat], ... ]"` -> Migrated to GeoJSON `LineString` or `Point`.
   - **Test Case 3.5**: `gps` field is a JSON string `"{ \"type\": \"Point\", ... }"` -> Migrated to GeoJSON `Point`.
   - **Test Case 3.6**: `gps` field is a raw list `[[lon, lat], ...]` -> Migrated to GeoJSON `LineString` or `Point`.
   - **Test Case 3.7**: `gps` field is a raw list `[{'lat': lat, 'lon': lon}, ...]` -> Migrated to GeoJSON `LineString` or `Point`.
   - **Test Case 3.8**: `gps` field is a dict `{"coordinates": [[lon, lat], ...], "type": "LineString"}` (potentially with extra keys) -> Migrated/cleaned to valid GeoJSON.
   - **Test Case 3.9**: `gps` field has LineString with duplicate consecutive points -> Migrated to LineString with deduplicated points.
   - **Test Case 3.10**: `gps` field has LineString that becomes a single unique point after deduplication -> Migrated to `Point`.
   - **Test Case 3.11**: `gps` field has coordinates out of WGS84 range -> Invalid points are skipped; result is valid GeoJSON or `null`.
   - **Test Case 3.12**: `gps` field is malformed JSON string -> Field is unset (or set to `null`), error counted.
   - **Test Case 3.13**: `gps` field is `None` or empty list/string/dict -> Field is unset (or set to `null`).
   - **Test Case 3.14**: `gps` field is an unsupported type (e.g., number, boolean) -> Field is unset, error counted.
   - **Test Case 3.15**: Script creates `2dsphere` indexes successfully on `gps` and `matchedGps` after migration.
   - **Test Case 3.16**: Run script on a collection with a mix of valid, invalid, and stringified data for both `trips.gps` and `matched_trips.matchedGps`. Verify counts and final data state.

## 4. Consumer Module Tests

### 4.1. `street_coverage_calculation.py`
   - **Test Case 4.1.1**: `CoverageCalculator._is_valid_trip`
      - Input: Valid GeoJSON `Point` dict -> Returns `(True, [coords, coords])`.
      - Input: Valid GeoJSON `LineString` dict -> Returns `(True, original_coordinates_list)`.
      - Input: `None` -> Returns `(False, [])`.
      - Input: Invalid GeoJSON dict (e.g., wrong type, malformed coords) -> Returns `(False, [])`.
   - **Test Case 4.1.2**: `CoverageCalculator.process_trips` with trips having:
      - Valid `Point` GPS -> Trip is processed (simulated as a short line).
      - Valid `LineString` GPS -> Trip is processed.
      - `None` GPS -> Trip is skipped.
      - Invalid GeoJSON GPS dict -> Trip is skipped.

### 4.2. `export_helpers.py`
   - **Test Case 4.2.1**: `create_geojson` and `create_gpx` with trips having:
      - Valid `Point` GPS -> Correctly included in export.
      - Valid `LineString` GPS -> Correctly included in export.
      - `None` GPS -> Trip is skipped in export.
      - Invalid GeoJSON dict GPS -> Trip is skipped.
   - **Test Case 4.2.2**: `create_csv_export` with `include_gps_in_csv=True`.
      - `gps` is valid GeoJSON `Point`/`LineString` -> `gps` column contains the JSON string representation of the GeoJSON object.
   - **Test Case 4.2.3**: `create_shapefile` (indirectly via `create_export_response`).
      - Ensure it handles features whose `geometry` is a valid GeoJSON `Point` or `LineString` dictionary.

## 5. Live Tracking Tests

   - **Test Case 5.1**: Full lifecycle:
      - Bouncie `tripStart` (with `lat`/`lon`) -> `live_trips` doc created with `gps` as `Point`.
      - Bouncie `tripData` events -> `live_trips` doc `gps` updates to `LineString`, coordinates appended.
      - Bouncie `tripEnd` -> `live_trips` doc removed, `archived_live_trips` doc created with final GeoJSON `gps`.
   - **Test Case 5.2**: `get_active_trip` and `get_trip_updates` API endpoints:
      - Ensure the `gps` field in the response is a valid GeoJSON object.
   - **Test Case 5.3**: `cleanup_stale_trips_logic`:
      - Stale trip with `gps` as `Point` -> Archived with `gps` as `Point`.
      - Stale trip with `gps` as `LineString` -> Archived with `gps` as `LineString`.
      - Validation logic for LineString with <2 points converting to Point/null is correctly applied.

This comprehensive test plan aims to cover the critical aspects of the GeoJSON standardization across the application.
