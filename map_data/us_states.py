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


# US State bounding boxes [min_lon, min_lat, max_lon, max_lat]
# These are approximate bounding boxes for quick point-in-state detection
US_STATE_BOUNDS: dict[str, tuple[float, float, float, float]] = {
    "AL": (-88.47, 30.22, -84.89, 35.01),
    "AK": (-179.15, 51.21, -129.98, 71.35),
    "AZ": (-114.81, 31.33, -109.05, 37.00),
    "AR": (-94.62, 33.00, -89.64, 36.50),
    "CA": (-124.41, 32.53, -114.13, 42.01),
    "CO": (-109.06, 36.99, -102.04, 41.00),
    "CT": (-73.73, 40.99, -71.79, 42.05),
    "DE": (-75.79, 38.45, -75.05, 39.84),
    "FL": (-87.63, 24.52, -80.03, 31.00),
    "GA": (-85.61, 30.36, -80.84, 35.00),
    "HI": (-160.24, 18.91, -154.81, 22.24),
    "ID": (-117.24, 41.99, -111.04, 49.00),
    "IL": (-91.51, 36.97, -87.50, 42.51),
    "IN": (-88.10, 37.77, -84.78, 41.76),
    "IA": (-96.64, 40.38, -90.14, 43.50),
    "KS": (-102.05, 36.99, -94.59, 40.00),
    "KY": (-89.57, 36.50, -81.96, 39.15),
    "LA": (-94.04, 28.93, -88.82, 33.02),
    "ME": (-71.08, 43.06, -66.95, 47.46),
    "MD": (-79.49, 37.91, -75.05, 39.72),
    "MA": (-73.51, 41.24, -69.93, 42.89),
    "MI": (-90.42, 41.70, -82.42, 48.19),
    "MN": (-97.24, 43.50, -89.49, 49.38),
    "MS": (-91.66, 30.17, -88.10, 35.00),
    "MO": (-95.77, 35.99, -89.10, 40.61),
    "MT": (-116.05, 44.36, -104.04, 49.00),
    "NE": (-104.05, 40.00, -95.31, 43.00),
    "NV": (-120.01, 35.00, -114.04, 42.00),
    "NH": (-72.56, 42.70, -70.71, 45.31),
    "NJ": (-75.56, 38.93, -73.89, 41.36),
    "NM": (-109.05, 31.33, -103.00, 37.00),
    "NY": (-79.76, 40.50, -71.86, 45.02),
    "NC": (-84.32, 33.84, -75.46, 36.59),
    "ND": (-104.05, 45.94, -96.55, 49.00),
    "OH": (-84.82, 38.40, -80.52, 42.00),
    "OK": (-103.00, 33.62, -94.43, 37.00),
    "OR": (-124.57, 41.99, -116.46, 46.29),
    "PA": (-80.52, 39.72, -74.69, 42.27),
    "RI": (-71.86, 41.15, -71.12, 42.02),
    "SC": (-83.35, 32.03, -78.54, 35.22),
    "SD": (-104.06, 42.48, -96.44, 45.95),
    "TN": (-90.31, 34.98, -81.65, 36.68),
    "TX": (-106.65, 25.84, -93.51, 36.50),
    "UT": (-114.05, 37.00, -109.04, 42.00),
    "VT": (-73.44, 42.73, -71.46, 45.02),
    "VA": (-83.68, 36.54, -75.24, 39.47),
    "WA": (-124.73, 45.54, -116.92, 49.00),
    "WV": (-82.64, 37.20, -77.72, 40.64),
    "WI": (-92.89, 42.49, -86.25, 47.08),
    "WY": (-111.05, 40.99, -104.05, 45.01),
}


def get_states_for_coordinate(lon: float, lat: float) -> set[str]:
    """
    Return all states whose bounding boxes include the coordinate.

    This is conservative (may include neighbor states near borders), but
    avoids missing coverage when bounding boxes overlap.
    """
    states: set[str] = set()
    for state_code, (min_lon, min_lat, max_lon, max_lat) in US_STATE_BOUNDS.items():
        if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
            states.add(state_code)
    return states
