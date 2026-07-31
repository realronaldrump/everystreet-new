from __future__ import annotations

import asyncio

import pytest

import logs.api as logs_api


class HangingProcess:
    def __init__(self) -> None:
        self.killed = False
        self.returncode = None

    async def communicate(self) -> tuple[bytes, bytes]:
        if not self.killed:
            await asyncio.sleep(60)
        return b"", b""

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


@pytest.mark.asyncio
async def test_run_docker_command_kills_timed_out_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = HangingProcess()

    async def fake_create_subprocess_exec(*args: object, **kwargs: object) -> HangingProcess:
        return process

    monkeypatch.setattr(
        logs_api.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )
    monkeypatch.setattr(logs_api, "DOCKER_COMMAND_TIMEOUT_SECONDS", 0.01)

    stdout, stderr, returncode = await logs_api._run_docker_command(
        ["logs", "everystreet-web-1"],
    )

    assert stdout == ""
    assert "timed out" in stderr
    assert returncode == 124
    assert process.killed is True
