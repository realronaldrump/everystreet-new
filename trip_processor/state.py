"""
Trip Processing State Module.

Defines the TripState enum and state machine for tracking trip processing status.
"""

from enum import Enum
from typing import Any

from date_utils import get_current_utc_time


class TripState(Enum):
    """Enumeration of trip processing states."""

    NEW = "new"
    VALIDATED = "validated"
    PROCESSED = "processed"
    GEOCODED = "geocoded"
    MAP_MATCHED = "map_matched"
    COMPLETED = "completed"
    FAILED = "failed"


class TripStateMachine:
    """
    Manages the state transitions for trip processing.

    Tracks the current state, maintains a history of state changes, and records any
    errors that occur during processing.
    """

    def __init__(self) -> None:
        """Initialize the state machine in NEW state."""
        self.state = TripState.NEW
        self.state_history: list[dict[str, Any]] = []
        self.errors: dict[str, str] = {}

    def set_state(
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
        previous_state = self.state
        self.state = new_state

        state_change = {
            "from": previous_state.value,
            "to": new_state.value,
            "timestamp": get_current_utc_time(),
        }

        if error and new_state == TripState.FAILED:
            state_change["error"] = error
            self.errors[previous_state.value] = error

        self.state_history.append(state_change)

    def reset(self) -> None:
        """Reset the state machine to its initial state."""
        self.state = TripState.NEW
        self.state_history = []
        self.errors = {}

    def get_status(self, transaction_id: str = "unknown") -> dict[str, Any]:
        """
        Get the current processing status.

        Args:
            transaction_id: The trip's transaction ID for the status report

        Returns:
            Dict with current state, history, and any errors
        """
        return {
            "state": self.state.value,
            "history": self.state_history,
            "errors": self.errors,
            "transaction_id": transaction_id,
        }

    def is_failed(self) -> bool:
        """Check if the current state is FAILED."""
        return self.state == TripState.FAILED

    def can_proceed_to(self, target_state: TripState) -> bool:
        """
        Check if transitioning to the target state is valid.

        Args:
            target_state: The state to transition to

        Returns:
            True if the transition is valid
        """
        # Define valid transitions
        valid_transitions = {
            TripState.NEW: {TripState.VALIDATED, TripState.FAILED},
            TripState.VALIDATED: {TripState.PROCESSED, TripState.FAILED},
            TripState.PROCESSED: {TripState.GEOCODED, TripState.FAILED},
            TripState.GEOCODED: {
                TripState.MAP_MATCHED,
                TripState.COMPLETED,
                TripState.FAILED,
            },
            TripState.MAP_MATCHED: {TripState.COMPLETED, TripState.FAILED},
            TripState.COMPLETED: set(),
            TripState.FAILED: set(),
        }
        return target_state in valid_transitions.get(self.state, set())
