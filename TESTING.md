# Testing

## Python (backend)
Prereqs:
- `python -m pip install -r requirements.txt`
- Optional: load test defaults from `.env.test.example`

Run the suite:
```bash
pytest
```

Coverage:
- Terminal summary + `coverage.lcov`

Notes:
- Database tests use an in-memory Mongo mock (`mongomock-motor`), so no external
  services are required.
- Optional tailnet integration checks are gated behind env flags.

## JavaScript (frontend helpers)
```bash
npm test
```

## Optional integration tests (real services)
These are skipped by default:
```bash
RUN_TAILNET_INTEGRATION=1 pytest tests/test_geo_integration.py
```

Ensure these environment variables point at real services when enabled:
- `VALHALLA_STATUS_URL`
- `NOMINATIM_SEARCH_URL`
- `NOMINATIM_REVERSE_URL`
- `NOMINATIM_USER_AGENT`
