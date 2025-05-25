#!/usr/bin/env python3
"""
Test script for performance monitoring functionality.

This script tests the performance monitoring system by making requests to the API
and verifying that metrics are being collected and reported correctly.
"""

import asyncio
import json
import time
from datetime import datetime

import httpx

from performance_monitor import (
    PerformanceTimer,
    async_performance_timer,
    get_optimization_report,
    get_performance_summary,
    get_real_time_metrics,
    log_database_operation,
    log_processing_step,
    log_request_timing,
    start_performance_monitoring,
)


async def test_performance_monitoring():
    """Test the performance monitoring system."""
    print("🚀 Testing Performance Monitoring System")
    print("=" * 50)

    # Start the performance monitoring system
    print("1. Starting performance monitoring...")
    await start_performance_monitoring()
    print("✅ Performance monitoring started")

    # Test the timer context managers
    print("\n2. Testing performance timers...")

    # Test sync timer
    with PerformanceTimer("test_sync_operation", "testing"):
        time.sleep(0.1)  # Simulate some work
    print("✅ Sync timer test completed")

    # Test async timer
    async with async_performance_timer("test_async_operation", "testing"):
        await asyncio.sleep(0.05)  # Simulate async work
    print("✅ Async timer test completed")

    # Test logging functions
    print("\n3. Testing logging functions...")
    log_request_timing("/test/endpoint", "GET", 125.5, 200)
    log_database_operation("find", "test_collection", 45.2)
    log_processing_step("data_validation", 78.3, 100)
    print("✅ Logging functions tested")

    # Get performance summaries
    print("\n4. Testing performance reports...")

    # Get real-time metrics
    real_time = get_real_time_metrics()
    print(f"✅ Real-time metrics retrieved: {len(real_time)} keys")

    # Get performance summary
    summary = get_performance_summary(hours=1)
    print(f"✅ Performance summary retrieved: {len(summary)} categories")

    # Get optimization report
    report = get_optimization_report()
    print(
        f"✅ Optimization report retrieved - Score: {report['performance_score']}/100"
    )

    return real_time, summary, report


async def test_api_endpoints():
    """Test the performance monitoring API endpoints."""
    print("\n5. Testing API endpoints...")

    base_url = "http://localhost:8080"

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            # Test health endpoint
            response = await client.get(f"{base_url}/api/performance/health")
            if response.status_code == 200:
                health_data = response.json()
                print(
                    f"✅ Health endpoint: Status = {health_data['status']}, Score = {health_data['performance_score']}"
                )
            else:
                print(f"❌ Health endpoint failed: {response.status_code}")

            # Test metrics endpoint
            response = await client.get(f"{base_url}/api/performance/metrics")
            if response.status_code == 200:
                metrics_data = response.json()
                api_requests = metrics_data["last_minute"]["api_requests"]
                print(
                    f"✅ Metrics endpoint: {api_requests} API requests in last minute"
                )
            else:
                print(f"❌ Metrics endpoint failed: {response.status_code}")

            # Test report endpoint
            response = await client.get(f"{base_url}/api/performance/report")
            if response.status_code == 200:
                report_data = response.json()
                recommendations = len(report_data.get("recommendations", []))
                print(f"✅ Report endpoint: {recommendations} recommendations")
            else:
                print(f"❌ Report endpoint failed: {response.status_code}")

            # Test summary endpoint
            response = await client.get(f"{base_url}/api/performance/summary?hours=1")
            if response.status_code == 200:
                summary_data = response.json()
                print(
                    f"✅ Summary endpoint: {summary_data['time_period_hours']} hour period"
                )
            else:
                print(f"❌ Summary endpoint failed: {response.status_code}")

        except httpx.ConnectError:
            print("⚠️  API server not running. Start the FastAPI app to test endpoints.")
        except Exception as e:
            print(f"❌ API test error: {e}")


def simulate_performance_load():
    """Simulate some performance metrics for testing."""
    print("\n6. Simulating performance load...")

    # Simulate various operations
    operations = [
        ("api_request", "/api/trips", "GET", [120, 95, 200, 85, 150]),
        ("api_request", "/api/metrics", "GET", [45, 55, 40, 60, 50]),
        ("database", "find", "trips", [25, 30, 45, 20, 35]),
        ("database", "update", "trips", [15, 18, 22, 12, 19]),
        ("processing", "trip_validation", None, [100, 85, 120, 90, 110]),
    ]

    for op_type, name, method, durations in operations:
        for duration in durations:
            if op_type == "api_request":
                log_request_timing(name, method, duration, 200)
            elif op_type == "database":
                log_database_operation(name, "trips", duration)
            elif op_type == "processing":
                log_processing_step(name, duration, 10)

    print("✅ Performance load simulation completed")


async def main():
    """Run all performance monitoring tests."""
    print("🔍 Performance Monitoring Test Suite")
    print("===================================")

    try:
        # Test core functionality
        real_time, summary, report = await test_performance_monitoring()

        # Simulate some load
        simulate_performance_load()

        # Test API endpoints
        await test_api_endpoints()

        # Display results
        print("\n📊 Final Performance Report:")
        print("-" * 30)

        # Get updated metrics after simulation
        updated_report = get_optimization_report()
        updated_metrics = get_real_time_metrics()

        print(f"Performance Score: {updated_report['performance_score']}/100")
        print(
            f"API Requests (last minute): {updated_metrics['last_minute']['api_requests']}"
        )
        print(
            f"DB Operations (last minute): {updated_metrics['last_minute']['database_operations']}"
        )
        print(f"Recommendations: {len(updated_report.get('recommendations', []))}")

        if updated_report.get("recommendations"):
            print("\n🔧 Optimization Recommendations:")
            for i, rec in enumerate(updated_report["recommendations"], 1):
                print(f"  {i}. [{rec['priority'].upper()}] {rec['message']}")
        else:
            print("\n✅ No optimization recommendations - system performing well!")

        print(f"\n🕒 Dashboard available at: http://localhost:8080/performance")
        print("   (Start the FastAPI app to view the dashboard)")

    except Exception as e:
        print(f"❌ Test failed: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main())
