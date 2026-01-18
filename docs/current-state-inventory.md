# Current-State Inventory - EveryStreet

## Snapshot Overview

- Backend runtime: Python 3.12 with FastAPI (app entrypoint in `app.py`).
- Frontend: Jinja2-rendered HTML templates with static CSS/JS; Mapbox token injected server-side.
- Background work: ARQ worker process (`tasks/worker.py`) using Redis for queues and heartbeats.
- Primary data store: MongoDB via Beanie ODM (collections defined in `db/models.py` and `street_coverage/models.py`).
- External geo services: self-hosted Valhalla (routing/map match) and Nominatim (geocoding).

## Entrypoints and Runtime Processes

- `app.py`: FastAPI app setup, router wiring, CORS, static files, startup/shutdown hooks.
- `tasks/worker.py`: ARQ worker, cron schedules, and startup/shutdown hooks.
- `Dockerfile`: Builds Python image, installs deps, runs Gunicorn with Uvicorn workers.
- `docker-compose.yml`: Defines `web`, `worker`, `redis`, `mongo`, `mongo-init`.
- `dev-mac.sh`: Local dev runner (optional local ARQ worker, uses local OSM PBF if present).
- `deploy.sh`: Deployment script for Docker + Cloudflare tunnel workflow.

## Configuration and Environment Variables

- App/CORS/port: `CORS_ALLOWED_ORIGINS`, `PORT`.
- Mapbox: `MAPBOX_TOKEN` (client-side rendering only; validated in `config.py`).
- Valhalla: `VALHALLA_BASE_URL`, `VALHALLA_STATUS_URL`, `VALHALLA_ROUTE_URL`, `VALHALLA_TRACE_ROUTE_URL`, `VALHALLA_TRACE_ATTRIBUTES_URL`.
- Nominatim: `NOMINATIM_BASE_URL`, `NOMINATIM_SEARCH_URL`, `NOMINATIM_REVERSE_URL`, `NOMINATIM_USER_AGENT`.
- OSM extract: `OSM_DATA_PATH` (local PBF for routing/coverage/graph generation).
- Redis: `REDIS_URL` or `REDISHOST`, `REDISPORT`, `REDISUSER`, `REDISPASSWORD`/`REDIS_PASSWORD`.
- MongoDB: `MONGO_URI` or `MONGO_HOST`, `MONGO_PORT`, `MONGODB_DATABASE`, plus pool/timeout tuning vars in `db/manager.py`.
- County topology: `COUNTY_TOPOLOGY_URL`, `COUNTY_TOPOLOGY_ALBERS_URL` (fallback CDN URLs).
- Task scheduling: `TRIP_FETCH_INTERVAL_MINUTES`.
- Tests/integration: `RUN_TAILNET_INTEGRATION` (see `TESTING.md`).

## Architecture Diagrams

### System overview

```txt
[Browser/UI]
    | HTTP + WS + SSE
    v
[FastAPI app] ---> [Templates/Static files]
    | \
    |  \--> [MongoDB]
    |  \--> [Redis] <--> [ARQ worker]
    |  \--> [Valhalla]
    |  \--> [Nominatim]
    |  \--> [Bouncie API]
    \--> [Filesystem: OSM PBF, graphml, cache]
[Bouncie webhooks] --> [FastAPI app]
```

### Data flow: trip ingestion and coverage

```txt
[Bouncie API] --periodic fetch--> [ARQ task] --> [TripProcessor] --> [MongoDB.trips]
[TripProcessor] --map match--> [Valhalla] --> [matchedGps in MongoDB]
[Bouncie Webhook] --> [live_tracking] --> [MongoDB.trips] --> [Redis Pub/Sub] --> [WS clients]
[MongoDB.trips] --trip completed event--> [Coverage matching] --> [coverage_state + coverage_areas]
[coverage_*] --> [Coverage APIs/UI]
```

### Data flow: optimal route generation

```txt
[UI] --POST /api/coverage/areas/{area_id}/optimal-route--> [FastAPI] --> [ARQ task]
[ARQ task] --> [routes/service + OSMnx]
    |-- reads --> [graphml cache] / [OSM PBF]
    |-- writes -> [optimal_route_progress] + [coverage_areas.optimal_route]
[UI] --poll/SSE--> /api/optimal-routes/* --> progress + route download
```

## API Surface (FastAPI)

### Conventions

