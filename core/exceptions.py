"""
Centralized exception hierarchy for domain-specific errors.

This module provides custom exception classes that represent specific
error conditions in the application, enabling better error handling and
client-side error recovery.
"""


class EveryStreetException(Exception):
    """Base exception for all application-specific errors."""

    def __init__(self, message: str, details: dict | None = None) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(self.message)


class ValidationException(EveryStreetException):
    """Exception raised when data validation fails."""


class ExternalServiceException(EveryStreetException):
    """Exception raised when external service calls fail."""


class RateLimitException(ExternalServiceException):
    """Exception raised when rate limits are exceeded."""


class AuthenticationException(EveryStreetException):
    """Exception raised when authentication fails."""


class AuthorizationException(EveryStreetException):
    """Exception raised when authorization fails."""


class ResourceNotFoundException(EveryStreetException):
    """Exception raised when a requested resource is not found."""


class DuplicateResourceException(EveryStreetException):
    """Exception raised when attempting to create a duplicate resource."""
