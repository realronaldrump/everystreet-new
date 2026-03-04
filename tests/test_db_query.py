import json

from starlette.requests import Request

from core.trip_query_spec import TripQuerySpec


def test_build_calendar_date_expr_returns_none_for_empty() -> None:
    assert TripQuerySpec.build_calendar_date_expr(None, None) is None


def test_build_calendar_date_expr_includes_bounds() -> None:
    expr = TripQuerySpec.build_calendar_date_expr("2024-01-01", "2024-01-02")
    assert expr is not None
    assert "$and" in expr
    assert len(expr["$and"]) == 2


def test_build_calendar_date_expr_prefers_trip_timezone_fields() -> None:
    expr = TripQuerySpec.build_calendar_date_expr("2024-01-01", "2024-01-01")
    assert expr is not None
    encoded = json.dumps(expr, sort_keys=True)

    # Canonical trip documents use `startTimeZone`.
    assert "$startTimeZone" in encoded

    # Offset normalization is required for sources that send "-0700" style offsets.
    assert "^[+-][0-9]{4}$" in encoded
    assert "$substrBytes" in encoded


def test_build_calendar_date_expr_uses_end_timezone_for_end_time_field() -> None:
    expr = TripQuerySpec.build_calendar_date_expr(
        "2024-01-01",
        "2024-01-01",
        date_field="endTime",
    )
    assert expr is not None
    encoded = json.dumps(expr, sort_keys=True)
    assert "$endTimeZone" in encoded


def test_build_query_from_request() -> None:
    scope = {
        "type": "http",
        "query_string": b"start_date=2024-01-01&end_date=2024-01-02&imei=abc",
    }
    request = Request(scope)

    query = TripQuerySpec.from_request(request, include_invalid=True).to_mongo_query(
        extra_filters={"status": "ok"},
        enforce_source=True,
    )

    assert "$expr" in query
    assert query["imei"] == "abc"
    assert query["status"] == "ok"
    assert query["source"] == "bouncie"


def test_build_query_from_request_skips_imei() -> None:
    scope = {"type": "http", "query_string": b"imei=abc"}
    request = Request(scope)

    query = TripQuerySpec.from_request(
        request,
        include_imei=False,
        include_invalid=True,
    ).to_mongo_query(enforce_source=True)
    assert "imei" not in query
    assert query["source"] == "bouncie"
