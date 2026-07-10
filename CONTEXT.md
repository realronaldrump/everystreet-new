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
- **System Reconciler**: A scheduled, idempotent background worker that compares
  actual state with product policy and moves it toward the desired state. A
  System Reconciler owns retry, backoff, recovery, and operational telemetry;
  users do not run or configure it.
- **Derived Projection**: Data computed from a source of truth, such as matched
  trip geometry, street coverage, Region Explorer summaries, mobility profiles,
  recurring routes, and place previews. Derived Projections must be repaired by
  System Reconcilers and must never require a user maintenance workflow.
- **Action Required**: A condition that cannot be resolved safely without a
  meaningful user decision, such as connecting or reauthorizing Bouncie. A
  transient service failure, stale projection, incomplete batch, or stopped
  worker is not Action Required; the system retries and recovers it.
- **Connection**: User-owned authorization and credentials for an external
  capability. Connection choices belong in Settings; provider synchronization
  and token refresh do not.

## Operating Policy

- Background correctness tasks are enabled and scheduled by immutable product
  policy. Settings may show their state but cannot pause, retime, reset, or run
  them.
- Temporary failures use bounded exponential backoff and remain visible as
  recovering. Successful reconciliation clears the failure streak.
- Partial batch outcomes are failures, not successful task runs. Their overlap
  windows and retry behavior must close gaps automatically.
- User-facing controls are reserved for source-of-truth choices. Repairing a
  Derived Projection is never a source-of-truth choice.
