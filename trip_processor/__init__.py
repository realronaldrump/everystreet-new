"""
Trip Processor Package.

This package provides a modular trip processing system with:
- State machine for tracking processing status
- Validation using Pydantic models
- Basic GPS data processing
- Geocoding via external services
- Map matching via Valhalla

Usage:
    from trip_processor import TripProcessor, TripState

    processor = TripProcessor()
    processor.set_trip_data(trip_data)
    result = await processor.process()
"""

from trip_processor.basic_processing import TripBasicProcessor, format_idle_time
from trip_processor.geocoding import TripGeocoder
from trip_processor.map_matching import TripMapMatcher
from trip_processor.processor import TripProcessor
from trip_processor.state import TripState, TripStateMachine
from trip_processor.validators import TripValidator

__all__ = [
    # Processing components
    "TripBasicProcessor",
    "TripGeocoder",
    "TripMapMatcher",
    # Main processor
    "TripProcessor",
    # State management
    "TripState",
    "TripStateMachine",
    "TripValidator",
    # Utility functions
    "format_idle_time",
]
