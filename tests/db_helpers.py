from __future__ import annotations

from typing import Any

from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient


async def init_mock_beanie(
    *document_models: Any,
    database_name: str = "test_db",
):
    client = AsyncMongoMockClient()
    database = client[database_name]
    await init_beanie(database=database, document_models=list(document_models))
    return database
