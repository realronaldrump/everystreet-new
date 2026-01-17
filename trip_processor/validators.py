"""
Trip Validation Module.

Handles validation of trip data using Pydantic models.
"""

import logging
from typing import Any

from pydantic import ValidationError

from date_utils import get_current_utc_time
from db.models import Trip
from trip_processor.state import TripState, TripStateMachine

logger = logging.getLogger(__name__)


class TripValidator:
    """
    Validates trip data using Pydantic models.

    Ensures trip data conforms to the expected schema before processing.
    """

    @staticmethod
    async def validate(
        trip_data: dict[str, Any],
        state_machine: TripStateMachine,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Validate the trip data using Pydantic model.

        Args:
            trip_data: Raw trip data dictionary to validate
            state_machine: State machine to update on success/failure

        Returns:
            Tuple of (success, processed_data)
        """
        try:
            transaction_id = trip_data.get("transactionId", "unknown")

            # Validate using Beanie model (which is also a Pydantic model)
            validated_trip = Trip(**trip_data)
            processed_data = validated_trip.model_dump(exclude_unset=True)

            processed_data["validated_at"] = get_current_utc_time()
            processed_data["validation_status"] = TripState.VALIDATED.value
            processed_data["invalid"] = False
            processed_data["validation_message"] = None

            state_machine.set_state(TripState.VALIDATED)
            logger.debug("Trip %s validated successfully", transaction_id)
            result = (True, processed_data)

        except ValidationError as e:
            error_message = f"Validation error: {e}"
            logger.warning(
                "Trip %s failed validation: %s",
                trip_data.get("transactionId", "unknown"),
                error_message,
            )
            state_machine.set_state(TripState.FAILED, error_message)
            return False, {}

        except Exception as e:
            error_message = f"Unexpected validation error: {e!s}"
            logger.exception(
                "Error validating trip %s",
                trip_data.get("transactionId", "unknown"),
            )
            state_machine.set_state(TripState.FAILED, error_message)
            return False, {}
        else:
            return result
