# Bouncie live tracking switch

The master switch is **Settings → Preferences → Bouncie Live Tracking**.
Its persisted field is `AppSettings.bouncieLiveTrackingEnabled`, default `false`.
Save Preferences to change it. Historical Bouncie sync and phone GPS navigation
are independent of this switch.

## Audit findings, September 8, 2026

The deployed web and worker images were both revision
`07c17876cc4312aef4a9c47b94e035417204d88b`. Before this change:

- There was no application-wide tracking switch. Production still contained
  `showLiveTracking: true`, an old extra settings field with no current readers.
- `webhook_active: true` was metadata last checked on May 3, 2026, not an
  enable/disable policy. The last recorded receipt was a `tripStart` at
  `2026-05-03T05:07:30Z`. That record does not establish a functioning drive feed
  or verify when the provider's outage began.
- The owner map made live API requests approximately every three seconds and
  opened `/ws/trips`; the home page also checked every ten seconds. No active
  Redis trip existed during the audit. An empty trip store did not mean disabled.
- Settings showed Bouncie as “Stale” and raised an overall warning because of
  the missing webhooks, despite historical sync being configured and running.
- Global task scheduling was enabled. `periodic_fetch_trips` was enabled on a
  one-minute interval, its latest run had completed, and recent historical
  Bouncie trips existed. Turning off scheduled tasks would impair this path.

## Scope of the switch

| Boundary | Behavior when off |
| --- | --- |
| Real webhook `/api/webhooks/bouncie/live` | Returns the existing HTTP 200 acknowledgement before body parsing, credential lookup, event dispatch, receipt recording, Redis trip writes, or completion-sync enqueueing. It does not claim to process the event. |
| Simulator `/api/simulator/bouncie-webhook` | Returns HTTP 409 with the disabled message. The map simulator entry is hidden. |
| Live service handlers | Ignore trip start, data, metrics, and end events. Direct service reads return no live trip without reading Redis. |
| `/api/active_trip`, `/api/trip_updates` | Return `enabled: false`, no trip, and an explicit disabled message. |
| `/ws/trips` | Sends `tracking_disabled` and closes without opening a Redis subscription. Existing connections close when the setting refreshes. |
| Map browser client | Does not create a tracker, live map layers, polling, WebSocket, or tracking timers on page load. Existing clients stop and clean up when they receive disabled status. |
| Home page | Hides the live indicator and skips live polling. Historical dashboard refresh continues. |
| Settings health | Reports live tracking as Disabled rather than treating missing deliveries as a current Bouncie failure. Retains old receipt metadata for diagnosis. |
| MCP live drive | Reports explicitly disabled; its widget stops refreshing. The overall snapshot exposes the enabled state. |
| Navigation | Phone/browser GPS navigation remains available. Location errors instruct the user to enable location access. Server-side position resolution skips disabled live state and can still use an explicit location or historical trip. |

The switch uses the existing shared settings loader with a process-local cache,
normally 30 seconds (`SETTINGS_CACHE_TTL_SECONDS` controls the existing cache).
A save invalidates the saving process immediately; other processes observe it
after their cache expires, and an open polling client may need another polling
interval. Reload a page after re-enabling to start its live client again.
Missing settings or a failed settings read resolve to off. No environment
override or Compose edit is required.

Existing Redis live snapshots retain their normal three-hour TTL while hidden.
Disabling does not manufacture a completed trip, delete historical trips, or
clear Redis globally. No active snapshot needed cleanup during this audit.
Already queued historical completion fetches may finish; ordinary historical
sync, coverage processing, map matching, vehicle data, and imports continue.

## Why these other controls are insufficient

- `showLiveTracking` has no implementation and is not reused as this switch.
- `webhook_active` describes an old provider registration check and is not
  authoritative application configuration.
- Auto-Center is a presentation preference, not a webhook or network control.
- Disable All Tasks and Periodic Trip Fetch control historical/background work;
  they do not stop webhook intake, WebSockets, or browser polling.
- Removing credentials would damage historical Bouncie access. Hiding only the
  live HUD would leave the backend and browser loops running.

## Verification

Regression tests cover explicit-boolean defaults, fail-closed configuration,
disabled webhook acknowledgement without processing, simulator rejection,
REST/WebSocket shutdown, direct service bypasses, and browser startup/shutdown.
Existing enabled-path tests explicitly turn the feature on. Production checks
must confirm the actual web and worker image revisions, disabled API responses,
the owner map/home network behavior, and historical sync status. A liveness
probe alone does not establish that live tracking is disabled.
