import pytest

from exports.models import ExportItem
from exports.services.export_service import ExportService


def test_normalize_item_defaults_format_and_geometry() -> None:
    item = ExportItem(entity="trips")
    normalized = ExportService._normalize_item(item)

    assert normalized["format"] == "json"
    assert normalized["include_geometry"] is True


def test_normalize_item_defaults_geometry_for_csv() -> None:
    item = ExportItem(entity="trips", format="csv")
    normalized = ExportService._normalize_item(item)

    assert normalized["format"] == "csv"
    assert normalized["include_geometry"] is False


def test_normalize_item_rejects_invalid_format() -> None:
    item = ExportItem.model_construct(
        entity="trips",
        format="xml",
        include_geometry=None,
    )

    with pytest.raises(ValueError):
        ExportService._normalize_item(item)
