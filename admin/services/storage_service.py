from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from map_data.docker import is_docker_unavailable_error, run_docker

_MB_BYTES = 1024 * 1024
_DOCKER_TIMEOUT = 10.0
_SIZE_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$")

EXPECTED_VOLUMES: dict[str, str] = {
    "mongo_data": "MongoDB data",
    "redis_data": "Redis cache",
    "nominatim_data": "Nominatim database",
    "nominatim_flatnode": "Nominatim flatnode",
    "valhalla_tiles": "Valhalla tiles",
    "osm_extracts": "OSM extracts",
}

APP_CACHE_SOURCES: list[dict[str, Any]] = [
    {
        "id": "exports_cache",
        "label": "Exports cache",
        "category": "App cache",
        "path": Path("cache") / "exports",
        "detail": "cache/exports",
    },
]


def _bytes_to_mb(size_bytes: int | None) -> float | None:
    if size_bytes is None:
        return None
    if size_bytes <= 0:
        return 0.0
    return round(size_bytes / _MB_BYTES, 2)


def _normalize_error(error_text: str | None) -> str | None:
    if not error_text:
        return None
    return error_text.strip()


def _is_docker_unavailable(error_text: str | None) -> bool:
    if not error_text:
        return False
    if is_docker_unavailable_error(error_text):
        return True
    lowered = error_text.lower()
    return "docker" in lowered and (
        "not found" in lowered
        or "no such file" in lowered
        or "command not found" in lowered
    )


def _parse_size_to_bytes(size_text: str | None) -> int | None:
    if not size_text:
        return None
    match = _SIZE_PATTERN.match(size_text)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2).upper()
    unit = unit.replace("I", "")
    multipliers = {
        "B": 1,
        "KB": 1024,
        "MB": 1024**2,
        "GB": 1024**3,
        "TB": 1024**4,
        "PB": 1024**5,
    }
    multiplier = multipliers.get(unit)
    if multiplier is None:
        return None
    return int(value * multiplier)


def _match_expected_label(volume_name: str) -> str | None:
    for label in EXPECTED_VOLUMES:
        if volume_name == label or volume_name.endswith(f"_{label}"):
            return label
    return None


def _parse_volume_sizes(output: str) -> dict[str, int]:
    sizes: dict[str, int] = {}
    in_volume_section = False
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped:
            if in_volume_section and sizes:
                break
            continue
        if stripped.upper().startswith("VOLUME NAME"):
            in_volume_section = True
            continue
        if not in_volume_section:
            continue
        if stripped.upper().startswith("CACHE ID") or stripped.lower().startswith(
            "build cache",
        ):
            break
        parts = stripped.split()
        if len(parts) < 3:
            continue
        size_text = parts[-1]
        volume_name = " ".join(parts[:-2])
        size_bytes = _parse_size_to_bytes(size_text)
        if size_bytes is not None:
            sizes[volume_name] = size_bytes
    return sizes


async def _get_volume_sizes() -> tuple[dict[str, int], str | None]:
    rc, stdout, stderr = await run_docker(
        ["docker", "system", "df", "-v"],
        timeout=_DOCKER_TIMEOUT,
    )
    if rc != 0:
        return {}, _normalize_error(stderr or "docker system df failed")
    return _parse_volume_sizes(stdout), None


async def _infer_compose_project() -> str | None:
    env_project = os.getenv("COMPOSE_PROJECT_NAME", "").strip()
    if env_project:
        return env_project

    services = (
        "web",
        "worker",
        "mongo",
        "redis",
        "nominatim",
        "valhalla",
        "mongo-init",
        "watchtower",
    )
    for service in services:
        rc, stdout, stderr = await run_docker(
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                f"label=com.docker.compose.service={service}",
                "--format",
                '{{.Label "com.docker.compose.project"}}',
            ],
            timeout=_DOCKER_TIMEOUT,
        )
        if rc != 0:
            if is_docker_unavailable_error(stderr):
                return None
            continue
        for line in stdout.splitlines():
            value = line.strip()
            if value:
                return value
    return None


async def _list_volumes(filter_args: list[str]) -> tuple[list[str], str | None]:
    rc, stdout, stderr = await run_docker(
        ["docker", "volume", "ls", "--format", "{{.Name}}", *filter_args],
        timeout=_DOCKER_TIMEOUT,
    )
    if rc != 0:
        return [], _normalize_error(stderr or "docker volume ls failed")
    return [line.strip() for line in stdout.splitlines() if line.strip()], None


async def _inspect_volume(volume_name: str) -> tuple[dict[str, Any] | None, str | None]:
    rc, stdout, stderr = await run_docker(
        ["docker", "volume", "inspect", "--size", volume_name],
        timeout=_DOCKER_TIMEOUT,
    )
    if rc != 0:
        lowered = (stderr or "").lower()
        if "unknown flag: --size" in lowered:
            rc, stdout, stderr = await run_docker(
                ["docker", "volume", "inspect", volume_name],
                timeout=_DOCKER_TIMEOUT,
            )
        if rc != 0:
            return None, _normalize_error(stderr or "docker volume inspect failed")
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return None, "docker volume inspect returned invalid JSON"
    if not isinstance(data, list) or not data:
        return None, "docker volume inspect returned empty data"
    return data[0], None


