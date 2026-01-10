"""Collection proxy and collection definitions module.

Provides CollectionProxy for lazy collection access and defines
all application collection proxies.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from motor.motor_asyncio import AsyncIOMotorCollection

from db.manager import db_manager


class CollectionProxy:
    """Proxy that always resolves the current collection from the db manager.

    This ensures that collection references remain valid even after
    connection pool changes or event loop changes.

    Example:
        trips = CollectionProxy("trips")
        # Use like a normal collection
        await trips.find_one({"_id": some_id})
    """

    def __init__(self, name: str) -> None:
        """Initialize the collection proxy.

        Args:
            name: Name of the MongoDB collection.
        """
        self._name = name

    @property
    def _collection(self) -> AsyncIOMotorCollection:
        """Get the actual collection from the db manager.

        Returns:
            The AsyncIOMotorCollection instance.
        """
        return db_manager.get_collection(self._name)

    @property
    def name(self) -> str:
        """Get the collection name.

        Returns:
            The collection name string.
        """
        return self._name

    def __getattr__(self, attr: str) -> Any:
        """Delegate attribute access to the underlying collection.

        Args:
            attr: Attribute name to access.

        Returns:
            The attribute value from the underlying collection.
        """
        return getattr(self._collection, attr)

    def __repr__(self) -> str:
        """Return string representation.

        Returns:
            String representation of the proxy.
        """
        return f"<CollectionProxy name={self._name}>"


def get_collection(name: str) -> CollectionProxy:
    """Create a collection proxy for the named collection.

    Args:
        name: Name of the MongoDB collection.

    Returns:
        A CollectionProxy instance.
    """
    return CollectionProxy(name)


# ============================================================================
# Application Collection Definitions
# ============================================================================

# Core trip collections
trips_collection = get_collection("trips")
matched_trips_collection = get_collection("matched_trips")
live_trips_collection = get_collection("live_trips")
archived_live_trips_collection = get_collection("archived_live_trips")

# Coverage collections
coverage_metadata_collection = get_collection("coverage_metadata")
streets_collection = get_collection("streets")
osm_data_collection = get_collection("osm_data")

# Places and visits
places_collection = get_collection("places")

# Task management
task_config_collection = get_collection("task_config")
task_history_collection = get_collection("task_history")
progress_collection = get_collection("progress_status")

# Routes
optimal_route_progress_collection = get_collection("optimal_route_progress")

# Gas tracking
gas_fillups_collection = get_collection("gas_fillups")
vehicles_collection = get_collection("vehicles")
app_settings_collection = get_collection("app_settings")
bouncie_credentials_collection = get_collection("bouncie_credentials")
server_logs_collection = get_collection("server_logs")
county_visited_cache_collection = get_collection("county_visited_cache")
county_topology_collection = get_collection("county_topology")
