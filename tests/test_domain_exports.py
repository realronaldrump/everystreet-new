"""
Tests for domain-aligned export endpoints.

Tests coverage for streets, boundaries, and undriven streets exports.
"""

import pytest
from bson import ObjectId
from httpx import AsyncClient

from coverage.models import CoverageArea, CoverageState, Street


@pytest.mark.asyncio
async def test_export_streets_success(async_client: AsyncClient, sample_coverage_area):
    """Test successful streets export."""
    area_id = str(sample_coverage_area.id)

    # Create some test streets
    await Street(
        segment_id=f"{area_id}-1-1",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        street_name="Main St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    await Street(
        segment_id=f"{area_id}-1-2",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[1, 1], [2, 2]]},
        street_name="Oak Ave",
        highway_type="secondary",
        length_miles=0.75,
    ).insert()

    # Create coverage states
    await CoverageState(
        area_id=sample_coverage_area.id,
        segment_id=f"{area_id}-1-1",
        status="driven",
    ).insert()

    await CoverageState(
        area_id=sample_coverage_area.id,
        segment_id=f"{area_id}-1-2",
        status="undriven",
    ).insert()

    # Test GeoJSON export
    response = await async_client.get(f"/api/export/streets/{area_id}?fmt=geojson")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/geo+json; charset=utf-8"

    # Parse streamed GeoJSON
    content = response.text
    assert '"type":"FeatureCollection"' in content
    assert '"Main St"' in content
    assert '"Oak Ave"' in content


@pytest.mark.asyncio
async def test_export_streets_with_status_filter(
    async_client: AsyncClient, sample_coverage_area
):
    """Test streets export with status filtering."""
    area_id = str(sample_coverage_area.id)

    # Create streets with different statuses
    await Street(
        segment_id=f"{area_id}-1-1",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        street_name="Driven St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    await Street(
        segment_id=f"{area_id}-1-2",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[1, 1], [2, 2]]},
        street_name="Undriven St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    await CoverageState(
        area_id=sample_coverage_area.id,
        segment_id=f"{area_id}-1-1",
        status="driven",
    ).insert()

    await CoverageState(
        area_id=sample_coverage_area.id,
        segment_id=f"{area_id}-1-2",
        status="undriven",
    ).insert()

    # Export only driven streets
    response = await async_client.get(
        f"/api/export/streets/{area_id}?fmt=geojson&status_filter=driven"
    )

    assert response.status_code == 200
    content = response.text
    assert '"Driven St"' in content
    assert '"Undriven St"' not in content


@pytest.mark.asyncio
async def test_export_streets_csv_format(
    async_client: AsyncClient, sample_coverage_area
):
    """Test streets export in CSV format."""
    area_id = str(sample_coverage_area.id)

    await Street(
        segment_id=f"{area_id}-1-1",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        street_name="Main St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    response = await async_client.get(f"/api/export/streets/{area_id}?fmt=csv")

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"

    content = response.text
    assert "segment_id" in content
    assert "street_name" in content
    assert "Main St" in content


@pytest.mark.asyncio
async def test_export_streets_area_not_found(async_client: AsyncClient):
    """Test streets export with non-existent area."""
    fake_id = str(ObjectId())

    response = await async_client.get(f"/api/export/streets/{fake_id}?fmt=geojson")

    assert response.status_code == 404
    assert "not found" in response.text.lower()


@pytest.mark.asyncio
async def test_export_streets_area_not_ready(async_client: AsyncClient):
    """Test streets export with area not in ready status."""
    # Create area with non-ready status
    area = await CoverageArea(
        display_name="Test Area Not Ready",
        status="initializing",
        area_version=1,
    ).insert()

    response = await async_client.get(
        f"/api/export/streets/{str(area.id)}?fmt=geojson"
    )

    assert response.status_code == 400
    assert "not ready" in response.text.lower()


@pytest.mark.asyncio
async def test_export_streets_invalid_format(
    async_client: AsyncClient, sample_coverage_area
):
    """Test streets export with invalid format."""
    area_id = str(sample_coverage_area.id)

    response = await async_client.get(f"/api/export/streets/{area_id}?fmt=invalid")

    assert response.status_code == 400
    assert "unsupported format" in response.text.lower()


@pytest.mark.asyncio
async def test_export_boundary_success(async_client: AsyncClient, sample_coverage_area):
    """Test successful boundary export."""
    area_id = str(sample_coverage_area.id)

    response = await async_client.get(f"/api/export/boundaries/{area_id}?fmt=geojson")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/geo+json; charset=utf-8"

    content = response.text
    assert '"type":"FeatureCollection"' in content
    assert sample_coverage_area.display_name in content


@pytest.mark.asyncio
async def test_export_boundary_csv(async_client: AsyncClient, sample_coverage_area):
    """Test boundary export in CSV format."""
    area_id = str(sample_coverage_area.id)

    response = await async_client.get(f"/api/export/boundaries/{area_id}?fmt=csv")

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"

    content = response.text
    assert "area_id" in content
    assert "display_name" in content
    assert sample_coverage_area.display_name in content


@pytest.mark.asyncio
async def test_export_undriven_streets_success(
    async_client: AsyncClient, sample_coverage_area
):
    """Test successful undriven streets export."""
    area_id = str(sample_coverage_area.id)

    # Create mix of driven and undriven streets
    await Street(
        segment_id=f"{area_id}-1-1",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        street_name="Driven St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    await Street(
        segment_id=f"{area_id}-1-2",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[1, 1], [2, 2]]},
        street_name="Undriven St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    await CoverageState(
        area_id=sample_coverage_area.id,
        segment_id=f"{area_id}-1-1",
        status="driven",
    ).insert()

    await CoverageState(
        area_id=sample_coverage_area.id,
        segment_id=f"{area_id}-1-2",
        status="undriven",
    ).insert()

    # Export undriven streets only
    response = await async_client.get(
        f"/api/export/undriven-streets/{area_id}?fmt=geojson"
    )

    assert response.status_code == 200

    content = response.text
    assert '"Undriven St"' in content
    assert '"Driven St"' not in content


@pytest.mark.asyncio
async def test_export_undriven_streets_empty(
    async_client: AsyncClient, sample_coverage_area
):
    """Test undriven streets export when all streets are driven."""
    area_id = str(sample_coverage_area.id)

    # Create a driven street
    await Street(
        segment_id=f"{area_id}-1-1",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        street_name="Driven St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    await CoverageState(
        area_id=sample_coverage_area.id,
        segment_id=f"{area_id}-1-1",
        status="driven",
    ).insert()

    # Export should return empty feature collection
    response = await async_client.get(
        f"/api/export/undriven-streets/{area_id}?fmt=geojson"
    )

    assert response.status_code == 200

    content = response.text
    assert '"type":"FeatureCollection"' in content
    assert '"features":[]' in content


@pytest.mark.asyncio
async def test_export_concurrent_requests(
    async_client: AsyncClient, sample_coverage_area
):
    """Test multiple concurrent export requests."""
    import asyncio

    area_id = str(sample_coverage_area.id)

    await Street(
        segment_id=f"{area_id}-1-1",
        area_id=sample_coverage_area.id,
        area_version=1,
        geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        street_name="Main St",
        highway_type="residential",
        length_miles=0.5,
    ).insert()

    # Make 5 concurrent requests
    tasks = [
        async_client.get(f"/api/export/streets/{area_id}?fmt=geojson") for _ in range(5)
    ]

    responses = await asyncio.gather(*tasks)

    # All should succeed
    assert all(r.status_code == 200 for r in responses)
    assert all('"Main St"' in r.text for r in responses)
