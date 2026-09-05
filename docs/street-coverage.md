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

Routing graphs encode legal direction separately from the physical coverage
inventory. Two-way roads have reverse traversal edges; coverage counts their
physical centerline once. Public-road filtering precedes topology simplification.

Maps request bounded viewport data. Street details include evidence and exact
remaining length. Journal summaries, paginated contributions, and segment metrics
are bounded read models. Reads do not repair data. Timelines use elapsed calendar
time; forecasts include inactive days and report pace scenarios.

Validation uses local existing JavaScript/lint tools and isolated mini-PC Python
and Mongo runtimes. No new packages, tools, or map extracts are downloaded.
Production changes require a restricted backup, validated replacement projections,
and verification of area totals, states, history, revision, and deployed UI.
