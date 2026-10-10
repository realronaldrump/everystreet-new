"""
Find coverage-area candidates (cities, counties, states) for a typed place.

The geocoder is asked for places only, never roads or buildings. Each result
is classified by kind, the list is narrowed to the kind and US state the user
asked for, and duplicates are dropped so the Add Area form lists real areas.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from map_data.us_states import US_STATES, get_state, get_states_for_coordinate

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    SearchFn = Callable[[str], Awaitable[list[dict[str, Any]]]]

AREA_KINDS: tuple[str, ...] = ("city", "county", "state")

# Nominatim featureType limiting a search to states, counties, cities, towns,
# villages and hamlets (address ranks 8-20), which excludes roads.
AREA_FEATURE_TYPE = "settlement"

# Nominatim allows up to 40; same-named places elsewhere must not crowd out
# the one asked for.
SEARCH_RESULT_LIMIT = 25

_KIND_PLURALS = {"city": "cities or towns", "county": "counties", "state": "states"}

_STATE_NAMES = {str(state["name"]).lower(): str(state["name"]) for state in US_STATES}
_STATE_NAME_WORD_COUNTS = sorted(
    {len(name.split()) for name in _STATE_NAMES},
    reverse=True,
)
_COUNTRY_NAMES = {
    "us",
    "usa",
    "u.s.",
    "u.s.a.",
    "united states",
    "united states of america",
}
_COUNTY_WORDS = {"county", "parish", "borough"}
_COUNTY_ABBREVIATIONS = {"co", "co."}

# Nominatim addresstype (or place type) -> kind of area.
_NOMINATIM_KINDS = {
    "state": "state",
    "province": "state",
    "county": "county",
    "state_district": "county",
    "city": "city",
    "town": "city",
    "village": "city",
    "hamlet": "city",
    "municipality": "city",
    "borough": "city",
    "suburb": "city",
    "quarter": "city",
    "neighbourhood": "city",
    "city_district": "city",
}
_NOMINATIM_LABELS = {
    "neighbourhood": "Neighborhood",
    "state_district": "District",
    "city_district": "District",
}
_GOOGLE_KINDS = {
    "administrative_area_level_1": "state",
    "administrative_area_level_2": "county",
    "locality": "city",
    "postal_town": "city",
    "sublocality": "city",
    "sublocality_level_1": "city",
    "neighborhood": "city",
}
_KIND_LABELS = {"city": "City", "county": "County", "state": "State"}


@dataclass(frozen=True)
class PlaceQuery:
    """A typed place split into its name and an optional US state."""

    text: str
    name: str
    state: str | None = None
    # A state after a comma or as a postal code ("Waco, Texas", "Waco TX") is
    # certain; a trailing state name may be part of the place ("Mount
    # Washington"), so places elsewhere are listed after, not dropped.
    explicit_state: bool = False

    def fallback_texts(self) -> list[str]:
        """
        Searches to try when the typed text finds no area of the asked kind.

        The state is spelled out, then dropped entirely: a map built from
        trip corridors may lack the state boundary, so a county there carries
        no state name to match.
        """
        if not self.state:
            return []
        texts: list[str] = []
        for text in (f"{self.name}, {self.state}", self.name):
            if text.lower() != self.text.lower() and text not in texts:
                texts.append(text)
        return texts


def normalize_area_kind(value: str | None) -> str:
    kind = str(value or "").strip().lower()
    return kind if kind in AREA_KINDS else "city"


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def resolve_area_kind(location: str, area_type: str | None) -> str:
    """Typed text that names a county ("Garfield County") asks for a county."""
    if any(word in _COUNTY_WORDS for word in _words(location)):
        return "county"
    return normalize_area_kind(area_type)


def _state_from_code(code: str) -> str | None:
    info = get_state(code) if len(code) == 2 and code.isalpha() else None
    return str(info["name"]) if info else None


def _state_from_word(word: str, kind: str, name_words: list[str]) -> str | None:
    """Return the state a trailing two-letter code names, if it names one."""
    # "Garfield Co" asked as a county means Garfield County, not Colorado.
    if (
        word.lower() in _COUNTY_ABBREVIATIONS
        and word != word.upper()
        and kind == "county"
        and not any(w.lower() in _COUNTY_WORDS for w in name_words)
    ):
        return None
    return _state_from_code(word)


def _split_trailing_state(
    words: list[str],
    kind: str,
) -> tuple[list[str], list[str], str | None]:
    """Split words into (name words, state words as typed, state name)."""
    if " ".join(words).lower() in _STATE_NAMES:
        # The whole text is a state ("West Virginia"), not a qualifier.
        return words, [], None
    for size in _STATE_NAME_WORD_COUNTS:
        if len(words) <= size:
            continue
        tail = " ".join(words[-size:]).lower()
        if tail in _STATE_NAMES:
            return words[:-size], words[-size:], _STATE_NAMES[tail]
    if len(words) > 1:
        state = _state_from_word(words[-1], kind, words[:-1])
        if state:
            return words[:-1], words[-1:], state
    return words, [], None


def _expand_county_abbreviation(words: list[str], kind: str) -> list[str]:
    if kind != "county" or any(w.lower() in _COUNTY_WORDS for w in words):
        return words
    return [
        "County" if index > 0 and word.lower() in _COUNTY_ABBREVIATIONS else word
        for index, word in enumerate(words)
    ]


def parse_place_query(raw: str, kind: str) -> PlaceQuery:
    """Split typed text such as "Garfield county CO" into name and state."""
    kind = normalize_area_kind(kind)
    parts = [part.strip() for part in " ".join(str(raw or "").split()).split(",")]
    parts = [part for part in parts if part]
    while len(parts) > 1 and parts[-1].lower() in _COUNTRY_NAMES:
        parts.pop()
    if not parts:
        return PlaceQuery(text="", name="")

    state: str | None = None
    state_suffix = ""
    explicit = False
    if len(parts) > 1:
        last = parts[-1]
        state = _STATE_NAMES.get(last.lower()) or _state_from_code(last)
        if state:
            state_suffix = f", {last}"
            explicit = True
            parts = parts[:-1]

    last_words = parts[-1].split()
    if state is None:
        last_words, state_words, state = _split_trailing_state(last_words, kind)
        if state:
            state_suffix = " " + " ".join(state_words)
            explicit = len(state_words) == 1 and len(state_words[0]) == 2
    last_words = _expand_county_abbreviation(last_words, kind)
    name = ", ".join([*parts[:-1], " ".join(last_words)])
    # The first search keeps the state as typed ("Waco TX", "Waco, Texas").
    return PlaceQuery(
        text=f"{name}{state_suffix}",
        name=name,
        state=state,
        explicit_state=explicit,
    )


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def parse_bounding_box(raw_bbox: Any) -> list[float] | None:
    """Convert a Nominatim [south, north, west, east] box to [west, south, east, north]."""
    if not isinstance(raw_bbox, list) or len(raw_bbox) != 4:
        return None
    try:
        south, north, west, east = map(float, raw_bbox)
    except (TypeError, ValueError):
        return None
    return [west, south, east, north]


def _classify(result: dict[str, Any]) -> tuple[str, str] | None:
    """Return (kind, label) for a place result, or None when it is not an area."""
    result_type = _clean_text(result.get("type")).lower()
    if _clean_text(result.get("osm_type")).lower() == "google_place":
        kind = _GOOGLE_KINDS.get(result_type)
        return (kind, _KIND_LABELS[kind]) if kind else None

    result_class = _clean_text(result.get("class") or result.get("category")).lower()
    if result_class not in {"boundary", "place"}:
        return None

    candidates = [_clean_text(result.get("addresstype")).lower()]
    if result_class == "place":
        candidates.append(result_type)
    for value in candidates:
        kind = _NOMINATIM_KINDS.get(value)
        if kind:
            label = _NOMINATIM_LABELS.get(value, value.replace("_", " ").title())
            return kind, label

    try:
        rank = int(result.get("place_rank") or 0)
    except (TypeError, ValueError):
        rank = 0
    if 5 <= rank <= 9:
        kind = "state"
    elif 10 <= rank <= 12:
        kind = "county"
    elif 13 <= rank <= 22:
        kind = "city"
    else:
        return None
    return kind, _KIND_LABELS[kind]


def _state_in_text(part: str) -> str | None:
    if part.lower() in _STATE_NAMES:
        return _STATE_NAMES[part.lower()]
    # Google writes the state as a code, sometimes followed by a ZIP code.
    code, _, zip_code = part.partition(" ")
    if code.isupper() and (not zip_code or zip_code.replace("-", "").isdigit()):
        return _state_from_code(code)
    return None


def _named_state(result: dict[str, Any], kind: str, name: str) -> str | None:
    """The state a result's own address or name gives, if any."""
    address = result.get("address")
    if isinstance(address, dict):
        state = _clean_text(address.get("state"))
        if state:
            return state
        iso = _clean_text(address.get("ISO3166-2-lvl4")).upper()
        if iso.startswith("US-") and get_state(iso[3:]):
            return str(get_state(iso[3:])["name"])
    if kind == "state":
        return _STATE_NAMES.get(name.lower(), name)
    parts = _clean_text(result.get("display_name")).split(",")[1:]
    for part in parts:
        state = _state_in_text(part.strip())
        if state:
            return state
    return None


