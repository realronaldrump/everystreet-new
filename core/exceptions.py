"""
Centralized exception hierarchy for domain-specific errors.

This module provides custom exception classes that represent specific error conditions
in the application, enabling better error handling and client-side error recovery.
"""


class EveryStreetException(Exception):
    """Base exception for all application-specific errors."""

    def __init__(self, message: str, details: dict | None = None):
        self.message = message
        self.details = details or {}
        super().__init__(self.message)


class DatabaseException(EveryStreetException):
    """Exception raised when database operations fail."""


class ValidationException(EveryStreetException):
    """Exception raised when data validation fails."""


class GeocodingException(EveryStreetException):
    """Exception raised when geocoding operations fail."""


class MapMatchingException(EveryStreetException):
    """Exception raised when map matching operations fail."""


class ExternalServiceException(EveryStreetException):
    """Exception raised when external service calls fail."""


class BouncieException(ExternalServiceException):
    """Exception raised when Bouncie API operations fail."""


class RateLimitException(ExternalServiceException):
    """Exception raised when rate limits are exceeded."""


class ConfigurationException(EveryStreetException):
    """Exception raised when configuration is invalid or missing."""


class TripProcessingException(EveryStreetException):
    """Exception raised during trip processing."""


class CoverageCalculationException(EveryStreetException):
    """Exception raised during coverage calculations."""


class AuthenticationException(EveryStreetException):
    """Exception raised when authentication fails."""


class AuthorizationException(EveryStreetException):
    """Exception raised when authorization fails."""


class ResourceNotFoundException(EveryStreetException):
    """Exception raised when a requested resource is not found."""


class DuplicateResourceException(EveryStreetException):
    """Exception raised when attempting to create a duplicate resource."""
