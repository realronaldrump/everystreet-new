EdgeRef = tuple[int, int, int]  # (u, v, key)
ReqId = frozenset[
    EdgeRef
]  # physical-ish edge requirement; can include reverse if present