- Default response type is JSON; errors use HTTP status with JSON `detail`.
- Dates and timestamps are ISO 8601 strings (UTC unless otherwise noted).
- Streaming endpoints use `application/geo+json` or `text/event-stream`.
- WebSocket `/ws/trips` emits JSON `trip_state` messages.
- Query filters like `start_date`, `end_date`, and `imei` are supported where noted.

### HTML pages (Jinja2 templates)

- GET `/` Request: none. Response: HTML landing page.
- GET `/map` Request: none. Response: HTML map page with Mapbox token injected.
- GET `/edit_trips` Request: none. Response: HTML trip editor with Mapbox token injected.
- GET `/settings` Request: none. Response: HTML settings page with repo version info.
- GET `/profile` Request: none. Response: HTML profile settings page.
- GET `/vehicles` Request: none. Response: HTML vehicles page.
- GET `/insights` Request: none. Response: HTML insights page.
- GET `/visits` Request: none. Response: HTML visits page with Mapbox token injected.
- GET `/gas-tracking` Request: none. Response: HTML gas tracking page with Mapbox token injected.
- GET `/export` Request: none. Response: HTML export page.
- GET `/coverage-management` Request: none. Response: HTML coverage management page with Mapbox token injected.
- GET `/database-management` Request: none. Response: HTML database stats page.
- GET `/server-logs` Request: none. Response: HTML server logs page.
- GET `/coverage-navigator` Request: none. Response: HTML coverage navigator page with Mapbox token injected.
- GET `/turn-by-turn` Request: none. Response: HTML turn-by-turn page with Mapbox token injected.
- GET `/trips` Request: none. Response: HTML trips page with Mapbox token injected.
- GET `/app-settings` Request: none. Response: 301 redirect to `/settings`.

### Admin and database tools

- GET `/api/app_settings` Request: none. Response: JSON settings (mapbox token omitted).
- POST `/api/app_settings` Request: JSON partial settings. Response: persisted settings.
- POST `/api/database/clear-collection` Request: JSON `{collection}`. Response: `{message, deleted_count}`.
- GET `/api/database/storage-info` Request: none. Response: `{used_mb}` (placeholder if unknown).
- POST `/api/validate_location` Request: JSON `{location, locationType}`. Response: validated location payload or 404/504.
- GET `/api/first_trip_date` Request: none. Response: `{first_trip_date}` ISO string.

### Analytics

- GET `/api/trip-analytics` Request: query `start_date`, `end_date`, `imei` (required unless `$expr`). Response: aggregated trip analytics (service-defined).
- GET `/api/time-period-trips` Request: query `time_type`, `time_value`, plus optional filters. Response: trips or aggregates for the period.
- GET `/api/driver-behavior` Request: optional query filters. Response: driver behavior stats.
- GET `/api/trips/history` Request: query `limit`. Response: `{trips: [...]}` for landing feed.
- GET `/api/driving-insights` Request: optional query filters. Response: driving insights payload.
- GET `/api/metrics` Request: optional query filters. Response: metrics summary payload.

### Bouncie webhooks

- POST `/api/webhooks/bouncie` (aliases: `/api/webhooks/bouncie/`, `/webhook/bouncie`, `/webhook/bouncie/`, `/bouncie-webhook`, `/bouncie-webhook/`) Request: JSON webhook payload, optional header `x-bouncie-authorization` or `authorization`. Response: 200 `{status:"ok"}` (processing happens async).
- GET `/api/webhooks/bouncie/status` Request: none. Response: `{status:"success", last_received, event_type, server_time}`.

### Counties

- GET `/api/counties/topology` Request: query `projection` (optional). Response: `{success, projection, source, updatedAt, topology}`.
- GET `/api/counties/visited` Request: none. Response: `{success, counties, stoppedCounties, totalVisited, totalStopped, lastUpdated, totalTripsAnalyzed, cached}`.
- POST `/api/counties/recalculate` Request: none. Response: `{success, message}` (background calculation).
- GET `/api/counties/cache-status` Request: none. Response: `{cached, totalVisited, totalStopped, tripsAnalyzed, lastUpdated, calculationTime}`.

### Coverage management (street_coverage)

