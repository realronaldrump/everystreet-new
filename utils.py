# utils.py
import requests


def validate_location_osm(location, location_type):
    """
    Use OSM Nominatim to see if location is valid. Return the first match or None.
    """
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": location_type
    }
    headers = {"User-Agent": "EveryStreet-Validator/1.0"}
    response = requests.get(
        "https://nominatim.openstreetmap.org/search", params=params, headers=headers)
    if response.status_code == 200:
        data = response.json()
        return data[0] if data else None
    return None
