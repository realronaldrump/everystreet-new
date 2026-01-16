# Background Jobs (ARQ)

EveryStreet uses ARQ (asyncio-native) for background jobs and scheduled
cron tasks. The web app enqueues jobs into Redis; a separate ARQ worker
process executes them and runs cron checks.

## Required services

- Redis (configured via `REDIS_URL` or `REDISHOST`/`REDISPORT`/`REDISPASSWORD`)
- MongoDB (existing app dependency)

## Run locally

```sh
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8080 --reload
arq tasks.worker.WorkerSettings
```

## Run with Docker Compose

```sh
docker compose up -d --build
```

The `worker` service runs the ARQ worker. The web service can enqueue jobs
immediately.

## Worker status

The optimal-route UI checks `/api/optimal-routes/worker-status`, which uses a
Redis heartbeat written by the ARQ worker (key: `arq:worker:heartbeat`).
If the heartbeat is missing, the UI warns that workers may be offline.

## Task manager API

Background task scheduling and history are exposed via:

- `GET /api/background_tasks/config`
- `POST /api/background_tasks/config`
- `POST /api/background_tasks/run`
- `POST /api/background_tasks/force_stop`
- `POST /api/background_tasks/fetch_trips_range`
- `POST /api/background_tasks/fetch_all_missing_trips`
- `GET /api/background_tasks/history`
- `GET /api/background_tasks/sse`