- GET `/api/coverage/areas` Request: none. Response: `{success, areas:[...]}` with stats and timestamps.
- POST `/api/coverage/areas` Request: `{display_name, area_type?, boundary?}`. Response: `{success, area_id, job_id?, message}`.
- GET `/api/coverage/areas/{area_id}` Request: none. Response: `{success, area, bounding_box?, has_optimal_route}`.
- DELETE `/api/coverage/areas/{area_id}` Request: none. Response: `{success, message}`.
- POST `/api/coverage/areas/{area_id}/rebuild` Request: none. Response: `{success, job_id, message}`.
- POST `/api/coverage/areas/{area_id}/backfill` Request: none. Response: `{success, message, segments_updated}`.
- GET `/api/coverage/areas/{area_id}/streets` Request: query `min_lon`, `min_lat`, `max_lon`, `max_lat`. Response: `{success, features, total_in_viewport, truncated}`.
- GET `/api/coverage/areas/{area_id}/streets/geojson` Request: same query as above. Response: GeoJSON FeatureCollection.
- GET `/api/coverage/areas/{area_id}/streets/all` Request: query `status` (optional). Response: GeoJSON FeatureCollection.
- PATCH `/api/coverage/areas/{area_id}/streets/{segment_id}` Request: `{status:"undriveable"|"undriven"}`. Response: `{success, message}`.
- POST `/api/coverage/areas/{area_id}/streets/mark-driven` Request: `{segment_ids:[...]}`. Response: `{success, updated}`.
- GET `/api/coverage/areas/{area_id}/streets/summary` Request: none. Response: coverage counts and totals.
- GET `/api/coverage/jobs/{job_id}` Request: none. Response: job status with progress and timestamps.
- GET `/api/coverage/areas/{area_id}/jobs` Request: query `limit` (optional). Response: `{success, jobs:[...]}`.
- GET `/api/coverage/jobs` Request: none. Response: `{success, jobs:[... active ...]}`.
- DELETE `/api/coverage/jobs/{job_id}` Request: none. Response: `{success, message}`.

### Optimal routes (coverage completion)

- POST `/api/coverage/areas/{area_id}/optimal-route` Request: query `start_lon`, `start_lat` (optional). Response: `{task_id, status:"started"}`.
- GET `/api/coverage/areas/{area_id}/optimal-route` Request: none. Response: `{status:"success", location_name, ...route data}` or 404.
- GET `/api/coverage/areas/{area_id}/optimal-route/gpx` Request: none. Response: GPX download (`application/gpx+xml`).
- DELETE `/api/coverage/areas/{area_id}/optimal-route` Request: none. Response: `{status:"success", message}`.
- GET `/api/coverage/areas/{area_id}/active-task` Request: none. Response: `{active, task_id, status, stage, progress, message, metrics, updated_at}`.
- GET `/api/optimal-routes/worker-status` Request: none. Response: `{status, message, workers}`.
- GET `/api/optimal-routes/{task_id}/progress` Request: none. Response: progress payload `{status, stage, progress, message, metrics, error, timestamps}`.
- GET `/api/optimal-routes/{task_id}/progress/sse` Request: none. Response: `text/event-stream` progress updates.
- DELETE `/api/optimal-routes/{task_id}` Request: none. Response: `{status:"cancelled", message}`.

### Driving navigation helpers

- POST `/api/driving-navigation/next-route` Request: `{location:{id,...}, current_position?, segment_id?}`. Response: route payload with target segment or `{status:"completed"}`.
- GET `/api/driving-navigation/suggest-next-street/{area_id}` Request: query `current_lat`, `current_lon`, `top_n?`, `min_cluster_size?`. Response: `{status, suggested_clusters}`.

### Exports

- POST `/api/exports` Request: `{items:[{entity, format?, include_geometry?}], trip_filters?, area_id?}`; header `X-Export-Owner` (optional). Response: `{id, status, progress, message, created_at}`.
- GET `/api/exports/{job_id}` Request: header `X-Export-Owner` (optional). Response: `{id, status, progress, message, created_at, started_at, completed_at, error, result, download_url}`.
- GET `/api/exports/{job_id}/download` Request: header `X-Export-Owner` (optional). Response: ZIP file (`application/zip`) or 404/409.

### Gas and vehicles

