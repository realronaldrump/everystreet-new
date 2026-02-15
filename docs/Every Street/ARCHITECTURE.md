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

## Coverage mission flow

- Mission document: `db/models.py::CoverageMission` stores durable turn-by-turn
  session state by area/version with capped checkpoints.
- Mission service: `street_coverage/services/missions.py` owns lifecycle rules,
  strict status transitions, heartbeat updates, and segment progress dedupe.
- Mission API: `street_coverage/api/missions.py` exposes create/list/detail and
  lifecycle actions (`heartbeat`, `pause`, `resume`, `complete`).
- Coverage integration: `street_coverage/api/streets.py` accepts optional
  `mission_id` on `mark-driven`; coverage updates and mission deltas are returned
  in the same request path. Invalid `mission_id` values return `400`; mission
  status/ownership conflicts return `409`.
- Coverage integrity guard: `core/coverage.py::update_coverage_for_segments`
  ignores unknown segment IDs (not present in current area/version streets) so
  driven segment counters and mission progress cannot be inflated by bad input.
  Missing/deleted areas return a no-op result (no orphaned coverage-state writes).
- Streets query compatibility: `GET /api/coverage/areas/{area_id}/streets/all`
  continues to accept `?status=...` for filtering (`undriven|driven|undriveable`)
  via query alias mapping.
- Frontend integration:
  - Coverage Navigator (`static/js/modules/optimal-route/*`) loads active mission
    card + mission history and deep-links resume into Turn-by-Turn.
  - Turn-by-Turn (`static/js/modules/turn-by-turn/*`) creates/resumes missions,
    sends heartbeats every 30s while active, includes `mission_id` in debounced
    segment persistence, and completes/cancels/pauses missions during teardown.

## Coverage mission data contract

- Status: `active | paused | completed | cancelled`
- Counters:
  - `session_segments_completed`: unique segment IDs completed during mission.
  - `session_gain_miles`: miles gained from deduped segment completion.
- Segment dedupe source of truth: `completed_segment_ids` in mission document.
- Mission progress integrity: unknown/non-existent segment IDs are ignored during
  mission progress updates; only real current-area street segments increment
  counters.
- Timeline: `checkpoints` is intentionally capped and stores events/metadata; no
  full breadcrumb GPS trace is persisted.
- Lifecycle endpoints:
  - `POST /api/coverage/missions`
  - `GET /api/coverage/missions/active`
  - `GET /api/coverage/missions`
  - `GET /api/coverage/missions/{mission_id}`
  - `POST /api/coverage/missions/{mission_id}/heartbeat`
  - `POST /api/coverage/missions/{mission_id}/pause`
  - `POST /api/coverage/missions/{mission_id}/resume`
  - `POST /api/coverage/missions/{mission_id}/complete`
  - `POST /api/coverage/missions/{mission_id}/cancel`
- List payload shape:
  - `GET /api/coverage/missions` returns pagination metadata
    (`count`, `limit`, `offset`, `has_more`) plus compact mission rows.
  - Compact mission rows omit full `completed_segment_ids` and `checkpoints`
    payloads for navigator/history rendering efficiency.
- Valid transitions:
  - `active -> paused | completed | cancelled`
  - `paused -> active | completed | cancelled`
  - terminal missions do not transition further.
- Error semantics:
  - `400`: invalid object IDs or invalid status filters.
  - `404`: mission/coverage area not found.
  - `409`: lifecycle transition guard violations or mission/area conflicts.

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
