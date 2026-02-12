# EveryStreet Architecture

## Runtime entrypoints

- `app.py`: FastAPI web app, route registration, UI/static serving, lifecycle
  hooks.
- `tasks/worker.py`: ARQ background worker, cron scheduling, async job
  execution.

Both processes share startup/shutdown initialization via `core/startup.py`.

## Backend module boundaries

- `api/`, `*/api/`: HTTP endpoint modules only.
- `*/services/`: Domain business logic and orchestration.
- `core/`: Cross-cutting utilities (HTTP clients, exceptions, jobs, startup,
  shared helpers).
- `db/`: Beanie models, query builders, and aggregation utilities.
- `tasks/`: Async/background job entrypoints and orchestration.

## Data flow patterns

- Request path: endpoint -> service -> db/core utility -> response DTO.
- Background path: ARQ task -> service pipeline -> db writes + job progress
  metadata.
- Analytics path: service -> shared `db/aggregation_utils.py` pipeline stages ->
  aggregate results.

## External integration boundaries

- Map/UI assets: CDN and Mapbox references are template and frontend concerns.
- Provider ingestion/auth: Bouncie integration is isolated to
  `core/clients/bouncie.py` and `setup/services/bouncie_oauth.py`.
- Routing/geocoding backends: Valhalla and Nominatim clients live in
  `core/http/`.

## Conventions

- Keep API handlers thin; place domain logic in `services`.
- Reuse shared pipeline builders from `db/aggregation_utils.py` before adding ad
  hoc Mongo stages.
- Prefer shared startup utilities in `core/startup.py` for process lifecycle
  consistency.
