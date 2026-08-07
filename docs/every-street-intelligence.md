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

## Operations

The authenticated Every Street Control Center calls `/api/chatgpt/status` to show
the server version, tool count, authentication and mTLS mode, recent call count,
and latest redacted tool call. It never returns secrets or tool arguments.

Use the MCP Inspector against the public endpoint when changing protocol or tool
metadata. Run Python, JavaScript, lint, image-build, and runtime checks only on the
production mini PC, as required by this repository's deployment policy.
