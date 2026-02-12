from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import networkx as nx

logger = logging.getLogger(__name__)


_TRUE_LITERALS = {"true", "t", "1", "yes", "y", "on"}
_FALSE_LITERALS = {"false", "f", "0", "no", "n", "off"}


def _coerce_osmnx_bool(value: Any) -> bool | None:
    """
    Coerce various OSM/PBF boolean-ish values to a Python bool.

    OSMnx's GraphML loader only accepts "True"/"False" string literals
    (or a bool) for bool-typed attributes. Pyrosm can emit values like
    "yes"/"no".
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        # Accept 0/1, but also anything numeric as a last resort.
        return bool(value)
    if isinstance(value, str):
        raw = value.strip()
        if raw in {"True", "False"}:
            return raw == "True"
        lowered = raw.lower()
        if lowered in _TRUE_LITERALS:
            return True
        if lowered in _FALSE_LITERALS:
            return False
        if lowered == "-1":
            # OSM oneway=-1 means oneway, reversed direction. We don't attempt to
            # reverse edge orientation here, only make the value loadable.
            return True
    return None


def load_graphml_robust(graph_path: Path) -> nx.MultiDiGraph:
    """
    Load an OSMnx GraphML file, repairing common pyrosm/OSM literal issues.

    Motivation: OSMnx's GraphML loader only accepts "True"/"False" for boolean
    attrs like `oneway`/`reversed`. Some pipelines emit "yes"/"no" instead.

    This function:
    1) Tries `ox.load_graphml` (fast path).
    2) On invalid boolean literals, retries `ox.load_graphml` with permissive
       dtype converters for boolean-ish values (e.g., "yes"/"no").
    """
    graph_path = Path(graph_path)

    import osmnx as ox

    try:
        G = ox.load_graphml(graph_path)
    except ValueError as exc:
        msg = str(exc)
        if "Invalid literal for boolean" not in msg:
            raise

        logger.warning(
            "GraphML contains non-OSMnx boolean literals; retrying with a permissive converter: %s",
            graph_path,
        )

        def _convert(value: bool | str) -> bool:
            coerced = _coerce_osmnx_bool(value)
            if coerced is None:
                # Keep OSMnx's strictness for truly unknown values.
                msg = f"Invalid literal for boolean: {value!r}."
                raise ValueError(msg)
            return coerced

        G = ox.load_graphml(
            graph_path,
            edge_dtypes={"oneway": _convert, "reversed": _convert},
            graph_dtypes={"simplified": _convert, "consolidated": _convert},
        )

    if not isinstance(G, nx.MultiDiGraph):
        G = nx.MultiDiGraph(G)
    return G
