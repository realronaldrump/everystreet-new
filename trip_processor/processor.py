"""
Trip Processor Module.

Main orchestrator class that coordinates trip processing through all
stages.
"""

import logging
from typing import Any

from external_geo_service import GeocodingService, MapMatchingService
from trip_processor.basic_processing import TripBasicProcessor
from trip_processor.geocoding import TripGeocoder
from trip_processor.map_matching import TripMapMatcher
from trip_processor.state import TripState, TripStateMachine
from trip_processor.validators import TripValidator
from trip_repository import TripRepository

logger = logging.getLogger(__name__)


class TripProcessor:
    """
    Orchestrates trip processing including validation, geocoding, and map matching.

    Uses a state machine approach to track processing status and
    delegates to specialized services for external API calls and
    database persistence.
    """

    def __init__(
        self,
        mapbox_token: str | None = None,
        source: str = "api",
        geocoding_service: GeocodingService | None = None,
        map_matching_service: MapMatchingService | None = None,
        repository: TripRepository | None = None,
    ) -> None:
        """
        Initialize the trip processor.

        Args:
            mapbox_token: The Mapbox access token for map matching and geocoding
            source: Source of the trip data (api, upload, upload_gpx, bouncie, etc.)
            geocoding_service: Optional geocoding service instance (for testing/DI)
            map_matching_service: Optional map matching service instance (for testing/DI)
            repository: Optional TripRepository instance (for testing/DI)
        """
        self.source = source
        self.mapbox_token = mapbox_token

        # Injected dependencies (lazy-initialize if not provided)
        self._geocoding_service = geocoding_service
        self._map_matching_service = map_matching_service
        self._repository = repository

        # State machine
        self._state_machine = TripStateMachine()

        # Processing components
        self._basic_processor = TripBasicProcessor()
        self._geocoder: TripGeocoder | None = None
        self._map_matcher: TripMapMatcher | None = None

        # Trip data
        self.trip_data: dict[str, Any] = {}
        self.processed_data: dict[str, Any] = {}

    @property
    def state(self) -> TripState:
        """Get the current processing state."""
        return self._state_machine.state

    @property
    def state_history(self) -> list[dict[str, Any]]:
        """Get the state transition history."""
        return self._state_machine.state_history

    @property
    def errors(self) -> dict[str, str]:
        """Get any errors that occurred during processing."""
        return self._state_machine.errors

    @property
    def geocoding_service(self) -> GeocodingService:
        """Lazy-initialize geocoding service."""
        if self._geocoding_service is None:
            self._geocoding_service = GeocodingService(self.mapbox_token)
        return self._geocoding_service

    @property
    def map_matching_service(self) -> MapMatchingService:
        """Lazy-initialize map matching service."""
        if self._map_matching_service is None:
            self._map_matching_service = MapMatchingService(self.mapbox_token)
        return self._map_matching_service

    @property
    def repository(self) -> TripRepository:
        """Lazy-initialize repository."""
        if self._repository is None:
            self._repository = TripRepository()
        return self._repository

    @property
    def geocoder(self) -> TripGeocoder:
        """Lazy-initialize geocoder."""
        if self._geocoder is None:
            self._geocoder = TripGeocoder(self.geocoding_service)
        return self._geocoder

    @property
    def map_matcher(self) -> TripMapMatcher:
        """Lazy-initialize map matcher."""
        if self._map_matcher is None:
            self._map_matcher = TripMapMatcher(self.map_matching_service)
        return self._map_matcher

    def _set_state(
        self,
        new_state: TripState,
        error: str | None = None,
    ) -> None:
        """
        Update the processing state and record it in history.

        Args:
            new_state: The new state to set
            error: Optional error message if transitioning to FAILED state
        """
        self._state_machine.set_state(new_state, error)

    def set_trip_data(self, trip_data: dict[str, Any]) -> None:
        """
        Set the raw trip data to be processed.

        Args:
            trip_data: The raw trip data dictionary
        """
        self.trip_data = trip_data
        self.processed_data = trip_data.copy()
        self._state_machine.reset()
        self._set_state(TripState.NEW)

    def get_processing_status(self) -> dict[str, Any]:
        """
        Get the current processing status.

        Returns:
            Dict with current state, history, and any errors
        """
        return self._state_machine.get_status(
            self.trip_data.get("transactionId", "unknown"),
        )

    async def process(self, do_map_match: bool = True) -> dict[str, Any]:
        """
        Process the trip through all appropriate stages based on current state.

        Args:
            do_map_match: Whether to perform map matching

        Returns:
            The processed trip data
        """
        if not self.trip_data:
            self._set_state(TripState.FAILED, "No trip data provided")
            return {}

        try:
            await self.validate()
            if self._state_machine.is_failed():
                return {}

            await self.process_basic()
            if self._state_machine.is_failed():
                return {}

            await self.geocode()
            if self._state_machine.is_failed():
                return {}

            if do_map_match:
                await self.map_match()

            if not self._state_machine.is_failed():
                self._set_state(TripState.COMPLETED)

            return self.processed_data

        except Exception as e:
            error_message = f"Unexpected error: {e!s}"
            logger.exception(
                "Error processing trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return {}

    async def validate(self) -> bool:
        """
        Validate the trip data using Pydantic model.

        Returns:
            True if validation passed, False otherwise
        """
        success, self.processed_data = await TripValidator.validate(
            self.trip_data,
            self._state_machine,
        )
        return success

    async def process_basic(self) -> bool:
        """
        Perform basic processing on trip data (timestamps, GPS parsing, etc.).

        Returns:
            True if processing succeeded, False otherwise
        """
        if self.state != TripState.VALIDATED:
            if self.state == TripState.NEW:
                await self.validate()
                if self.state != TripState.VALIDATED:
                    return False
            else:
                logger.warning(
                    "Cannot process trip that hasn't been validated: %s",
                    self.trip_data.get("transactionId", "unknown"),
                )
                return False

        success, self.processed_data = await self._basic_processor.process(
            self.processed_data,
            self._state_machine,
        )
        return success

    async def geocode(self) -> bool:
        """
        Perform geocoding for trip start and end points.

        Returns:
            True if geocoding succeeded, False otherwise
        """
        # Ensure trip is processed
        if self.state == TripState.NEW:
            await self.validate()
            if self.state == TripState.VALIDATED:
                await self.process_basic()
            if self.state != TripState.PROCESSED:
                logger.warning(
                    "Cannot geocode trip that hasn't been processed: %s",
                    self.trip_data.get("transactionId", "unknown"),
                )
                return False
        elif self.state != TripState.PROCESSED:
            logger.warning(
                "Cannot geocode trip that hasn't been processed: %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            return False

        success, self.processed_data = await self.geocoder.geocode(
            self.processed_data,
            self._state_machine,
        )
        return success

    async def map_match(self) -> bool:
        """
        Perform map matching for the trip.

        Returns:
            True if map matching succeeded or was appropriately handled, False otherwise
        """
        # Ensure proper state
        if self.state not in [
            TripState.GEOCODED,
            TripState.PROCESSED,
            TripState.VALIDATED,
        ]:
            if self.state in [
                TripState.NEW,
                TripState.VALIDATED,
                TripState.PROCESSED,
            ]:
                await self.geocode()
                if self.state != TripState.GEOCODED:
                    logger.warning(
                        "Cannot map match trip %s: pre-requisite steps failed",
                        self.trip_data.get("transactionId", "unknown"),
                    )
                    return False
            else:
                logger.warning(
                    "Cannot map match trip %s in state: %s",
                    self.trip_data.get("transactionId", "unknown"),
                    self.state.value,
                )
                return False

        success, self.processed_data = await self.map_matcher.map_match(
            self.processed_data,
            self._state_machine,
        )
        return success

    async def save(self, _map_match_result: bool | None = None) -> str | None:
        """
        Save the processed trip to the database.

        Args:
            _map_match_result: Optional override for whether to save map matching results

        Returns:
            ObjectId of the saved document if successful, None otherwise
        """
        if self.state not in [
            TripState.VALIDATED,
            TripState.PROCESSED,
            TripState.GEOCODED,
            TripState.MAP_MATCHED,
            TripState.COMPLETED,
        ]:
            logger.warning(
                "Cannot save trip %s that hasn't been processed (State: %s)",
                self.trip_data.get("transactionId", "unknown"),
                self.state.value,
            )
            return None

        # Save to trips collection (includes matchedGps if present)
        return await self.repository.save_trip(
            self.processed_data,
            self.source,
            self.state_history,
        )
