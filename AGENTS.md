# Codex Agent Instructions

This project is under active development and requires no fallbacks, backwards
compatibility, migration, or legacy code.

## Trip Storage Invariant (Critical)

- Live webhook trip state is ephemeral only and must stay in Redis-backed live
  state.
- Live trips exist only for live map/UI and live features (`/api/active_trip`,
  `/api/trip_updates`, `WS /ws/trips`).
- Live trips must never be persisted to the Mongo `trips` collection.
- On completion or staleness, live trip state must be published as completed
  (for clients) and then wiped from live storage.
- The Mongo `trips` collection is historical data only and should be populated
  from Bouncie ingest/sync paths.

## Environment Memory

- Production/runtime deployment is on your Linux mini PC.
- Active development in this workspace is on your MacBook Pro.
- For production logs/process checks, SSH into the mini PC over Tailscale:
  `ssh <user>@100.96.182.111`