- GET `/api/vehicles` Request: query `imei?`, `vin?`, `active_only?`. Response: list of Vehicle records.
- POST `/api/vehicles` Request: VehicleModel JSON. Response: created Vehicle record.
- PUT `/api/vehicles/{imei}` Request: VehicleModel JSON. Response: updated Vehicle record.
- DELETE `/api/vehicles/{imei}` Request: none. Response: `{status, message}` (marks vehicle inactive).
- GET `/api/gas-fillups` Request: query `imei?`, `vin?`, `start_date?`, `end_date?`, `limit?`. Response: list of GasFillup records.
- GET `/api/gas-fillups/{fillup_id}` Request: none. Response: GasFillup record.
- POST `/api/gas-fillups` Request: GasFillupCreateModel JSON. Response: created GasFillup.
- PUT `/api/gas-fillups/{fillup_id}` Request: GasFillupCreateModel JSON (partial). Response: updated GasFillup.
- DELETE `/api/gas-fillups/{fillup_id}` Request: none. Response: `{status, message}`.
- GET `/api/vehicle-location` Request: query `imei`, `timestamp?`, `use_now?`. Response: `{latitude, longitude, odometer, timestamp, address}` (values may be null).
- GET `/api/vehicles/estimate-odometer` Request: query `imei`, `timestamp`. Response: `{estimated_odometer, anchor_date, anchor_odometer, distance_diff, method}` (method may be `no_data`).
- GET `/api/gas-statistics` Request: query `imei?`, `start_date?`, `end_date?`. Response: aggregated gas stats.
- POST `/api/vehicles/sync-from-trips` Request: none. Response: `{status, synced, updated, total_vehicles}`.

### Live tracking

- WebSocket `/ws/trips` Request: WS upgrade. Response: JSON messages `{type:"trip_state", trip:{...}, status, transaction_id?}`.
- GET `/api/active_trip` Request: none. Response: `{status:"success", has_active_trip, trip?, server_time, message?}`.
- GET `/api/trip_updates` Request: none. Response: polling payload `{status, has_update, trip?, server_time}`.

### Logs

- GET `/api/server-logs` Request: query `limit`, `level?`, `search?`. Response: `{logs, total_count, returned_count, limit}`.
- DELETE `/api/server-logs` Request: query `level?`, `older_than_days?`. Response: `{message, deleted_count, filter}`.
- GET `/api/server-logs/stats` Request: none. Response: `{total_count, by_level, oldest_timestamp, newest_timestamp}`.

### Trip processing

- POST `/api/process_trip/{trip_id}` Request: `{map_match?, validate_only?, geocode_only?}`. Response: processing status and `saved_id` when applicable.
- GET `/api/trips/{trip_id}/status` Request: none. Response: processing status fields (validation/geocode/map-match timestamps, flags).
- POST `/api/map_match_trips` Request: query `trip_id` or `start_date` + `end_date`. Response: `{status, message, processed_count, failed_count}`.
- POST `/api/matched_trips/remap` Request: `{start_date?, end_date?, interval_days?}`. Response: `{status, message, deleted_count}`.

### Profile and Bouncie credentials

- GET `/api/profile/bouncie-credentials` Request: none. Response: `{status, credentials}` with masked secrets.
- POST `/api/profile/bouncie-credentials` Request: `{client_id, client_secret, redirect_uri, authorization_code, authorized_devices, fetch_concurrency?}`. Response: `{status, message}`.
- GET `/api/profile/bouncie-credentials/unmask` Request: none. Response: `{status, credentials}` with full secrets.
- POST `/api/profile/bouncie-credentials/sync-vehicles` Request: none. Response: `{status, message, vehicles, authorized_devices}`.

### Routing and search

- POST `/api/routing/route` Request: `{origin:[lon,lat], destination:[lon,lat]}`. Response: `{route:{geometry, duration, distance}}`.
- POST `/api/routing/eta` Request: `{waypoints:[[lon,lat], ...]}`. Response: `{duration}`.
- GET `/api/search/geocode` Request: query `query`, `limit?`, `proximity_lon?`, `proximity_lat?`. Response: `{results, query}`.
- GET `/api/search/streets` Request: query `query`, `location_id?`, `limit?`. Response: list of GeoJSON features grouped by street name.

### Background tasks control

