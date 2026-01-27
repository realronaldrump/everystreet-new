"""
Centralized exception hierarchy for domain-specific errors.

This module provides custom exception classes that represent specific
error conditions in the application, enabling better error handling and
client-side error recovery.
"""


class EveryStreetError(Exception):
    """Base exception for all application-specific errors."""

    def __init__(self, message: str, details: dict | None = None) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(self.message)


class ValidationError(EveryStreetError):
    """Exception raised when data validation fails."""


class ExternalServiceError(EveryStreetError):
    """Exception raised when service calls fail."""


class RateLimitError(ExternalServiceError):
    """Exception raised when rate limits are exceeded."""


class AuthenticationError(EveryStreetError):
    """Exception raised when authentication fails."""


class AuthorizationError(EveryStreetError):
    """Exception raised when authorization fails."""


class ResourceNotFoundError(EveryStreetError):
    """Exception raised when a requested resource is not found."""


class DuplicateResourceError(EveryStreetError):
    """Exception raised when attempting to create a duplicate resource."""


EveryStreetException = EveryStreetError
ValidationException = ValidationError
ExternalServiceException = ExternalServiceError
RateLimitException = RateLimitError
AuthenticationException = AuthenticationError
AuthorizationException = AuthorizationError
ResourceNotFoundException = ResourceNotFoundError
DuplicateResourceException = DuplicateResourceError
