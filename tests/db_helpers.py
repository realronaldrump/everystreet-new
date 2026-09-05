from __future__ import annotations

from typing import Any

from beanie import init_beanie
from pymongo_async_mock import AsyncMongoMockClient


def _patch_mock_database_for_beanie_2_1(client: AsyncMongoMockClient, database):
    # Keep the in-memory async Mongo mock aligned with the PyMongo APIs
    # Beanie 2.1 calls during initialization.
    client.append_metadata = lambda _metadata: None

    original_list_collection_names = database.list_collection_names

    async def list_collection_names(*args: Any, **kwargs: Any):
        kwargs.pop("authorizedCollections", None)
        kwargs.pop("nameOnly", None)
        return await original_list_collection_names(*args, **kwargs)

    database.list_collection_names = list_collection_names


async def init_mock_beanie(
    *document_models: Any,
    database_name: str = "test_db",
):
    from db.models import (
        CoverageArea,
        AppSettings,
        CoverageOverride,
        CoverageJournalEntry,
        CoverageJournalRollup,
        CoverageMission,
        CoverageGoal,
        CoverageStatusEvent,
        CoverageDriveEvent,
        CoverageState,
        Street,
    )

    models = list(document_models)
    if CoverageArea in models:
        models = list(
            dict.fromkeys(
                [
                    *models,
                    AppSettings,
                    CoverageOverride,
                    CoverageJournalEntry,
                    CoverageJournalRollup,
                    CoverageMission,
                    CoverageGoal,
                    CoverageStatusEvent,
                    CoverageDriveEvent,
                    CoverageState,
                    Street,
                ]
            )
        )
    # PyMongo 4.18 adds an optional sort argument to bulk builders. Adapt the
    # test double here, never the application's transaction path.
    import mongomock.collection

    builder = mongomock.collection.BulkOperationBuilder
    if not getattr(builder, "_coverage_sort_adapter", False):
        import inspect

        original_update = inspect.unwrap(builder.add_update)
        original_replace = inspect.unwrap(builder.add_replace)

        def add_update(self, *args, sort=None, **kwargs):
            return original_update(self, *args, **kwargs)

        def add_replace(self, *args, sort=None, **kwargs):
            return original_replace(self, *args, **kwargs)

        add_update.__name__ = "add_update_compat"
        builder.add_update = add_update
        builder.add_replace = add_replace
        builder._coverage_sort_adapter = True
    client = AsyncMongoMockClient()
    database = client[database_name]
    _patch_mock_database_for_beanie_2_1(client, database)
    await init_beanie(database=database, document_models=models)
    return database
