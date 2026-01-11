"""Location schema utilities for geocoding responses."""

from typing import Any


def get_empty_location_schema() -> dict[str, Any]:
    """
    Get empty location schema structure.

    Returns:
        Empty location schema dictionary
    """
    return {
        "formatted_address": "",
        "address_components": {
            "street_number": "",
            "street": "",
            "city": "",
            "county": "",
            "state": "",
            "postal_code": "",
            "country": "",
        },
        "coordinates": {
            "lat": 0.0,
            "lng": 0.0,
        },
    }


def parse_mapbox_response(
    response: dict[str, Any],
    coordinates: list[float],
) -> dict[str, Any]:
    """
    Parse Mapbox geocoding response into structured location schema.

    Args:
        response: Raw Mapbox geocoding API response
        coordinates: [lon, lat] coordinates

    Returns:
        Structured location data
    """
    structured = get_empty_location_schema()
    structured["coordinates"]["lng"] = coordinates[0]
    structured["coordinates"]["lat"] = coordinates[1]
    structured["formatted_address"] = response.get("place_name", "")

    for ctx in response.get("context", []):
        if "id" in ctx:
            if ctx["id"].startswith("postcode"):
                structured["address_components"]["postal_code"] = ctx.get("text", "")
            elif ctx["id"].startswith("place"):
                structured["address_components"]["city"] = ctx.get("text", "")
            elif ctx["id"].startswith("region"):
                structured["address_components"]["state"] = ctx.get("text", "")
            elif ctx["id"].startswith("country"):
                structured["address_components"]["country"] = ctx.get("text", "")

    if "text" in response:
        structured["address_components"]["street"] = response.get("text", "")
    if "address" in response:
        structured["address_components"]["street_number"] = response.get("address", "")

    return structured


def parse_nominatim_response(
    response: dict[str, Any],
    coordinates: list[float],
) -> dict[str, Any]:
    """
    Parse Nominatim geocoding response into structured location schema.

    Args:
        response: Raw Nominatim geocoding API response
        coordinates: [lon, lat] coordinates

    Returns:
        Structured location data
    """
    structured = get_empty_location_schema()
    structured["coordinates"]["lng"] = coordinates[0]
    structured["coordinates"]["lat"] = coordinates[1]
    structured["formatted_address"] = response.get("display_name", "")

    if "address" in response:
        addr = response["address"]
        component_mapping = {
            "house_number": "street_number",
            "road": "street",
            "city": "city",
            "town": "city",
            "village": "city",
            "county": "county",
            "state": "state",
            "postcode": "postal_code",
            "country": "country",
        }

        for nominatim_key, our_key in component_mapping.items():
            if nominatim_key in addr:
                structured["address_components"][our_key] = addr[nominatim_key]

    return structured