- GET `/api/background_tasks/config` Request: none. Response: current task config snapshot with `tasks` map.
- POST `/api/background_tasks/config` Request: JSON task config updates. Response: `{status, message}`.
- POST `/api/background_tasks/pause` Request: `{duration}` optional. Response: `{status, message}`.
- POST `/api/background_tasks/resume` Request: none. Response: `{status, message}`.
- POST `/api/background_tasks/enable` Request: none. Response: `{status, message}`.
- POST `/api/background_tasks/disable` Request: none. Response: `{status, message}`.
- POST `/api/background_tasks/run` Request: `{task_id}` or `{task_id:"ALL"}`. Response: `{status, message, task_id?, job_id?, results?}`.
- GET `/api/background_tasks/details/{task_id}` Request: none. Response: task status, schedule, and run counts.
- GET `/api/background_tasks/history` Request: query `page`, `limit`. Response: `{history, total_count, total_pages, returned_count, limit}`.
- DELETE `/api/background_tasks/history` Request: none. Response: `{message, deleted_count}`.
- POST `/api/background_tasks/force_stop` Request: `{task_id}`. Response: `{status, message, cancelled_count}`.
- POST `/api/background_tasks/stop` Request: none. Response: `{status, message, cancelled_count}`.
- POST `/api/background_tasks/reset` Request: none. Response: `{status, message, cancelled_count}`.
- POST `/api/background_tasks/fetch_trips_range` Request: `{start_date, end_date, map_match?}`. Response: `{status, message, job_id}`.
- POST `/api/background_tasks/fetch_all_missing_trips` Request: `{start_date?}`. Response: `{status, message, job_id}`.
- GET `/api/background_tasks/sse` Request: none. Response: `text/event-stream` task updates.

### Trips CRUD and analytics

- GET `/api/trips` Request: query `start_date?`, `end_date?`, `imei?`, `matched_only?`. Response: streaming GeoJSON FeatureCollection.
- GET `/api/matched_trips` Request: query `start_date?`, `end_date?`, `imei?`. Response: streaming GeoJSON FeatureCollection (matchedGps geometry).
- POST `/api/trips/datatable` Request: DataTables payload (`draw`, `start`, `length`, `order`, `columns`, `filters`, `start_date?`, `end_date?`). Response: `{draw, recordsTotal, recordsFiltered, data}`.
- GET `/api/trips/invalid` Request: none. Response: `{status, trips, count}`.
- GET `/api/trips/{trip_id}` Request: none. Response: `{status, trip}`.
- PUT `/api/trips/{trip_id}` Request: `{geometry?, properties?}`. Response: `{status, message}`.
- DELETE `/api/trips/{trip_id}` Request: none. Response: `{status, message, deleted_trips}`.
- POST `/api/trips/bulk_delete` Request: `{trip_ids:[...]}`. Response: `{status, deleted_trips, message}`.
- POST `/api/trips/{trip_id}/restore` Request: none. Response: `{status, message}`.
- DELETE `/api/trips/{trip_id}/permanent` Request: none. Response: same as delete.
- POST `/api/geocode_trips` Request: `{start_date?, end_date?, interval_days?}`. Response: `{task_id, message, total, updated, skipped, failed}`.
- GET `/api/geocode_trips/progress/{task_id}` Request: none. Response: `{task_id, stage, progress, message, metrics, current_trip_id, error, updated_at}`.
- POST `/api/trips/{trip_id}/regeocode` Request: none. Response: `{status, message}`.

### Visits and places

- GET `/api/places` Request: none. Response: list of PlaceResponse.
- POST `/api/places` Request: `{name, geometry}`. Response: PlaceResponse.
- PATCH `/api/places/{place_id}` Request: `{name?, geometry?}`. Response: PlaceResponse.
- DELETE `/api/places/{place_id}` Request: none. Response: `{status, message}`.
- GET `/api/places/{place_id}/trips` Request: none. Response: PlaceVisitsResponse payload.
- GET `/api/places/{place_id}/statistics` Request: none. Response: PlaceStatisticsResponse payload.
- GET `/api/places/statistics` Request: none. Response: list of PlaceStatisticsResponse.
- GET `/api/visit_suggestions` Request: query `min_visits?`, `cell_size_m?`, `timeframe?`. Response: list of VisitSuggestion payloads.
- GET `/api/non_custom_places_visits` Request: query `timeframe?`. Response: list of NonCustomPlaceVisit payloads.

## Background Jobs and Scheduling (ARQ)

- Worker config: `tasks/worker.py` (cron + task registry).
- Task definitions in `tasks/registry.py`:
  - `periodic_fetch_trips`, `cleanup_stale_trips`, `validate_trips`, `remap_unmatched_trips`,
    `update_coverage_for_new_trips`, `manual_fetch_trips_range`, `fetch_all_missing_trips`,
    `generate_optimal_route`.
- Task control/storage:
  - `task_config` collection stores intervals, enabled flags, last run data.
  - `task_history` collection stores execution history and status.
- Worker heartbeat: Redis key `arq:worker:heartbeat` (used by `/api/optimal-routes/worker-status`).

## Data Stores and Collections

### MongoDB collections (Beanie models)

