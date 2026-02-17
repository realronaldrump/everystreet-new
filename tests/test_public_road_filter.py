from __future__ import annotations

import time

from street_coverage.public_road_filter import (
    MODE_STRICT,
    TRACK_CONDITIONAL,
    classify_public_road,
)


def test_classify_includes_public_residential() -> None:
    decision = classify_public_road({"highway": "residential"})
    assert decision.include is True
    assert decision.reason_code == "include_public_drivable"


def test_classify_excludes_non_driveable_way() -> None:
    decision = classify_public_road({"highway": "footway"})
    assert decision.include is False
    assert decision.reason_code == "exclude_not_driveable_highway"


def test_classify_excludes_private_access() -> None:
    decision = classify_public_road({"highway": "residential", "access": "private"})
    assert decision.include is False
    assert decision.reason_code == "exclude_hard_restriction"


def test_classify_excludes_parking_aisle_and_alley() -> None:
    parking = classify_public_road(
        {"highway": "service", "service": "parking_aisle"},
    )
    alley = classify_public_road({"highway": "service", "service": "alley"})

    assert parking.include is False
    assert parking.reason_code == "exclude_service_subtype"
    assert alley.include is False
    assert alley.reason_code == "exclude_service_subtype"


def test_classify_track_conditional() -> None:
    included = classify_public_road(
        {"highway": "track", "motor_vehicle": "yes"},
        track_policy=TRACK_CONDITIONAL,
    )
    excluded = classify_public_road(
        {"highway": "track"},
        track_policy=TRACK_CONDITIONAL,
    )

    assert included.include is True
    assert included.reason_code == "include_track_public_access"
    assert excluded.include is False
    assert excluded.reason_code == "exclude_track_unverified"


def test_classify_ambiguous_access_defaults_to_include() -> None:
    destination = classify_public_road({"highway": "residential", "access": "destination"})
    conditional = classify_public_road(
        {
            "highway": "residential",
            "access:conditional": "yes @ (Mo-Fr 08:00-17:00)",
        },
    )

    assert destination.include is True
    assert destination.ambiguous is True
    assert destination.reason_code == "include_ambiguous_access"

    assert conditional.include is True
    assert conditional.ambiguous is True
    assert conditional.reason_code == "include_ambiguous_access"


def test_classify_ambiguous_access_strict_mode_excludes() -> None:
    decision = classify_public_road(
        {"highway": "residential", "access": "destination"},
        mode=MODE_STRICT,
    )
    assert decision.include is False
    assert decision.reason_code == "exclude_ambiguous_access_strict"


def test_classifier_performance_guard() -> None:
    tags = [
        {"highway": "residential", "access": "destination"},
        {"highway": "service", "service": "parking_aisle"},
        {"highway": "track", "motor_vehicle": "yes"},
        {"highway": "residential", "access": "private"},
    ]

    start = time.perf_counter()
    decisions = [
        classify_public_road(tags[idx % len(tags)])
        for idx in range(20000)
    ]
    elapsed = time.perf_counter() - start

    assert len(decisions) == 20000
    # Guard against pathological slowdowns without making CI timing fragile.
    assert elapsed < 10.0
