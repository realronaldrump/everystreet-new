# EveryStreet Context

## Domain Terms

- **Live Trip**: Ephemeral webhook trip state used only by live map/UI features.
  Live Trip state is Redis-backed and must not be written to the Mongo
  historical trips collection.
- **Historical Trip**: Persisted trip history in Mongo. Historical Trip records
  are populated by Bouncie ingest and sync paths.
- **Bouncie Historical Ingest**: The workflow that fetches Bouncie trip history,
  validates ownership, processes trip data, and writes Historical Trips.
- **Map Setup**: The workflow that prepares local map data by selecting states,
  downloading extracts, clipping coverage, building Nominatim/Valhalla data, and
  verifying map service health.
- **Route Generation**: The workflow that loads Coverage Area streets, maps
  street segments to graph edges, solves an optimal route, fills route gaps, and
  returns a route result.