def _result_point(result: dict[str, Any]) -> tuple[float, float] | None:
    try:
        return float(result["lon"]), float(result["lat"])
    except (KeyError, TypeError, ValueError):
        pass
    bbox = parse_bounding_box(result.get("boundingbox"))
    if bbox:
        return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    return None


def _result_states(result: dict[str, Any], kind: str, name: str) -> list[str]:
    """
    Every US state a result may lie in.

    A map built from trip corridors can lack a state's boundary, leaving
    places there with no state in their address. Their location still says
    which state they are in (or, near a border, which few).
    """
    named = _named_state(result, kind, name)
    if named:
        return [named]
    point = _result_point(result)
    if point is None:
        return []
    return sorted(
        str(get_state(code)["name"])
        for code in get_states_for_coordinate(*point)
        if get_state(code)
    )


def describe_area(result: dict[str, Any], kind: str) -> dict[str, Any] | None:
    """Describe one geocoder result as an area candidate, or None to drop it."""
    display_name = _clean_text(result.get("display_name") or result.get("name"))
    osm_id = result.get("osm_id")
    osm_type = _clean_text(result.get("osm_type"))
    if not display_name or osm_id is None or not osm_type:
        return None
    classified = _classify(result)
    if classified is None:
        return None
    area_kind, kind_label = classified

    parts = [part.strip() for part in display_name.split(",") if part.strip()]
    name = _clean_text(result.get("name")) or parts[0]
    if parts and parts[0].lower() == name.lower():
        parts = parts[1:]
    # Drop postcodes and the country; name the state even when the address
    # lacks it, so same-named places in different states are told apart.
    parts = [p for p in parts if not p.replace("-", "").replace(" ", "").isdigit()]
    context = [p for p in parts if p.lower() not in _COUNTRY_NAMES]
    states = _result_states(result, area_kind, name)
    named_in_context = {_state_in_text(part) for part in context}
    if area_kind != "state" and states and not named_in_context & set(states):
        context.append(" or ".join(states))
    context = context or parts

    return {
        "display_name": display_name,
        "label": ", ".join([name, *context]),
        "name": name,
        "context": ", ".join(context),
        "kind": area_kind,
        "kind_label": kind_label,
        "type_match": area_kind == kind,
        "has_boundary": osm_type.lower() not in {"node", "n"},
        "state": states[0] if len(states) == 1 else None,
        "states": states,
        "osm_id": osm_id,
        "osm_type": osm_type,
        "type": result.get("type"),
        "class": result.get("class") or result.get("category"),
        "address": result.get("address") or {},
        "importance": result.get("importance"),
        "bounding_box": parse_bounding_box(result.get("boundingbox")),
    }


