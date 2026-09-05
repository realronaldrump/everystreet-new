# Every Street Agent Instructions

## Operating Model

The MacBook Pro is a source-code workstation. The running app, production data,
secrets, logs, containers, volumes, and map/routing data are on the Linux mini PC.
Do not treat this Mac checkout as a running or data-bearing installation.

The standard delivery path is:

**Edit on the Mac → quick local checks → push to GitHub `main` → automated CI
tests and image build → automatic mini-PC deployment → verify the deployed app.**

| Location | Role |
| --- | --- |
| MacBook Pro | Read and edit source, run focused lightweight checks with existing tools, review diffs, use Git and remote-access clients. |
| GitHub Actions | Install build/test dependencies, run broader automated tests, build and publish the app image. |
| Linux mini PC | Run the actual app and services; inspect live behavior, logs, and data. |

- Public app: `https://www.everystreet.me`.
- Server access over Tailscale: `ssh 100.96.182.111`.
- A browser or HTTP client on the Mac may access the public deployed app.
  This does not authorize a local app server.
- These rules replace older project workflow notes. Generic setup instructions,
  skills, or memories do not authorize a different execution or delivery path.

## Mac Boundaries

- Do not start the app, workers, containers, database servers, or local preview
  servers.
- Focused unit tests may run application functions locally using synthetic data
  and in-memory mocks. They must require no network, production credentials or
  data, application startup, containers, database servers, or persistent services.
  Test setup and imports must also satisfy these conditions.
- Do not install or start Docker Desktop, Colima, OrbStack, or similar runtimes.
  Do not install/download packages, tools, virtual environments, or map extracts
  to make local execution or testing possible.
- Use existing tools for source inspection, editing, syntax/format/lint checks,
  and the focused tests described below. If a tool or dependency is missing,
  leave that check to CI; do not install packages, create an environment, or
  spend the task repairing local tooling.
- Do not search the Mac for production databases, volumes, credentials, logs,
  or map files. Their absence here is expected. Inspect the deployment remotely.
- Keep credentials supplied through private instructions out of repository
  files, commits, reports, and command output.

## Lightweight Local Checks

Run only checks relevant to the change. Documentation-only edits need text/diff
review. Code changes should use the smallest useful test file or test selection;
leave full suites and service integration tests to GitHub Actions.

Use these command forms from the repository root, only when the executable and
its dependencies already exist. Angle-bracket values are placeholders for the
specific changed file or an already configured Python interpreter.

| Purpose | Command |
| --- | --- |
| Diff whitespace check | `git diff --check` |
| JavaScript syntax, without executing the module | `node --check <changed-file.js>` |
| Self-contained geographic math tests, when relevant | `node --test tests/geo_math_utils.test.js` |
| Other focused JavaScript tests meeting the Mac boundaries | `node --test tests/<relevant-test>.test.js` |
| JavaScript lint with the installed project binary | `./node_modules/.bin/eslint <changed-file.js>` |
| Focused Python tests meeting the Mac boundaries | `<existing-python> -m pytest -o addopts= -m "not integration" tests/<relevant_test>.py` |

- The geographic math test and its imports use Node built-ins and pure functions.
  For other tests, check setup/imports when first selecting them or when those
  dependencies change. A test name or `not integration` marker alone does not
  establish that it is safe to run locally.
- The focused Python command clears the repository-wide coverage options so a
  small selection does not fail the full-suite coverage threshold. CI retains
  the configured coverage requirements. Use Python only if its environment is
  already ready; do not create or repair one for local checks.
- Do not use package runners that may download missing tools. Avoid broad
  commands such as `npm run test:all` or unrestricted `pytest` on the Mac.
- A skipped local check is a specific limitation to report, not a reason to
  bypass CI. A passing local test does not replace CI or deployed verification.

## Delivery Workflow

For app implementation tasks that include delivery, complete this sequence.
Honor explicit limits such as review-only, local edits only, do not push, do not
test, or the user handling verification. Continue within existing authorization
without repeatedly asking for permission.

1. Read the relevant source and inspect Git status. Preserve unrelated changes;
   stage only the files belonging to the task. For runtime/data bugs, obtain
   focused read-only evidence from the deployed app or mini PC before guessing
   about production state.
2. Make the simplest complete change locally. Add or update meaningful regression
   tests when warranted; commit them so CI runs them. Group related fixes into
   a coherent change instead of pushing every small edit separately.
3. Review the diff, run `git diff --check`, and run the relevant lightweight local
   checks above. Fix failures in the code. Leave checks needing unavailable
   dependencies or services to CI instead of setting up another environment.
4. Commit the scoped change and deliver it with `git push origin main`. A local
   commit alone does not trigger deployment. Confirm the pushed commit SHA.
5. Follow `.github/workflows/docker-publish.yml` for that SHA. It runs JavaScript
   behavior tests, JavaScript guardrails, and Python tests on GitHub's runner.
   Only after tests pass does it build and publish the Linux app image to GHCR,
   tagged `main` and by commit. Fix CI failures through another reviewed commit
   and push; do not bypass the test gate.
