# Every Street Intelligence for ChatGPT

Every Street exposes an anonymous, Streamable HTTP MCP server at:

`https://www.everystreet.me/mcp`

It gives ChatGPT bounded tools for historical trips, driving analytics, places,
recurring routes, geographic and street coverage, live Redis-backed drive state,
vehicle economics, coverage forecasts, and coverage missions. It does not expose
an unrestricted database query surface.

## Security model

- Authentication is intentionally `none`; every public tool declares `noauth`.
- Read tools return bounded, purpose-built data. Large geometry is delivered to
  app widgets through `_meta` or short-lived Redis view IDs instead of model text.
- Goal and mission writes use a two-step flow. ChatGPT may prepare an exact,
  signed action, but only the app-only confirmation widget can commit it after an
  explicit click. Tokens expire after 10 minutes and are single-use.
- Fuel logging uses the model-visible `log_gas_fillup` write tool and the host's
  normal write approval. It always resolves Marquise, the Nissan, validates the
  readings, and deduplicates retries before using the existing fill-up service.
- MCP activity is redacted and retained for 30 days. Anonymous per-tool rate
  limits protect expensive operations.
- Live webhook trips remain ephemeral Redis state. Mission reconciliation runs
  only after historical Bouncie ingestion has persisted a completed trip.

Optional OpenAI client-certificate enforcement is available with
`EVERYSTREET_MCP_REQUIRE_MTLS=true`. Only enable it behind a trusted edge that
validates the OpenAI client certificate, strips incoming copies of the verified
header, and injects the configured header itself. The default expected assertion
is `cf-tls-client-auth-cert-verified: success`.

## ChatGPT setup

1. Deploy and verify the public `/mcp` endpoint.
2. In ChatGPT developer mode, create an app/connector using the endpoint above.
3. Copy the technical app ID assigned by ChatGPT into the private Codex plugin's
   `.app.json`, then reinstall the plugin.
4. Start a new ChatGPT conversation and ask for an Every Street snapshot or a
   coverage mission.

The technical app ID does not exist until ChatGPT registration, so `.app.json`
must not be guessed or committed beforehand.

## Gas logging from photos

Refresh the existing Every Street connection after deploying new tools. In
ChatGPT, select Every Street and attach the odometer, final pump display, and
optional receipt/price photos with **"Log gas"**. In Codex, the same request uses
the `log-gas-fillup` skill. The car is always Marquise; full tank is the default,
and **"partial"** overrides it. Mention any intervening unlogged fill-ups so MPG
is not calculated across a missing fuel purchase.

`get_fuel_logging_context` supplies the vehicle's five latest entries, US units,
and account timezone. `inspect_fuel_photos` accepts OpenAI file parameters and
reads original EXIF capture time/offset for JPEG, HEIC, PNG, and other supported
images. Downloads are restricted to ChatGPT attachment hosts, do not follow
redirects, and are limited to six images of 20 MiB each. Only capture timestamps
are returned; images, signed URLs, GPS coordinates, and other EXIF are not stored
or returned. In local Codex, an existing ExifTool can read original attachments.

Prefer receipt transaction time, then the completed pump photo capture time,
then the odometer photo capture time. Metadata without an offset remains a local
camera time. The account timezone does not prove the transaction's location.
If the platform stripped EXIF and no receipt date is visible, ask the owner for
the missing date/time; never use upload time or file modification time.

`log_gas_fillup` requires a timestamp with an explicit offset, its source, gallons,
total odometer, and total paid or unit price. The missing cost/price is calculated
with decimal rounding. It rejects inconsistent arithmetic, non-finite values,
future times, conflicting odometer chronology, and an apparent interval above
80 MPG without a missed-fill flag. A Redis lock serializes equal readings; an
existing fill with the same gallons/odometer within 30 minutes is returned
instead of inserted again. Conflicting existing values require review, not an
automatic overwrite. Entries retain the conversational source and time source
and use the normal MPG calculation and map-cache invalidation.

## Operations

The authenticated Every Street Control Center calls `/api/chatgpt/status` to show
the server version, tool count, authentication and mTLS mode, recent call count,
and latest redacted tool call. It never returns secrets or tool arguments.

Use the public endpoint when checking deployed protocol or tool metadata.
Follow `AGENTS.md`: focused lightweight checks on the Mac, broader tests and image
builds in GitHub Actions, and read-only deployment verification on the mini PC.
