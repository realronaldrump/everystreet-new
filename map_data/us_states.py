"""Static catalog of US states for map coverage selection."""

from __future__ import annotations

from typing import Final

US_STATES: Final[list[dict[str, object]]] = [
    {"code": "AL", "name": "Alabama", "geofabrik_id": "us/alabama", "size_mb": 240},
    {"code": "AK", "name": "Alaska", "geofabrik_id": "us/alaska", "size_mb": 420},
    {"code": "AZ", "name": "Arizona", "geofabrik_id": "us/arizona", "size_mb": 430},
    {"code": "AR", "name": "Arkansas", "geofabrik_id": "us/arkansas", "size_mb": 230},
    {
        "code": "CA",
        "name": "California",
        "geofabrik_id": "us/california",
        "size_mb": 1100,
    },
    {"code": "CO", "name": "Colorado", "geofabrik_id": "us/colorado", "size_mb": 420},
    {
        "code": "CT",
        "name": "Connecticut",
        "geofabrik_id": "us/connecticut",
        "size_mb": 150,
    },
    {"code": "DE", "name": "Delaware", "geofabrik_id": "us/delaware", "size_mb": 70},
    {"code": "FL", "name": "Florida", "geofabrik_id": "us/florida", "size_mb": 650},
    {"code": "GA", "name": "Georgia", "geofabrik_id": "us/georgia", "size_mb": 430},
    {"code": "HI", "name": "Hawaii", "geofabrik_id": "us/hawaii", "size_mb": 130},
    {"code": "ID", "name": "Idaho", "geofabrik_id": "us/idaho", "size_mb": 200},
    {"code": "IL", "name": "Illinois", "geofabrik_id": "us/illinois", "size_mb": 500},
    {"code": "IN", "name": "Indiana", "geofabrik_id": "us/indiana", "size_mb": 260},
    {"code": "IA", "name": "Iowa", "geofabrik_id": "us/iowa", "size_mb": 200},
    {"code": "KS", "name": "Kansas", "geofabrik_id": "us/kansas", "size_mb": 200},
    {"code": "KY", "name": "Kentucky", "geofabrik_id": "us/kentucky", "size_mb": 230},
    {"code": "LA", "name": "Louisiana", "geofabrik_id": "us/louisiana", "size_mb": 220},
    {"code": "ME", "name": "Maine", "geofabrik_id": "us/maine", "size_mb": 180},
    {"code": "MD", "name": "Maryland", "geofabrik_id": "us/maryland", "size_mb": 220},
    {
        "code": "MA",
        "name": "Massachusetts",
        "geofabrik_id": "us/massachusetts",
        "size_mb": 240,
    },
    {"code": "MI", "name": "Michigan", "geofabrik_id": "us/michigan", "size_mb": 420},
    {"code": "MN", "name": "Minnesota", "geofabrik_id": "us/minnesota", "size_mb": 350},
    {
        "code": "MS",
        "name": "Mississippi",
        "geofabrik_id": "us/mississippi",
        "size_mb": 180,
    },
    {"code": "MO", "name": "Missouri", "geofabrik_id": "us/missouri", "size_mb": 300},
    {"code": "MT", "name": "Montana", "geofabrik_id": "us/montana", "size_mb": 250},
    {"code": "NE", "name": "Nebraska", "geofabrik_id": "us/nebraska", "size_mb": 190},
    {"code": "NV", "name": "Nevada", "geofabrik_id": "us/nevada", "size_mb": 240},
    {
        "code": "NH",
        "name": "New Hampshire",
        "geofabrik_id": "us/new-hampshire",
        "size_mb": 130,
    },
    {
        "code": "NJ",
        "name": "New Jersey",
        "geofabrik_id": "us/new-jersey",
        "size_mb": 250,
    },
    {
        "code": "NM",
        "name": "New Mexico",
        "geofabrik_id": "us/new-mexico",
        "size_mb": 200,
    },
    {"code": "NY", "name": "New York", "geofabrik_id": "us/new-york", "size_mb": 500},
    {
        "code": "NC",
        "name": "North Carolina",
        "geofabrik_id": "us/north-carolina",
        "size_mb": 350,
    },
    {
        "code": "ND",
        "name": "North Dakota",
        "geofabrik_id": "us/north-dakota",
        "size_mb": 160,
    },
    {"code": "OH", "name": "Ohio", "geofabrik_id": "us/ohio", "size_mb": 370},
    {"code": "OK", "name": "Oklahoma", "geofabrik_id": "us/oklahoma", "size_mb": 250},
    {"code": "OR", "name": "Oregon", "geofabrik_id": "us/oregon", "size_mb": 300},
    {
        "code": "PA",
        "name": "Pennsylvania",
        "geofabrik_id": "us/pennsylvania",
        "size_mb": 450,
    },
    {
        "code": "RI",
        "name": "Rhode Island",
        "geofabrik_id": "us/rhode-island",
        "size_mb": 60,
    },
    {
        "code": "SC",
        "name": "South Carolina",
        "geofabrik_id": "us/south-carolina",
        "size_mb": 230,
    },
    {
        "code": "SD",
        "name": "South Dakota",
        "geofabrik_id": "us/south-dakota",
        "size_mb": 160,
    },
    {"code": "TN", "name": "Tennessee", "geofabrik_id": "us/tennessee", "size_mb": 300},
    {"code": "TX", "name": "Texas", "geofabrik_id": "us/texas", "size_mb": 900},
    {"code": "UT", "name": "Utah", "geofabrik_id": "us/utah", "size_mb": 250},
    {"code": "VT", "name": "Vermont", "geofabrik_id": "us/vermont", "size_mb": 90},
    {"code": "VA", "name": "Virginia", "geofabrik_id": "us/virginia", "size_mb": 300},
    {
        "code": "WA",
        "name": "Washington",
        "geofabrik_id": "us/washington",
        "size_mb": 350,
    },
    {
        "code": "WV",
        "name": "West Virginia",
        "geofabrik_id": "us/west-virginia",
        "size_mb": 150,
    },
    {"code": "WI", "name": "Wisconsin", "geofabrik_id": "us/wisconsin", "size_mb": 300},
    {"code": "WY", "name": "Wyoming", "geofabrik_id": "us/wyoming", "size_mb": 140},
]

REGIONS: Final[dict[str, list[str]]] = {
    "Northeast": ["CT", "ME", "MA", "NH", "NJ", "NY", "PA", "RI", "VT"],
    "Southeast": ["AL", "FL", "GA", "KY", "LA", "MS", "NC", "SC", "TN", "VA", "WV"],
    "Midwest": ["IL", "IN", "IA", "KS", "MI", "MN", "MO", "NE", "ND", "OH", "SD", "WI"],
    "Southwest": ["AZ", "NM", "OK", "TX"],
    "West": ["AK", "CA", "CO", "HI", "ID", "MT", "NV", "OR", "UT", "WA", "WY"],
}

STATE_INDEX: Final[dict[str, dict[str, object]]] = {
    state["code"]: state for state in US_STATES
}


def list_states() -> list[dict[str, object]]:
    return list(US_STATES)


def get_state(code: str) -> dict[str, object] | None:
    return STATE_INDEX.get(code.upper())


def total_size_mb(codes: list[str]) -> int:
    total = 0
    for code in codes:
        state = get_state(code)
        if state:
            total += int(state.get("size_mb") or 0)
    return total


def build_geofabrik_path(geofabrik_id: str) -> str:
    if geofabrik_id.startswith("north-america/"):
        return geofabrik_id
    return f"north-america/{geofabrik_id}"
