import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from bson import ObjectId
from fastapi import HTTPException
from starlette.requests import Request

from exports.auth import enforce_owner, get_owner_key
from exports.routes.exports import download_export_job
from exports.services.export_service import ExportService


class FakeJob:
    def __init__(self):
        self.id = ObjectId()
        self.owner_key = "default"
        self.status = "pending"
        self.progress = 0.0
        self.message = "Queued"
        self.spec = {"items": [], "trip_filters": None, "area_id": None}
        self.result = None
        self.error = None
        self.created_at = datetime.now(timezone.utc)
        self.started_at = None
        self.completed_at = None
        self.updated_at = None

    async def save(self):
        return None


class ExportJobLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_job_marks_completed(self):
        job = FakeJob()
        with tempfile.TemporaryDirectory() as temp_dir:
            export_root = Path(temp_dir)
            with patch(
                "exports.services.export_service.EXPORT_ROOT",
                export_root,
            ):
                with patch(
                    "exports.services.export_service.ExportJob.get",
                    new=AsyncMock(return_value=job),
                ):
                    with patch.object(
                        ExportService,
                        "_write_exports",
                        new=AsyncMock(
                            return_value={"records": {}, "files": [], "area": None}
                        ),
                    ):
                        await ExportService.run_job(str(job.id))

        self.assertEqual(job.status, "completed")
        self.assertIsNotNone(job.result)
        self.assertIsNotNone(job.started_at)
        self.assertIsNotNone(job.completed_at)

    async def test_run_job_marks_failed(self):
        job = FakeJob()
        with tempfile.TemporaryDirectory() as temp_dir:
            export_root = Path(temp_dir)
            with patch(
                "exports.services.export_service.EXPORT_ROOT",
                export_root,
            ):
                with patch(
                    "exports.services.export_service.ExportJob.get",
                    new=AsyncMock(return_value=job),
                ):
                    with patch.object(
                        ExportService,
                        "_write_exports",
                        new=AsyncMock(side_effect=RuntimeError("boom")),
                    ):
                        await ExportService.run_job(str(job.id))

        self.assertEqual(job.status, "failed")
        self.assertEqual(job.error, "boom")

    async def test_download_requires_completed_job(self):
        job = FakeJob()
        job.status = "running"
        scope = {"type": "http", "headers": []}
        request = Request(scope)

        with patch(
            "exports.routes.exports.ExportJob.get",
            new=AsyncMock(return_value=job),
        ):
            with self.assertRaises(HTTPException) as context:
                await download_export_job(job.id, request)

        self.assertEqual(context.exception.status_code, 409)

    async def test_download_returns_file_response(self):
        job = FakeJob()
        job.status = "completed"

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact_path = Path(temp_dir) / "export.zip"
            artifact_path.write_bytes(b"zip")
            job.result = {
                "artifact_path": str(artifact_path),
                "artifact_name": "export_test.zip",
            }

            scope = {
                "type": "http",
                "headers": [(b"x-export-owner", b"default")],
            }
            request = Request(scope)

            with patch(
                "exports.routes.exports.ExportJob.get",
                new=AsyncMock(return_value=job),
            ):
                response = await download_export_job(job.id, request)

        self.assertEqual(response.status_code, 200)
        content_disposition = response.headers.get("content-disposition", "")
        self.assertIn("export_test.zip", content_disposition)

    def test_owner_helpers(self):
        scope = {"type": "http", "headers": [(b"x-export-owner", b"user-a")]}
        request = Request(scope)
        self.assertEqual(get_owner_key(request), "user-a")

        with self.assertRaises(HTTPException) as context:
            enforce_owner("user-a", "user-b")
        self.assertEqual(context.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
