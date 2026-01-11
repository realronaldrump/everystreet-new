"""Verification script to check for legacy DB usage and import errors."""

import ast
import os
import sys
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.append(str(PROJECT_ROOT))

# Legacy names that should not be used
LEGACY_NAMES = {
    "find_one_with_retry",
    "find_with_retry",
    "insert_one_with_retry",
    "insert_many_with_retry",
    "update_one_with_retry",
    "update_many_with_retry",
    "delete_one_with_retry",
    "delete_many_with_retry",
    "count_documents_with_retry",
    "aggregate_with_retry",
    "json_dumps",
    "serialize_document",
    "batch_cursor",
    "trips_collection",
    "users_collection",
    "streets_collection",
    "coverage_metadata_collection",
    "progress_collection",
}

# Exempt files (if any, e.g. verify script itself)
EXEMPT_FILES = {
    "verify_migration.py",
    "db/__init__.py",
}  # db/__init__.py defines or exports some but we removed them? No we removed them.


def check_imports_and_usage(root_dir: Path):
    """Scan all python files for legacy usage."""
    errors = []

    for py_file in root_dir.rglob("*.py"):
        if py_file.name in EXEMPT_FILES:
            continue
        if (
            "venv" in py_file.parts
            or ".git" in py_file.parts
            or "__pycache__" in py_file.parts
        ):
            continue

        try:
            content = py_file.read_text()
            tree = ast.parse(content)

            for node in ast.walk(tree):
                # Check imports from db
                if isinstance(node, ast.ImportFrom):
                    if node.module == "db":
                        for name in node.names:
                            if name.name in LEGACY_NAMES:
                                errors.append(
                                    f"{py_file}: Importing legacy name '{name.name}' from 'db' on line {node.lineno}"
                                )

                # Check direct usage of function calls (heuristic)
                if isinstance(node, ast.Call):
                    if isinstance(node.func, ast.Name):
                        if node.func.id in LEGACY_NAMES:
                            errors.append(
                                f"{py_file}: Calling legacy function '{node.func.id}' on line {node.lineno}"
                            )

        except Exception as e:
            errors.append(f"{py_file}: Error parsing file: {e}")

    return errors


def check_module_imports():
    """Try importing key modules to check for runtime import errors."""
    modules_to_test = [
        "db",
        "db.models",
        "search_api",
        "coverage.calculator",
        "coverage.streets_preprocessor",
        "coverage.geojson_generator",
        "coverage.gridfs_service",
        "exports.routes.trips",
        "exports.services.streaming_service",
        "trip_event_publisher",
    ]

    import_errors = []
    for mod in modules_to_test:
        try:
            print(f"Testing import of {mod}...")
            __import__(mod)
            print(f"  OK")
        except Exception as e:
            import_errors.append(f"Failed to import {mod}: {e}")

    return import_errors


if __name__ == "__main__":
    print(f"Scanning for legacy usage in {PROJECT_ROOT}...")
    usage_errors = check_imports_and_usage(PROJECT_ROOT)

    if usage_errors:
        print("\nFound legacy code usage:")
        for err in usage_errors:
            print(f"  - {err}")
    else:
        print("\nNo legacy code usage found!")

    print("\nChecking module imports...")
    import_errors = check_module_imports()

    if import_errors:
        print("\nFound import errors:")
        for err in import_errors:
            print(f"  - {err}")
    else:
        print("\nAll checked modules imported successfully!")

    if usage_errors or import_errors:
        sys.exit(1)

    print("\nVerification Passed!")
