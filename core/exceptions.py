"""
Centralized exception hierarchy for domain-specific errors.

This module provides custom exception classes that represent specific error
conditions in the application, enabling better error handling and client-side
error recovery.
"""


class EveryStreetException(Exception):
    """Base exception for all application-specific errors."""

    def __init__(self, message: str, details: dict = None):
        self.message = message
        self.details = details or {}
        super().__init__(self.message)


class DatabaseException(EveryStreetException):
    """Exception raised when database operations fail."""
    pass


class ValidationException(EveryStreetException):
    """Exception raised when data validation fails."""
    pass


class GeocodingException(EveryStreetException):
    """Exception raised when geocoding operations fail."""
    pass


class MapMatchingException(EveryStreetException):
    """Exception raised when map matching operations fail."""
    pass


class ExternalServiceException(EveryStreetException):
    """Exception raised when external service calls fail."""
    pass


class BouncieException(ExternalServiceException):
    """Exception raised when Bouncie API operations fail."""
    pass


class RateLimitException(ExternalServiceException):
    """Exception raised when rate limits are exceeded."""
    pass


class ConfigurationException(EveryStreetException):
    """Exception raised when configuration is invalid or missing."""
    pass


class TripProcessingException(EveryStreetException):
    """Exception raised during trip processing."""
    pass


class CoverageCalculationException(EveryStreetException):
    """Exception raised during coverage calculations."""
    pass


class AuthenticationException(EveryStreetException):
    """Exception raised when authentication fails."""
    pass


class AuthorizationException(EveryStreetException):
    """Exception raised when authorization fails."""
    pass


class ResourceNotFoundException(EveryStreetException):
    """Exception raised when a requested resource is not found."""
    pass


class DuplicateResourceException(EveryStreetException):
    """Exception raised when attempting to create a duplicate resource."""
    pass
