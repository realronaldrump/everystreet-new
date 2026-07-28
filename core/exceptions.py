"""
Centralized exception hierarchy for domain-specific errors.

This module provides custom exception classes that represent specific
error conditions in the application, enabling better error handling and
client-side error recovery.
"""


class ApplicationException(Exception):
    """Base exception for all application-specific errors."""

    def __init__(self, message: str, details: dict | None = None) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(self.message)


class ValidationException(ApplicationException):
    """Exception raised when data validation fails."""


class ExternalServiceException(ApplicationException):
    """Exception raised when service calls fail."""


class RateLimitException(ExternalServiceException):
    """Exception raised when rate limits are exceeded."""


class AuthenticationException(ApplicationException):
    """Exception raised when authentication fails."""


class AuthorizationException(ApplicationException):
    """Exception raised when authorization fails."""


class ResourceNotFoundException(ApplicationException):
    """Exception raised when a requested resource is not found."""


class DuplicateResourceException(ApplicationException):
    """Exception raised when attempting to create a duplicate resource."""