def _same_state(candidate: dict[str, Any], state: str) -> bool | None:
    """Whether a candidate may lie in ``state``; None when nothing says."""
    states = candidate.get("states") or []
    if not states:
        return None
    return state.lower() in {known.lower() for known in states}


def rank_area_candidates(
    candidates: list[dict[str, Any]],
    *,
    kind: str,
    query: PlaceQuery,
    limit: int,
) -> tuple[list[dict[str, Any]], str | None]:
    """Keep areas of the asked kind (others only when none match), best first."""
    matches = [candidate for candidate in candidates if candidate["type_match"]]
    chosen = matches or candidates
    query_words = {w for w in _words(query.name) if w not in _COUNTY_WORDS}

    def sort_key(candidate: dict[str, Any]) -> tuple[int, int, int]:
        # Places named like the query come before places merely inside one.
        name_rank = 0 if query_words <= set(_words(candidate["name"])) else 1
        state_rank = 1
        if query.state:
            same = candidate["state_match"]
            state_rank = 0 if same else (1 if same is None else 2)
        return name_rank, state_rank, 0 if candidate["has_boundary"] else 1

    for candidate in chosen:
        candidate["state_match"] = (
            _same_state(candidate, query.state) if query.state else None
        )

    ranked: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for candidate in sorted(chosen, key=sort_key):
        # The label names the state, so same-named places in different states
        # stay apart even when their addresses read the same.
        key = candidate["label"].lower()
        if key in seen_names:
            continue
        seen_names.add(key)
        ranked.append(candidate)

    note = None
    if ranked and not matches:
        note = (
            f"No {_KIND_PLURALS[kind]} found for “{query.name}”. "
            "These are other places with that name."
        )
    return ranked[:limit], note


@dataclass(frozen=True)
class AreaSearchResult:
    """Areas found for a typed place, best first."""

    kind: str
    candidates: list[dict[str, Any]]
    note: str | None = None


async def find_area_candidates(
    search: SearchFn,
    location: str,
    area_type: str | None,
    *,
    limit: int,
) -> AreaSearchResult:
    """
    Search for areas matching typed text, narrowed to the asked kind and state.

    ``search`` runs one geocoder search for a text and returns raw results.
    """
    kind = resolve_area_kind(location, area_type)
    query = parse_place_query(location, kind)
    if not query.text:
        return AreaSearchResult(kind=kind, candidates=[])

    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(results: list[dict[str, Any]], *, state: str | None = None) -> None:
        for result in results:
            candidate = describe_area(result, kind)
            if candidate is None:
                continue
            key = (candidate["osm_type"].lower(), str(candidate["osm_id"]))
            if key in seen:
                continue
            if state and _same_state(candidate, state) is False:
                continue
            seen.add(key)
            candidates.append(candidate)

    add(await search(query.text), state=query.state if query.explicit_state else None)
    fallback_texts = query.fallback_texts()
    if fallback_texts and not any(c["type_match"] for c in candidates):
        for results in await asyncio.gather(*(search(t) for t in fallback_texts)):
            add(results, state=query.state)

    ranked, note = rank_area_candidates(
        candidates,
        kind=kind,
        query=query,
        limit=limit,
    )
    return AreaSearchResult(kind=kind, candidates=ranked, note=note)
