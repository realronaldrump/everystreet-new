# Every Street Context

## Domain Terms

- **Live Trip**: Ephemeral webhook trip state used only by live map/UI features.
  Live Trip state is Redis-backed and must not be written to the Mongo
  historical trips collection.
- **Historical Trip**: Persisted trip history in Mongo. Historical Trip records
  are populated by Bouncie ingest and sync paths.
- **Bouncie Historical Ingest**: The workflow that fetches Bouncie trip history,
  validates ownership, processes trip data, and writes Historical Trips.
- **Bouncie Device**: Telematics hardware identified by an IMEI that can produce
  Bouncie trip data and may optionally report Vehicle metadata.
- **Vehicle**: A physical automobile identified by a VIN when that metadata is
  available from Bouncie or the user.
- **Fleet Registry**: The authoritative collection of active Bouncie Devices and
  their optional Vehicle metadata used to determine Bouncie Historical Ingest
  eligibility.
- **Map Setup**: The workflow that prepares local map data by selecting states,
  downloading extracts, clipping coverage, building Nominatim/Valhalla data, and
  verifying map service health.
- **Route Generation**: The workflow that loads Coverage Area streets, maps
  street segments to graph edges, solves an optimal route, fills route gaps, and
  returns a route result.
- **Generated Route**: An immutable, persistently identified result of Route
  Generation. Full-area routes and cluster routes use the same record for
  preview, navigation, export, and reload. Rebuilding its Coverage Area makes
  a Generated Route unavailable for new navigation.
- **Coverage Processing**: Durable work on a Historical Trip that credits
  streets, records the drive event, and refreshes coverage projections. Failed
  attempts retain their state for bounded retries and owner-visible recovery.

## Relationships

- A **Fleet Registry** contains zero or more **Bouncie Devices**.
- A **Bouncie Device** may report metadata for one **Vehicle**.
- A **Historical Trip** records the IMEI of the **Bouncie Device** that produced it.
- A completed **Live Trip** queues only its transaction ID in Redis for
  **Bouncie Historical Ingest**; its live snapshot is published and cleared.
- A **Coverage Area** may reference its current full-area **Generated Route**.
- A coverage mission references a **Generated Route** independently of its
  generation job's lifetime.
