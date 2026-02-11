from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def is_docker_unavailable_error(error_text: str) -> bool:
    lowered = (error_text or "").lower()
    return any(
        phrase in lowered
        for phrase in [
            "cannot connect to the docker daemon",
            "permission denied",
            "docker is not running",
            "error during connect",
            "dial unix",
        ]
    )


async def run_docker(
    cmd: list[str],
    timeout_seconds: float = 10.0,
    **kwargs: Any,
) -> tuple[int, str, str]:
    # Backwards-compatible alias: callers may still pass `timeout=...`.
    # Avoid a `timeout` parameter name in the signature (ruff ASYNC109).
    if kwargs:
        if set(kwargs) != {"timeout"}:
            unexpected = ", ".join(sorted(kwargs))
            raise TypeError(
                f"run_docker() got unexpected keyword arguments: {unexpected}"
            )
        timeout_seconds = float(kwargs["timeout"])

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(timeout_seconds):
                stdout, stderr = await process.communicate()
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            return 124, "", "timeout"
        return (
            process.returncode,
            stdout.decode(errors="replace").strip(),
            stderr.decode(errors="replace").strip(),
        )
    except FileNotFoundError as exc:
        return 127, "", str(exc)


async def get_container_name(service_name: str) -> str:
    env_project = os.getenv("COMPOSE_PROJECT_NAME", "").strip()

    try:
        if env_project:
            cmd = [
                "docker",
                "ps",
                "-a",
                "--filter",
                f"label=com.docker.compose.project={env_project}",
                "--filter",
                f"label=com.docker.compose.service={service_name}",
                "--format",
                "{{.Names}}",
            ]
            rc, stdout, _stderr = await run_docker(cmd)
            if rc == 0 and stdout.strip():
                return stdout.strip().split("\n")[0]

        cmd = [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.service={service_name}",
            "--format",
            "{{.Names}}",
        ]
        rc, stdout, _stderr = await run_docker(cmd)
        if rc == 0 and stdout.strip():
            return stdout.strip().split("\n")[0]
    except Exception as exc:
        logger.warning("Failed to lookup container by labels: %s", exc)

    try:
        cmd = [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"name={service_name}",
            "--format",
            "{{.Names}}",
        ]
        rc, stdout, _stderr = await run_docker(cmd)
        if rc == 0 and stdout.strip():
            return stdout.strip().split("\n")[0]
    except Exception as exc:
        logger.warning("Failed to lookup container name: %s", exc)

    return service_name
