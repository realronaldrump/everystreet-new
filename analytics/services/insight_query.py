"""Shared population and destination identity for Insights and its drilldowns."""

from typing import Any

from core.trip_source_policy import enforce_bouncie_source


def insight_query(query: dict[str, Any]) -> dict[str, Any]:
    return {
        **enforce_bouncie_source(query),
        "invalid": {"$ne": True},
        "inactive": {"$ne": True},
    }


def destination_label_expr() -> dict[str, Any]:
    """Use the same first nonempty label for grouping and exact filtering."""
    candidates = [
        "$destination.formatted_address",
        "$destination.formattedAddress",
        "$destination.name",
        "$destination.address",
        "$destination.label",
        "$destination",
    ]
    return {
        "$let": {
            "vars": {
                "labels": {
                    "$map": {
                        "input": candidates,
                        "as": "candidate",
                        "in": {
                            "$trim": {
                                "input": {
                                    "$convert": {
                                        "input": "$$candidate",
                                        "to": "string",
                                        "onError": "",
                                        "onNull": "",
                                    }
                                }
                            }
                        },
                    }
                }
            },
            "in": {
                "$ifNull": [
                    {
                        "$arrayElemAt": [
                            {
                                "$filter": {
                                    "input": "$$labels",
                                    "as": "label",
                                    "cond": {
                                        "$not": [
                                            {
                                                "$in": [
                                                    {"$toLower": "$$label"},
                                                    [
                                                        "",
                                                        "none",
                                                        "null",
                                                        "undefined",
                                                        "n/a",
                                                        "na",
                                                    ],
                                                ]
                                            }
                                        ]
                                    },
                                }
                            },
                            0,
                        ]
                    },
                    "",
                ]
            },
        }
    }
