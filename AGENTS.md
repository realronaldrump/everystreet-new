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
- Public app deployment URL is `https://www.everystreet.me`.
- When connected to Tailscale from this MacBook Pro, production can be reached
  with exactly: `ssh 100.96.182.111`
- For production deploys, logs, process checks, and runtime debugging, SSH into
  the mini PC at `100.96.182.111`.
- Unless the user explicitly asks for a local-only run, "deploy", "production",
  "server", or "runtime" refers to the mini PC deployment, not a local dev
  server on the MacBook Pro.
