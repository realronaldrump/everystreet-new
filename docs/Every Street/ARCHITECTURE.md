# Every Street Architecture

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

## Coverage flow

- Historical Trip writes include durable coverage work state. The initial
  attempt runs after persistence; a bounded worker drain retries failed work
  and recovers expired leases. Exhausted retries remain visible through
  `/api/actions/trips/processing/status` and can be explicitly retried.
- Historical credit commits CoverageState transitions, CoverageArea deltas,
  CoverageDriveEvent evidence, and journal invalidation in one MongoDB
  transaction. The drive event retains its original newly credited segments,
  allowing journal/mission projection retries without counting credit twice.
- Redis completion jobs carry a transaction ID only, deduplicate duplicate
  webhooks, and retry delayed Bouncie history with bounded backoff. The existing
  Fleet Registry and Bouncie ingest validation remain authoritative. No live
  trip snapshot is written to Mongo.
- The shared browser processing monitor observes the historical revision and
  refreshes open trip/coverage views when processing advances. Failures retain
  a visible Retry updates action.

- Coverage state is modeled by `db/models.py::CoverageState`, keyed by
  `area_id + segment_id`.
- Coverage writes use `core/coverage.py::update_coverage_for_segments` via
  `POST /api/coverage/areas/{area_id}/streets/mark-driven`.
- Coverage integrity guard: unknown segment IDs (not present in the current
  area/version street set) are ignored to prevent invalid counter inflation.
- Streets query: `GET /api/coverage/areas/{area_id}/streets/all` supports the
  `?status=...` filter (`undriven|driven|undriveable`).
- Frontend integration:
  - Route Planner (`static/js/modules/optimal-route/*`) manages area selection,
    route generation, and route export.
  - Live Navigation (`static/js/modules/live-navigation/*`) persists driven
    segments through the same coverage endpoint without any separate session
  lifecycle.

## Generated routes

- `routing/route_store.py` owns immutable GeneratedRoute records. Successful
  generation atomically saves its result, updates the full-area pointer when
  appropriate, and publishes Job completion. Cluster routes never replace
  the current full-area pointer.
- `/api/generated-routes/{route_id}` and its `/gpx` export address the exact
  result. Planner and navigation URLs retain `routeId`; pending planner URLs
  retain `taskId`. A deleted or rebuilt-area route produces an explicit error.
- Coverage revision changes are reported as stale planning input without
  substituting another route. Regeneration preserves a cluster's scope.
- Route cancellation targets one task and cannot be undone by a later
  progress update. Route deletion only clears an area pointer that still
  references the deleted result.

## Workflow verification

- `tests/test_workflow_transactions.py` runs against an isolated Mongo replica
  set with `WORKFLOW_TEST_MONGO_URI`; use `-m integration` explicitly. It covers
  rollback, concurrent credit, projection replay, durable completion, route
  identity, deletion, and stale area versions. Never point this suite at the
  production database.
- `tests/route_handoff.test.js` exercises planner/navigation/export selection
  and late-result handling. Completion sync and recovery have focused Python
  tests; the processing monitor has JavaScript event/teardown tests.

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
- Browser singleton modules should guard `document`/`navigator` usage so imports
  remain safe in Node-based tests and tooling.
