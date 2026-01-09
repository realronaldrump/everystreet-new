## AI Coding Agent Guide

- **Entrypoint and routing**: FastAPI app in [app.py](app.py) mounts routers for admin, analytics, county/coverage, driving/export, gas, live tracking, logs, processing/profile/search/tasks, trips/upload/visits; serves Jinja templates and static assets; startup wires Mongo indexes, MongoDB logging, live tracking, visits, and cached app settings.
- **Config sourcing**: External tokens and API credentials live in Mongo and are edited via the profile UI (not env vars). Mapbox/Clarity getters in [config.py](config.py) read cached settings; Bouncie OAuth config comes from the database via [bouncie_credentials.py](bouncie_credentials.py).
- **Database access pattern**: Use the shared `DatabaseManager` and retry helpers in [db.py](db.py) (`find_one_with_retry`, `update_one_with_retry`, `aggregate_with_retry`, collection helpers) instead of raw Motor calls; it handles loop changes, pooling, and transient errors.
- **Logging**: Startup attaches a MongoDB logging handler to `server_logs` and filters noisy static-file requests in [app.py](app.py); prefer the standard logger in async code and Celery tasks.
- **Redis config**: Always derive Redis URLs via [redis_config.py](redis_config.py) to encode credentials correctly; Celery and app components assume this helper.
- **Celery topology**: Celery app in [celery_app.py](celery_app.py) uses Redis for broker/backend, declares the `default` queue, and runs beat every minute to trigger the dynamic scheduler task `tasks.run_task_scheduler`.
- **Task metadata and lifecycle**: Task definitions and status enums live in [tasks/core.py](tasks/core.py); wrap async task bodies with `@task_runner` to auto-update status/history and to enable retries; manual-only tasks are marked in `TASK_METADATA`.
- **Scheduler**: [tasks/scheduler.py](tasks/scheduler.py) reads `global_background_task_config` from Mongo, checks dependencies, and queues Celery tasks (periodic fetch, cleanup, validate, remap, incremental coverage) while marking them PENDING/IDLE as it goes.
- **Trip ingestion**: Bouncie fetch logic in [tasks/fetch.py](tasks/fetch.py) chooses the date window from the latest trip (fallback 48h) with a 7-day cap, supports manual range fetches and bulk gap-filling, and can toggle map matching; creds come from `get_bouncie_config`.
- **Trip quality & remapping**: [tasks/maintenance.py](tasks/maintenance.py) cleans stale live trips, validates trips with `TripDataModel`, and remaps unmatched trips through `TripService` (requires a Mapbox token); dependencies are enforced via `check_dependencies`.
- **Coverage processing**: Coverage stats/segment updates live in [coverage/services.py](coverage/services.py); API handlers in [coverage/routes/calculation.py](coverage/routes/calculation.py) enqueue calculations and incremental updates, mark progress in Mongo, and regenerate GridFS GeoJSON.
- **Automated coverage updates**: Incremental coverage Celery task is in [tasks/coverage.py](tasks/coverage.py) looping coverage areas and calling `compute_incremental_coverage`; optimal route generation (RPP) is in [tasks/routes.py](tasks/routes.py) saving results back to Mongo.
- **Progress tracking**: Long-running coverage jobs update `progress_status` documents (stage/progress/message) and often spawn `asyncio.create_task` workers to avoid blocking HTTP responses.
- **Front-end delivery**: Templates under [templates](templates) render pages served by the `pages` router; static assets are mounted at `/static` via [app.py](app.py).
- **Live tracking lifecycle**: Startup initializes live-tracking collections; stale live trips are cleaned by `cleanup_stale_trips_async` in [tasks/maintenance.py](tasks/maintenance.py).
- **Sync/async bridging**: When a Celery task needs async logic, wrap it with `run_async_from_sync` from [utils.py](utils.py) and keep the core async function decorated with `@task_runner`.
- **Development commands**:
  - Local API: `uvicorn app:app --host 127.0.0.1 --port 8080 --reload`
  - Celery worker: `celery -A celery_app worker --loglevel=info --pool=prefork --concurrency=2`
  - Celery beat: `celery -A celery_app beat --loglevel=info`
  - Mac helper: `./dev-mac.sh [--local-worker]` (defaults to remote worker)
  - Containers: `docker-compose up --build` (web + worker + beat + redis + mongo replica set)
- **Environment expectations**: `.env` should define Mongo (MONGO_URI or host/port), Redis vars consumed by [redis_config.py](redis_config.py), and optional `CORS_ALLOWED_ORIGINS`; Mapbox, Clarity, and Bouncie secrets are configured via the app UI and stored in Mongo, not the file system.
- **When adding tasks or APIs**: Reuse `task_runner`, status manager, and retrying DB helpers; prefer updating task metadata and scheduler mapping so beat can trigger your task; write APIs to enqueue background work and return progress IDs rather than blocking.

Questions or gaps? Tell me what is unclear or missing and I will refine these instructions.
