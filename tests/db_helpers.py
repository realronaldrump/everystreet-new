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
    client = AsyncMongoMockClient()
    database = client[database_name]
    _patch_mock_database_for_beanie_2_1(client, database)
    await init_beanie(database=database, document_models=list(document_models))
    return database
