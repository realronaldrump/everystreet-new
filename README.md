# EveryStreet

## Mapbox token configuration

This app expects a single Mapbox public access token provided via the
`MAPBOX_TOKEN` environment variable. The token is injected into client-side
Mapbox GL JS, so use a public token (`pk.`) only.

Recommended Mapbox-side restrictions:
- Restrict allowed URLs/origins to your production domain(s) and localhost for dev.
- Limit token scopes to the minimum required APIs (tiles/styles, geocoding,
  directions, map matching).
- Rotate the token if you suspect exposure.