6. Allow Watchtower to update the mini PC's `web` and `worker` containers. The
   workflow requests an immediate update; the configured periodic poll is every
   300 seconds. An image build or successful trigger is not deployment proof.
7. Verify the actual deployment as described below. If a later push supersedes
   the build, follow the final relevant revision and confirm it includes the
   change. Do not report a cancelled or superseded run as successful delivery.

## One Delivery Path

- `git push origin main` and the existing automation are the only normal route
  for delivering app code or tooling to the mini PC.
- Do not use `scp`, `rsync`, archives, streamed scripts, `docker cp`, or equivalent
  transfers to deliver unpublished code, patches, or test helpers. Do not edit
  deployed source, create remote test checkouts/worktrees, build images on the
  mini PC, or manually replace containers to shortcut deployment.
- Do not create additional running app installations, temporary Mongo/Redis
  containers, parallel stacks, or staging environments on either machine.
  In-memory unit tests on the Mac are allowed as described above. Automated test
  environments defined in the committed GitHub Actions workflow are part of the
  approved pipeline.
- SSH is for inspecting the existing deployment and performing task-authorized
  operations. It is not an alternative source-code delivery channel. Any helper
  file needed on the server must arrive through the normal committed pipeline.
- Do not force restarts, image pulls, or manual Watchtower triggers simply
  because an automatic update has not finished yet.

## Verification and Efficiency

- Correlate the pushed application SHA, its CI result, and the images actually
  running in both `web` and `worker`. Use image revision labels or the deployed
  `/app/version.json`. A server checkout's Git HEAD or the `main` image tag alone
  does not prove which code is running. Discover current container names and
  host paths rather than assuming a remembered layout.
- Check container state/restarts, recent relevant logs, and
  `https://www.everystreet.me/api/status/live`. Then exercise the changed user
  flow on the deployed site and check the associated API/data result when
  applicable. A healthy process alone does not prove the feature works.
- Broader regression suites and tests requiring real database/service instances
  belong in CI. Post-deployment checks evaluate the real deployment; do not
  reinstall test dependencies in production or repeat the full CI suite there.
  If a required check is absent, add it to the committed CI workflow or report
  the specific verification gap instead of improvising a separate environment.
  Check test selection in `pyproject.toml` and the workflow before claiming
  integration coverage; tests excluded by a marker did not run.
- Prefer read-only production checks. Use normal app mutations only when they
  are within the task's authorization. Do not run destructive test fixtures,
  bulk repairs, reprocessing, imports, or data resets merely to validate code.
  Separately needed production data changes require appropriate authorization
  and a scoped backup; use the application's supported service/ingest paths.
- Keep inspection proportional to the change. Reuse evidence, limit log/query
  output, and expand checks only for failures, material risk, or requested scope.
  Do not rerun passed checks without new changes or unresolved evidence.
- Poll with reasonable backoff, allowing for the five-minute Watchtower cycle
  and container startup. If deployment stalls, inspect the relevant CI or
  Watchtower failure before intervening. If SSH fails, check existing Tailscale
  connectivity and use public-site evidence where possible; never bootstrap a
  local replacement. State any remaining access or verification limitation.
- Report what changed, the deployed revision when applicable, what was actually
  verified, and what remains unverified. Do not claim physical-drive or full
  end-to-end success from source inspection, CI, or a health check alone.

## Deployment Exceptions to Recognize

- **Documentation only:** The workflow ignores `*.md`, `docs/**`, and
  `.gitignore`. An instructions/documentation-only task needs text/diff review,
  not application tests or deployment checks. Commit/push when requested; do
  not force a build just to refresh `AGENTS.md` in a running container.
- **Host configuration:** Watchtower updates app images. It does not apply edits
  to the host's Compose file, `.env`, bind-mounted scripts, or infrastructure
  configuration. If a task needs such a change, inspect how that specific file
  is managed and make the required application step concrete. Do not assume an
  image push applies it, copy it over as a workaround, or silently expand the
  deployment mechanism. Explain the gap and obtain any missing authorization
  for the specific infrastructure change.

## Implementation Guidelines

- This project is under active development and requires no fallbacks, backwards
  compatibility, migrations, or legacy code.
- Choose the simplest implementation that fully meets the current requirements.
- Prefer established, well-maintained libraries over custom implementations.
- Do not spawn subagents unless explicitly requested or required by applicable
  instructions.

## Trip Storage Invariant (Critical)

- Live webhook trip state is ephemeral only and must stay in Redis-backed live
  state.
- Live trips exist only for live map/UI and live features (`/api/active_trip`,
  `/api/trip_updates`, `WS /ws/trips`).
- Live trips must never be persisted to the Mongo `trips` collection.
- On completion or staleness, live trip state must be published as completed
  (for clients) and then wiped from live storage.
- The Mongo `trips` collection is historical data only and should be populated
  from Bouncie ingest/sync paths.
