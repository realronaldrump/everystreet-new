"""
Mathematical utilities for circular statistics.

This module provides specialized mathematical functions for circular
data (e.g., hours of the day, compass directions).
"""

from __future__ import annotations

import math
import statistics


def calculate_circular_average_hour(
    hours_list: list[float],
) -> float:
    """
    Calculate the circular average of a list of hours (0-23).

    This function properly handles the circular nature of hours, where
    23:59 is close to 00:01. Standard averaging would fail for times
    near midnight.

    Args:
        hours_list: List of hour values in 24-hour format (0-23).

    Returns:
        The circular average hour (0-23.999...).

    Example:
        >>> calculate_circular_average_hour([23.0, 0.0, 1.0])
        0.0  # Correctly averages around midnight
        >>> calculate_circular_average_hour([11.0, 12.0, 13.0])
        12.0  # Standard average for non-wraparound hours
    """
    if not hours_list:
        return 0.0

    # Convert hours to angles (radians)
    angles = [(h / 24.0) * 2 * math.pi for h in hours_list]

    # Calculate mean of sin and cos components
    avg_sin = statistics.mean([math.sin(angle) for angle in angles])
    avg_cos = statistics.mean([math.cos(angle) for angle in angles])

    # Convert back to angle and then to hours
    avg_angle = math.atan2(avg_sin, avg_cos)
    avg_hour = (avg_angle / (2 * math.pi)) * 24.0

    # Normalize to 0-24 range
    return (avg_hour + 24.0) % 24.0
