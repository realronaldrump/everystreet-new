"""One transaction boundary for coverage evidence, decisions, and projections."""

from db.models import CoverageArea


async def run_transaction(callback):
    client = CoverageArea.get_pymongo_collection().database.client
    async with client.start_session() as session:
        return await session.with_transaction(callback)