def _build_volume_source(
    volume_name: str,
    volume_label: str | None,
    size_bytes: int | None,
    error: str | None,
    project_label: str | None = None,
) -> dict[str, Any]:
    label_key = volume_label or volume_name
    friendly_label = EXPECTED_VOLUMES.get(label_key)
    detail_parts = [f"Volume: {volume_name}"]
    if project_label:
        detail_parts.append(f"Project: {project_label}")
    return {
        "id": label_key,
        "label": friendly_label or f"Docker volume: {label_key}",
        "category": "Docker volume",
        "size_bytes": size_bytes,
        "size_mb": _bytes_to_mb(size_bytes),
        "detail": " • ".join(detail_parts),
        "error": error,
    }


def _directory_size_bytes(path: Path) -> tuple[int | None, str | None]:
    if not path.exists():
        return 0, None
    total = 0
    error: str | None = None
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                file_path = Path(root) / name
                try:
                    total += file_path.stat().st_size
                except OSError as exc:
                    if not error:
                        error = str(exc)
    except OSError as exc:
        return None, str(exc)
    return total, error


class StorageService:
    """Aggregate storage usage for Docker volumes and app cache directories."""

    @staticmethod
    async def get_storage_snapshot() -> dict[str, Any]:
        sources: list[dict[str, Any]] = []
        total_bytes = 0
        has_size_data = False
        updated_at = datetime.now(UTC).isoformat()

        docker_error: str | None = None
        volume_names: list[str] = []
        project = await _infer_compose_project()
        volume_sizes: dict[str, int] = {}

        if project:
            volume_names, docker_error = await _list_volumes(
                ["--filter", f"label=com.docker.compose.project={project}"],
            )

        if not volume_names and not docker_error:
            fallback_names: set[str] = set()
            for volume_label in EXPECTED_VOLUMES:
                names, err = await _list_volumes(
                    ["--filter", f"label=com.docker.compose.volume={volume_label}"],
                )
                if err and not docker_error:
                    docker_error = err
                fallback_names.update(names)
            volume_names = sorted(fallback_names)

        if docker_error and _is_docker_unavailable(docker_error):
            for volume_label, friendly in EXPECTED_VOLUMES.items():
                sources.append(
                    {
                        "id": volume_label,
                        "label": friendly,
                        "category": "Docker volume",
                        "size_bytes": None,
                        "size_mb": None,
                        "detail": None,
                        "error": "Docker unavailable",
                    },
                )
            docker_error = "Docker unavailable"
        else:
            if volume_names:
                volume_sizes, _ = await _get_volume_sizes()
            found_labels: set[str] = set()
            for volume_name in volume_names:
                inspect, error = await _inspect_volume(volume_name)
                labels = inspect.get("Labels") or {} if inspect else {}
                volume_label = labels.get(
                    "com.docker.compose.volume",
                ) or _match_expected_label(volume_name)
                project_label = labels.get("com.docker.compose.project") or project
                size_value = None
                if inspect:
                    usage = inspect.get("UsageData") or {}
                    if isinstance(usage, dict):
                        size_bytes = usage.get("Size")
                        if isinstance(size_bytes, int | float):
                            size_value = int(size_bytes)
                if size_value is None:
                    size_value = volume_sizes.get(volume_name)

                if volume_label:
                    found_labels.add(volume_label)

                error_message = None
                if size_value is None:
                    error_message = error or "Size unavailable"

                source = _build_volume_source(
                    volume_name,
                    volume_label,
                    size_value,
                    error_message,
                    project_label,
                )
                sources.append(source)

                if size_value is not None:
                    total_bytes += size_value
                    has_size_data = True

            for volume_label, friendly in EXPECTED_VOLUMES.items():
                if volume_label in found_labels:
                    continue
                sources.append(
                    {
                        "id": volume_label,
                        "label": friendly,
                        "category": "Docker volume",
                        "size_bytes": None,
                        "size_mb": None,
                        "detail": None,
                        "error": "Not found",
                    },
                )

        for cache_source in APP_CACHE_SOURCES:
            path: Path = cache_source["path"]
            size_bytes, error = await asyncio.to_thread(_directory_size_bytes, path)
            if isinstance(size_bytes, int):
                total_bytes += size_bytes
                has_size_data = True

            sources.append(
                {
                    "id": cache_source["id"],
                    "label": cache_source["label"],
                    "category": cache_source["category"],
                    "size_bytes": size_bytes,
                    "size_mb": _bytes_to_mb(size_bytes),
                    "detail": cache_source.get("detail"),
                    "error": error,
                },
            )

        if not has_size_data:
            total_bytes = None

        return {
            "total_bytes": total_bytes,
            "total_mb": _bytes_to_mb(total_bytes),
            "updated_at": updated_at,
            "sources": sources,
            "error": docker_error if docker_error == "Docker unavailable" else None,
        }
