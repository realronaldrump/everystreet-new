from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".py",
    ".toml",
    ".yaml",
    ".yml",
}
IGNORED_PARTS = {".git", ".venv", "coverage", "htmlcov", "node_modules"}
PROHIBITED_BRAND = "Every" + "Street"


def test_brand_name_always_contains_a_space() -> None:
    violations = []

    for path in ROOT.rglob("*"):
        if (
            not path.is_file()
            or path.suffix not in TEXT_SUFFIXES
            or IGNORED_PARTS.intersection(path.relative_to(ROOT).parts)
        ):
            continue

        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if PROHIBITED_BRAND in line:
                violations.append(f"{path.relative_to(ROOT)}:{line_number}")

    assert not violations, (
        "The product name must always be written as 'Every Street'. "
        f"Found prohibited spelling at: {', '.join(violations)}"
    )
