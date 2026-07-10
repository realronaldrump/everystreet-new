# ADR 0001: Self-Managing Operations

## Status

Accepted

## Context

EveryStreet accumulated maintenance screens and one-off repair endpoints while
its ingestion, map, and analytics systems were still maturing. Those controls
made users responsible for detecting stale state, understanding subsystem
boundaries, sequencing repair actions, and retrying failed background work.

## Decision

EveryStreet operates through immutable System Reconciler policy.

- Routine jobs are always enabled at product-defined cadences.
- Reconcilers are idempotent, use durable ARQ execution, classify waiting
  prerequisites separately from failures, and apply bounded backoff.
- Historical ingestion uses overlapping windows and treats partial results as
  failures so gaps are retried.
- Derived Projections repair themselves from their source of truth.
- Live Trip state remains Redis-only and is finalized by a scheduled lifecycle
  reconciler, independent of whether a UI is open.
- Settings exposes passive system state, genuine preferences, Connections, and
  only conditions that require a meaningful user decision.
- Manual pause, run, retry, rematch, regeocode, rebuild, backfill, cache refresh,
  fleet sync, preview refresh, log, storage, and database-maintenance workflows
  are not part of the product interface.

## Consequences

Transient failures may make a feature temporarily show a recovering state, but
they do not create work for the user. Operational detail remains available in
structured task and job records with automatic retention. New derived features
must ship with a reconciler and health signal instead of a maintenance button.