- `trips`: core trip data, GPS, derived geocoding fields, validation state.
- `matched_trips`: map-matched geometry for trips.
- `osm_data`: OSM boundary/geojson cache.
- `places`: custom places for visit tracking.
- `task_config`, `task_history`: background task settings and history.
- `progress_status`: generic progress tracking (legacy/general).
- `export_jobs`: export job specs, progress, artifacts.
- `optimal_route_progress`: RPP route generation progress.
- `gas_fillups`: gas fill-up records.
- `vehicles`: vehicle records and odometer state.
- `app_settings`: persisted UI/app settings.
- `server_logs`: log storage written by `MongoDBHandler`.
- `bouncie_credentials`: OAuth credentials, webhook key, device list.
- `county_visited_cache`, `county_topology`: county coverage cache and TopoJSON.
- Coverage system:
  - `coverage_areas`: coverage area metadata and stats.
  - `streets`: static street segments per area version.
  - `coverage_state`: dynamic driven/undriven state per segment.
  - `jobs`: coverage ingestion/rebuild job tracking.

### Redis usage

- ARQ job queue + worker heartbeat.
- Pub/Sub channel `trip_updates` for live tracking (`trip_event_publisher.py`).

### File-based data and caches

- `everystreet-data/us-9states.osm.pbf`: local OSM extract.
- `data/graphs/*.graphml`: per-area OSMnx graph cache for optimal routes.
- `cache/*.json`: cached artifacts (geocoding, intermediate results, etc.).
- `coverage.lcov`: test coverage output.
- `celerybeat-schedule.db`: legacy artifact (ARQ is active scheduler).
- `reports/`: autofix and tooling reports.

## Core Subsystems and Modules

- Trip ingestion and processing:
  - `bouncie_trip_fetcher.py`: pulls trips via Bouncie API.
  - `trip_processor/`: validation, geocoding, map matching pipeline.
  - `trip_service.py`, `trip_repository.py`: orchestration and persistence.
- Live tracking:
  - `bouncie_webhook_api.py` + `live_tracking.py`: webhook ingestion.
  - `live_tracking_api.py`: WebSocket + polling APIs.
  - `trip_event_publisher.py`: Redis Pub/Sub for updates.
- Coverage system:
  - `street_coverage/ingestion.py`: area creation/rebuild pipeline.
  - `street_coverage/worker.py`: trip-to-street matching and updates.
  - `street_coverage/matching.py`, `street_coverage/stats.py`: matching and stats.
  - `street_coverage/events.py`: event-driven coverage updates.
- Optimal routes:
  - `routes/`: RPP solver (NetworkX/OSMnx), graph caching, validation, GPX export.
  - `tasks/routes.py`: ARQ task wrapper for route generation.
- External geo services:
  - `core/http/valhalla.py`, `core/http/nominatim.py`: HTTP clients.
  - `external_geo_service/`: higher-level geocoding + map-matching utilities.
- Utilities:
  - `geometry_service.py`, `date_utils.py`, `core/math_utils.py`, `core/api.py`.

## Frontend Assets and Templates

- Templates: `templates/*.html` (landing, map, trips, coverage, visits, gas, settings, etc.).
- Static assets: `static/css/`, `static/js/`, `static/favicon.ico`.
- Data tables and map UIs are server-rendered and call API endpoints for data.

## Tooling, Tests, and Quality

- Python tests: `pytest` (see `TESTING.md`); mocks via `mongomock-motor`.
- JS tests: `npm test` (Node built-in test runner).
- Lint/format: Ruff (`pyproject.toml`), Biome (`biome.json`), ESLint (`eslint.config.mjs`), Stylelint.
- Coverage output: `coverage.lcov`.

## Top-Level Directory Map (Selected)

- `analytics/`: analytics routes and services.
- `core/`: shared utilities, HTTP clients, exceptions.
- `db/`: MongoDB manager, models, query utilities.
- `exports/`: export API, models, services, and spec.
- `external_geo_service/`: geocoding and map-matching helpers.
- `gas/`: gas tracking and vehicle management.
- `routes/`: optimal route solver (RPP) and graph tooling.
- `street_coverage/`: coverage ingestion, matching, stats, and routes.
- `tasks/`: ARQ worker, cron wrappers, and task ops.
- `trips/`: trip query/CRUD/stats routes and services.
- `visits/`: custom places, visits, and visit analytics.
- `static/`, `templates/`: frontend assets and HTML templates.
- `everystreet-data/`, `data/`, `cache/`, `reports/`: data assets and artifacts.
