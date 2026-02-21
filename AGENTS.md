# Codex Agent Instructions

This project is under active development and requires no fallbacks, backwards compatibility, migration, or legacy code.

## Trip Storage Invariant (Critical)

- Live webhook trip state is ephemeral only and must stay in Redis-backed live state.
- Live trips exist only for live map/UI and live features (`/api/active_trip`, `/api/trip_updates`, `WS /ws/trips`).
- Live trips must never be persisted to the Mongo `trips` collection.
- On completion or staleness, live trip state must be published as completed (for clients) and then wiped from live storage.
- The Mongo `trips` collection is historical data only and should be populated from Bouncie ingest/sync paths.
- Historical trip reads/analytics/exports must enforce `source=\"bouncie\"` so legacy webhook/non-bouncie rows are excluded.
