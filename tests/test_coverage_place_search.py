from __future__ import annotations

import pytest

from street_coverage.place_search import (
    describe_area,
    find_area_candidates,
    parse_place_query,
)


def _road(display_name: str, address: dict) -> dict:
    return {
        "display_name": display_name,
        "osm_id": abs(hash(display_name)) % 100_000,
        "osm_type": "way",
        "class": "highway",
        "type": "primary",
        "addresstype": "road",
        "place_rank": 26,
        "address": address,
    }


def _county(display_name: str, osm_id: int, address: dict) -> dict:
    return {
        "display_name": display_name,
        "name": display_name.split(",", maxsplit=1)[0],
        "osm_id": osm_id,
        "osm_type": "relation",
        "class": "boundary",
        "type": "administrative",
        "addresstype": "county",
        "place_rank": 12,
        "address": address,
    }


def _fake_search(results_by_text: dict[str, list[dict]]):
    calls: list[str] = []

    async def search(text: str) -> list[dict]:
        calls.append(text)
        return results_by_text.get(text, [])

    return search, calls


@pytest.mark.parametrize(
    ("raw", "kind", "text", "name", "state"),
    [
        (
            "Garfield county CO",
            "county",
            "Garfield county CO",
            "Garfield county",
            "Colorado",
        ),
        (
            "Garfield County, CO",
            "county",
            "Garfield County, CO",
            "Garfield County",
            "Colorado",
        ),
        ("Garfield Co", "county", "Garfield County", "Garfield County", None),
        ("Waco TX", "city", "Waco TX", "Waco", "Texas"),
        ("Waco, Texas, USA", "city", "Waco, Texas", "Waco", "Texas"),
        (
            "Kansas City Missouri",
            "city",
            "Kansas City Missouri",
            "Kansas City",
            "Missouri",
        ),
        ("West Virginia", "state", "West Virginia", "West Virginia", None),
        ("New York", "city", "New York", "New York", None),
        ("Waco", "city", "Waco", "Waco", None),
    ],
)
def test_parse_place_query_splits_name_and_state(raw, kind, text, name, state) -> None:
    query = parse_place_query(raw, kind)
    assert (query.text, query.name, query.state) == (text, name, state)


@pytest.mark.asyncio
async def test_finds_county_when_local_map_lacks_the_state_name() -> None:
    # A map built from trip corridors can hold Garfield County, Colorado
    # without the Colorado boundary, so nothing there mentions "Colorado".
    colorado_county = _county(
        "Garfield County, United States",
        1411343,
        {"county": "Garfield County", "country": "United States"},
    )
    oklahoma_county = _county(
        "Garfield County, Oklahoma, United States",
        1729,
        {"county": "Garfield County", "state": "Oklahoma"},
    )
    search, calls = _fake_search(
        {
            "Garfield county CO": [
                _road(
                    "CO 82, Cardiff, Garfield County, United States",
                    {"road": "CO 82", "county": "Garfield County"},
                ),
            ],
            "Garfield county": [oklahoma_county, colorado_county],
        },
    )

    found = await find_area_candidates(search, "Garfield county CO", "county", limit=8)

    assert calls == [
        "Garfield county CO",
        "Garfield county, Colorado",
        "Garfield county",
    ]
    assert found.kind == "county"
    assert [c["osm_id"] for c in found.candidates] == [1411343]
    assert found.note is None


@pytest.mark.asyncio
async def test_typing_county_searches_counties_even_when_city_is_selected() -> None:
    search, _calls = _fake_search(
        {
            "Garfield County": [
                {
                    "display_name": "Cardiff, Garfield County, Colorado, United States",
                    "name": "Cardiff",
                    "osm_id": 5,
                    "osm_type": "node",
                    "class": "place",
                    "type": "hamlet",
                    "addresstype": "hamlet",
                    "place_rank": 20,
                },
                _county(
                    "Garfield County, Colorado, United States",
                    1411343,
                    {"state": "Colorado"},
                ),
            ],
        },
    )

    found = await find_area_candidates(search, "Garfield County", "city", limit=8)

    assert found.kind == "county"
    assert [c["name"] for c in found.candidates] == ["Garfield County"]


@pytest.mark.asyncio
async def test_other_kinds_are_listed_with_a_note_when_none_match() -> None:
    search, _calls = _fake_search(
        {"Waco": [_county("Waco County, Texas, United States", 1, {"state": "Texas"})]},
    )

    found = await find_area_candidates(search, "Waco", "state", limit=8)

    assert [c["kind"] for c in found.candidates] == ["county"]
    assert found.note is not None
    assert "No states found" in found.note


@pytest.mark.asyncio
async def test_typed_text_matches_are_not_dropped_for_a_misread_state() -> None:
    # "Mount Washington" ends in a state name but names a town in Kentucky.
    town = {
        "display_name": "Mount Washington, Bullitt County, Kentucky, United States",
        "name": "Mount Washington",
        "osm_id": 7,
        "osm_type": "relation",
        "class": "boundary",
        "type": "administrative",
        "addresstype": "city",
        "place_rank": 16,
        "address": {"state": "Kentucky"},
    }
    search, calls = _fake_search({"Mount Washington": [town]})

    found = await find_area_candidates(search, "Mount Washington", "city", limit=8)

    assert calls == ["Mount Washington"]
    assert [c["osm_id"] for c in found.candidates] == [7]


@pytest.mark.asyncio
async def test_point_only_places_follow_mapped_boundaries() -> None:
    point = {
        "display_name": "Waco, Stark County, Ohio, United States",
        "name": "Waco",
        "osm_id": 1,
        "osm_type": "node",
        "class": "place",
        "type": "hamlet",
        "place_rank": 20,
    }
    city = {
        "display_name": "Waco, McLennan County, Texas, United States",
        "name": "Waco",
        "osm_id": 2,
        "osm_type": "relation",
        "class": "boundary",
        "type": "administrative",
        "addresstype": "city",
        "place_rank": 16,
    }
    search, _calls = _fake_search({"Waco": [point, city, dict(city)]})

    found = await find_area_candidates(search, "Waco", "city", limit=8)

    assert [c["osm_id"] for c in found.candidates] == [2, 1]
    assert [c["has_boundary"] for c in found.candidates] == [True, False]
    assert found.candidates[0]["context"] == "McLennan County, Texas"


def test_google_results_are_classified_by_place_type() -> None:
    county = {
        "display_name": "Garfield County, CO, USA",
        "name": "Garfield County",
        "osm_id": "ChIJ-county",
        "osm_type": "google_place",
        "type": "administrative_area_level_2",
        "class": "place",
    }
    route = {**county, "osm_id": "ChIJ-road", "type": "route"}

    described = describe_area(county, "county")

    assert described is not None
    assert described["kind"] == "county"
    assert described["state"] == "Colorado"
    assert describe_area(route, "county") is None
