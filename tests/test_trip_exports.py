"""
Tests for simplified trip export endpoints.

Tests coverage for trips and matched trips exports with field filtering.
"""

import pytest
from datetime import UTC, datetime, timedelta
from httpx import AsyncClient

from db.models import Trip


@pytest.mark.asyncio
async def test_export_trips_geojson(async_client: AsyncClient):
    """Test trip export in GeoJSON format."""
    # Create test trip
    start_time = datetime.now(UTC)
    end_time = start_time + timedelta(hours=1)

    await Trip(
        transactionId="test-trip-1",
        startTime=start_time,
        endTime=end_time,
        gps={
            "type": "LineString",
            "coordinates": [[0, 0], [1, 1], [2, 2]],
        },
        distance=10.5,
    ).insert()

    # Export trips
    start_date = start_time.strftime("%Y-%m-%d")
    end_date = end_time.strftime("%Y-%m-%d")

    response = await async_client.get(
        f"/api/export/trips?start_date={start_date}&end_date={end_date}&fmt=geojson"
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/geo+json; charset=utf-8"

    content = response.text
    assert '"type":"FeatureCollection"' in content
    assert '"coordinates":[[0,0],[1,1],[2,2]]' in content


@pytest.mark.asyncio
async def test_export_trips_csv_with_fields(async_client: AsyncClient):
    """Test trip export in CSV format with field filtering."""
    start_time = datetime.now(UTC)
    end_time = start_time + timedelta(hours=1)

    await Trip(
        transactionId="test-trip-csv",
        startTime=start_time,
        endTime=end_time,
        gps={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        distance=5.5,
        maxSpeed=65.0,
    ).insert()

    start_date = start_time.strftime("%Y-%m-%d")
    end_date = end_time.strftime("%Y-%m-%d")

    # Export with specific field groups
    response = await async_client.get(
        f"/api/export/trips?start_date={start_date}&end_date={end_date}&fmt=csv&fields=basic,telemetry"
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"

    content = response.text
    # Should have basic fields
    assert "transactionId" in content
    assert "startTime" in content

    # Should have telemetry fields
    assert "distance" in content
    assert "maxSpeed" in content

    # Should NOT have location fields (not requested)
    assert "startAddress" not in content


@pytest.mark.asyncio
async def test_export_trips_csv_default_fields(async_client: AsyncClient):
    """Test trip export with default field selection."""
    start_time = datetime.now(UTC)
    end_time = start_time + timedelta(hours=1)

    await Trip(
        transactionId="test-trip-default",
        startTime=start_time,
        endTime=end_time,
        gps={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        distance=5.5,
    ).insert()

    start_date = start_time.strftime("%Y-%m-%d")
    end_date = end_time.strftime("%Y-%m-%d")

    # Export without specifying fields (should use defaults)
    response = await async_client.get(
        f"/api/export/trips?start_date={start_date}&end_date={end_date}&fmt=csv"
    )

    assert response.status_code == 200

    content = response.text
    # Default includes basic, locations, telemetry, geometry
    assert "transactionId" in content
    assert "distance" in content
    assert "gps" in content


@pytest.mark.asyncio
async def test_export_matched_trips(async_client: AsyncClient):
    """Test matched trips export."""
    start_time = datetime.now(UTC)
    end_time = start_time + timedelta(hours=1)

    # Create regular trip (should not be exported)
    await Trip(
        transactionId="regular-trip",
        startTime=start_time,
        endTime=end_time,
        gps={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
    ).insert()

    # Create matched trip (should be exported)
    await Trip(
        transactionId="matched-trip",
        startTime=start_time,
        endTime=end_time,
        gps={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        matchedGps={"type": "LineString", "coordinates": [[0.1, 0.1], [1.1, 1.1]]},
    ).insert()

    start_date = start_time.strftime("%Y-%m-%d")
    end_date = end_time.strftime("%Y-%m-%d")

    response = await async_client.get(
        f"/api/export/matched_trips?start_date={start_date}&end_date={end_date}&fmt=geojson"
    )

    assert response.status_code == 200

    content = response.text
    # Should only include matched trip
    assert '"matched-trip"' in content
    assert '"regular-trip"' not in content


@pytest.mark.asyncio
async def test_export_trips_invalid_format(async_client: AsyncClient):
    """Test trip export with invalid format."""
    today = datetime.now(UTC).strftime("%Y-%m-%d")

    response = await async_client.get(
        f"/api/export/trips?start_date={today}&end_date={today}&fmt=invalid"
    )

    assert response.status_code == 400
    assert "unsupported format" in response.text.lower()


@pytest.mark.asyncio
async def test_export_trips_no_data(async_client: AsyncClient):
    """Test trip export with no trips in date range."""
    # Use future dates where no trips exist
    future_date = (datetime.now(UTC) + timedelta(days=365)).strftime("%Y-%m-%d")

    response = await async_client.get(
        f"/api/export/trips?start_date={future_date}&end_date={future_date}&fmt=geojson"
    )

    assert response.status_code == 200

    content = response.text
    assert '"type":"FeatureCollection"' in content
    assert '"features":[]' in content


@pytest.mark.asyncio
async def test_export_trips_all_field_groups(async_client: AsyncClient):
    """Test trip export with all field groups enabled."""
    start_time = datetime.now(UTC)
    end_time = start_time + timedelta(hours=1)

    await Trip(
        transactionId="comprehensive-trip",
        startTime=start_time,
        endTime=end_time,
        gps={"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        distance=10.0,
        maxSpeed=60.0,
        source="bouncie",
        notes="Test trip",
    ).insert()

    start_date = start_time.strftime("%Y-%m-%d")
    end_date = end_time.strftime("%Y-%m-%d")

    # Request all field groups
    response = await async_client.get(
        f"/api/export/trips?start_date={start_date}&end_date={end_date}&fmt=csv&fields=basic,locations,telemetry,geometry,metadata,custom"
    )

    assert response.status_code == 200

    content = response.text
    # Verify all field groups are present
    assert "transactionId" in content  # basic
    assert "distance" in content  # telemetry
    assert "gps" in content  # geometry
    assert "source" in content  # metadata
    assert "notes" in content  # custom


@pytest.mark.asyncio
async def test_export_trips_streaming_large_dataset(async_client: AsyncClient):
    """Test that exports stream correctly with larger datasets."""
    start_time = datetime.now(UTC)
    end_time = start_time + timedelta(hours=1)

    # Create 50 trips
    trips = []
    for i in range(50):
        trips.append(
            Trip(
                transactionId=f"trip-{i}",
                startTime=start_time + timedelta(minutes=i),
                endTime=end_time + timedelta(minutes=i),
                gps={"type": "LineString", "coordinates": [[i, i], [i + 1, i + 1]]},
                distance=float(i),
            )
        )

    await Trip.insert_many(trips)

    start_date = start_time.strftime("%Y-%m-%d")
    end_date = (end_time + timedelta(hours=1)).strftime("%Y-%m-%d")

    response = await async_client.get(
        f"/api/export/trips?start_date={start_date}&end_date={end_date}&fmt=geojson"
    )

    assert response.status_code == 200

    content = response.text
    # Verify all trips are in export
    for i in range(50):
        assert f'"trip-{i}"' in content
