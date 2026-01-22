"""Trip API routes."""

from trips.routes import crud, pages, query, stats, sync

__all__ = ["crud", "pages", "query", "stats", "sync"]
