"""Build the first-party navigation asset in CI/the image, never at app startup.

Published UMD distributions already include their dependencies. Pinning the exact
bytes avoids a transitive dependency resolution or a runtime CDN dependency.
"""

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def build() -> None:
    root = Path(__file__).resolve().parents[1]
    assets = json.loads((root / "config/swup-assets.json").read_text())
    chunks = ["/* Swup and official plugins: MIT license. See swup-LICENSE.txt. */\n"]
    for asset in assets:
        with urlopen(asset["url"], timeout=45) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != asset["sha256"]:
            raise ValueError(f"Swup asset digest mismatch: {asset['url']}")
        chunks.append(content.decode().split("//# sourceMappingURL=")[0])
        chunks.append(f"\nexport const {asset['global']} = globalThis.{asset['global']};\n")
    output = root / "static/js/vendor"
    output.mkdir(parents=True, exist_ok=True)
    (output / "swup.js").write_text("\n;\n".join(chunks))
    with urlopen("https://cdn.jsdelivr.net/npm/swup@4.8.2/LICENSE", timeout=45) as response:
        (output / "swup-LICENSE.txt").write_bytes(response.read())


if __name__ == "__main__":
    build()
