"""Build the first-party navigation asset in CI/the image, never at app startup.

Published UMD distributions already include their dependencies. Pinning the exact
bytes avoids a transitive dependency resolution or a runtime CDN dependency.
"""

import hashlib
import json
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

FETCH_ATTEMPTS = 4


def fetch(url: str) -> bytes:
    """Read a pinned asset, retrying the transient resets a CDN edge can send."""
    for attempt in range(FETCH_ATTEMPTS):
        try:
            with urlopen(url, timeout=45) as response:
                return response.read()
        except (URLError, ConnectionError, TimeoutError):
            if attempt == FETCH_ATTEMPTS - 1:
                raise
            time.sleep(2 ** (attempt + 1))
    raise AssertionError("unreachable")


def build() -> None:
    root = Path(__file__).resolve().parents[1]
    assets = json.loads((root / "config/swup-assets.json").read_text())
    chunks = ["/* Swup and official plugins: MIT license. See swup-LICENSE.txt. */\n"]
    for asset in assets:
        content = fetch(asset["url"])
        if hashlib.sha256(content).hexdigest() != asset["sha256"]:
            raise ValueError(f"Swup asset digest mismatch: {asset['url']}")
        chunks.append(content.decode().split("//# sourceMappingURL=")[0])
        chunks.append(f"\nexport const {asset['global']} = globalThis.{asset['global']};\n")
    output = root / "static/js/vendor"
    output.mkdir(parents=True, exist_ok=True)
    (output / "swup.js").write_text("\n;\n".join(chunks))
    (output / "swup-LICENSE.txt").write_bytes(
        fetch("https://cdn.jsdelivr.net/npm/swup@4.8.2/LICENSE")
    )


if __name__ == "__main__":
    build()
