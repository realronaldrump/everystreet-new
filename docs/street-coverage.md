# Street coverage

Street coverage measures the union of supported traveled intervals on the current
eligible road inventory. Lengths use WGS84 geodesic miles; interval endpoints are
normalized positions along the road. Repeated drives never multiply mileage.
Partial coverage contributes its actual length, while the segment stays undriven
until its remaining interval is empty. Completion is derived from remaining work,
not a rounded percentage.

Only persisted, eligible Bouncie Historical Trips provide automatic evidence.
Live navigation displays provisional progress without writing coverage. An owner's
manual driven, undriven, or undriveable decision overrides automatic evidence and
survives recalculation. Removing an override restores the automatic result.

Geometry, matching policy, and trip visibility changes invalidate prior evidence.
A full rematch replaces automatic evidence and projections. All writers coordinate
on the area's coverage revision; summaries and caches refer to that revision.
Inventory rebuilds preserve the published version until the replacement validates.

Matched geometry takes precedence when available. Raw geometry uses local tangent,
distance, continuity, and gap checks. Candidate roads compete only over overlapping
trace intervals. Buffers find candidates; their rounded end caps do not create
traveled distance.

Junctions follow three rules. Pieces of one street less than 1 m apart are one
piece, within a trip and across trips, because no vehicle drives both sides of
such a hole without driving it. A trip that drove at least half of a street,
passed through the junction at one end, and went there directly is credited with
the remaining stretch at that end, up to 25 m: turning traces cut corners, and a
ramp shares its first metres with the road it leaves, so neither wins them. A
trip's evidence shorter than 1 m on a street (or half of a shorter street) is a
graze at a shared junction, not a drive, and never counts as a trip on it.

Routing graphs encode legal direction separately from the physical coverage
inventory. Two-way roads have reverse traversal edges; coverage counts their
physical centerline once. Public-road filtering precedes topology simplification.

Maps of areas up to 30,000 segments draw every street from one response keyed
to the coverage revision, with one shared projection and only the properties
a layer reads; larger areas request bounded viewport data. Street details include evidence and exact
remaining length. Journal summaries, paginated contributions, and segment metrics
are bounded read models. Reads do not repair data. Timelines use elapsed calendar
time. Forecasts divide the new miles in a trailing window (90 days, 12 months,
or the whole history, never before the first drive) by every elapsed day in it,
and report each window as a pace scenario.

Focused local checks use existing tools and synthetic, in-memory data. Broader
regression suites and real MongoDB transaction tests run in GitHub Actions.
Code and maintenance tooling reach production only through `git push origin main`
and the automated image deployment. No local app or parallel test installation is
used. Necessary production recalculation requires a restricted coverage backup,
the supported sequential job service, and verification of area totals, states,
history, revision, and the deployed UI.
