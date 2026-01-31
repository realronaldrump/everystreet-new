# Local vs GHCR Docker Runs

Use these scripts to switch between your local working tree and the published GHCR images.

## Quick use

```bash
# Run from your local working tree
./scripts/switch-mode.sh local

# Run from published GHCR images (committed)
./scripts/switch-mode.sh prod
```

## What each mode does

Local mode
- Uses `docker-compose.local.yml` overrides.
- Bind-mounts this repo into `/app` so local edits are used immediately.
- Runs `uvicorn` with `--reload` for the web container.
- Stops Watchtower so it does not pull GHCR and overwrite local images.

Prod mode
- Pulls `web` and `worker` from GHCR.
- Starts the standard stack in `docker-compose.yml` (including Watchtower).

## Switching back and forth

To go from local back to GHCR, you can either do a clean stop first or skip it:

```bash
# Option A: clean stop of the local stack (recommended when you want a reset)
docker compose -f docker-compose.yml -f docker-compose.local.yml down
./scripts/switch-mode.sh prod

# Option B: skip the down; prod mode will recreate containers
./scripts/switch-mode.sh prod
```

To return to local after running GHCR:

```bash
./scripts/switch-mode.sh local
```

## Notes

- If you change Python dependencies (`requirements.txt`), re-run local mode so the image rebuilds.
- Worker code changes require a restart: `docker compose restart worker`.
