import pytest
from fastapi import HTTPException

from trips.models import MapMatchJobRequest
from trips.services.map_matching_jobs import MapMatchingJobRunner, MapMatchingJobService


def test_normalize_request_requires_trip_id() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(mode="trip_id")
    with pytest.raises(HTTPException):
        service._normalize_request(request)


def test_normalize_request_requires_trip_ids() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(mode="trip_ids")
    with pytest.raises(HTTPException):
        service._normalize_request(request)


def test_normalize_request_requires_date_range() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(mode="date_range")
    with pytest.raises(HTTPException):
        service._normalize_request(request)


def test_normalize_request_rematch_clears_unmatched_only() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(
        mode="date_range",
        start_date="2024-01-01",
        end_date="2024-01-02",
        unmatched_only=True,
        rematch=True,
    )
    normalized = service._normalize_request(request)
    assert normalized.unmatched_only is False


def test_build_query_unmatched_sets_filter() -> None:
    request = MapMatchJobRequest(mode="unmatched")
    query = MapMatchingJobRunner._build_query(request)
    assert query.get("matchedGps") is None
