# EveryStreet

## Mapbox token configuration

This app expects a single Mapbox public access token provided via the
`MAPBOX_TOKEN` environment variable. The token is injected into client-side
Mapbox GL JS for map rendering only, so use a public token (`pk.`) only.

Recommended Mapbox-side restrictions:
- Restrict allowed URLs/origins to your production domain(s) and localhost for dev.
- Limit token scopes to tiles/styles only (no geocoding, directions, or map matching).
- Rotate the token if you suspect exposure.

## Valhalla + Nominatim configuration

All routing, map matching, and geocoding uses self-hosted services on the Tailnet.
Configure these in `.env`/`.env.example`:

- `VALHALLA_BASE_URL`
- `VALHALLA_STATUS_URL`
- `VALHALLA_ROUTE_URL`
- `VALHALLA_TRACE_ROUTE_URL`
- `VALHALLA_TRACE_ATTRIBUTES_URL`
- `NOMINATIM_BASE_URL`
- `NOMINATIM_SEARCH_URL`
- `NOMINATIM_REVERSE_URL`
- `NOMINATIM_USER_AGENT`
