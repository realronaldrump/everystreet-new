"""Structural guardrails for the Field Atlas design language."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSS_ROOT = ROOT / "static" / "css"
VARIABLES_CSS = CSS_ROOT / "core" / "variables.css"
PAGE_CSS = tuple(sorted(CSS_ROOT.glob("*.css")))
TEMPLATES = tuple(sorted((ROOT / "templates").glob("*.html")))

HEX_COLOR = re.compile(r"(?<![\w-])#[0-9a-fA-F]{3,8}\b")
FONT_LITERAL = re.compile(r"font-size\s*:\s*[0-9]*\.?[0-9]+(?:px|rem)\b")
ACCENT_TOKEN = re.compile(r"--accent(?:-(?:rgb|light|dark))?\b")
COLOR_DECLARATION = re.compile(
    r"^\s*(?:color|background(?:-color)?)\s*:\s*([^;]+);", re.MULTILINE
)
FUNCTION_COLOR_LITERAL = re.compile(r"\b(?:rgb|rgba|hsl|hsla)\(\s*(?!var\()")
NAMED_COLOR_LITERAL = re.compile(
    r"(?<![-\w])(?:white|black|red|green|blue|yellow|orange|purple|gray|grey)(?![-\w])",
    re.IGNORECASE,
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _matches(paths: tuple[Path, ...], pattern: re.Pattern[str]) -> list[str]:
    violations: list[str] = []
    for path in paths:
        for line_number, line in enumerate(_read(path).splitlines(), start=1):
            if pattern.search(line):
                violations.append(
                    f"{path.relative_to(ROOT)}:{line_number}: {line.strip()}"
                )
    return violations


def test_page_css_has_no_raw_hex_colors() -> None:
    assert not (violations := _matches(PAGE_CSS, HEX_COLOR)), "\n".join(violations)


def test_page_css_uses_type_scale_tokens() -> None:
    assert not (violations := _matches(PAGE_CSS, FONT_LITERAL)), "\n".join(violations)


def test_accent_alias_is_confined_to_variables() -> None:
    css_files = tuple(path for path in CSS_ROOT.rglob("*.css") if path != VARIABLES_CSS)
    assert not (violations := _matches(css_files, ACCENT_TOKEN)), "\n".join(violations)


def test_page_color_declarations_have_no_color_literals() -> None:
    violations: list[str] = []
    for path in PAGE_CSS:
        source = _read(path)
        for match in COLOR_DECLARATION.finditer(source):
            value = match.group(1)
            if (
                HEX_COLOR.search(value)
                or FUNCTION_COLOR_LITERAL.search(value)
                or NAMED_COLOR_LITERAL.search(value)
            ):
                line_number = source.count("\n", 0, match.start()) + 1
                violations.append(
                    f"{path.relative_to(ROOT)}:{line_number}: {match.group(0).strip()}"
                )
    assert not violations, "\n".join(violations)


def test_standard_page_templates_have_a_masthead() -> None:
    exemptions = {
        "404.html": "bespoke error hero",
        "base.html": "application shell",
        "index.html": "immersive map",
        "landing.html": "marketing hero",
        "live_navigation.html": "safety-critical immersive navigation",
    }
    template_names = {path.name for path in TEMPLATES}
    assert exemptions.keys() <= template_names

    missing = [
        path.name
        for path in TEMPLATES
        if "page-masthead" not in _read(path) and path.name not in exemptions
    ]
    assert not missing, (
        f"Templates need a page masthead or explicit exemption: {missing}"
    )


def test_theme_color_constants_match_surface_tokens() -> None:
    variables = _read(VARIABLES_CSS)
    base = _read(ROOT / "templates" / "base.html")
    navigation = _read(ROOT / "static" / "js" / "modules" / "core" / "navigation.js")

    assert "--surface-deep: #050507" in variables
    assert "--surface-0: #f4f1e8" in variables
    for source in (base, navigation):
        assert "#050507" in source
        assert "#f4f1e8" in source


def test_retired_component_patterns_stay_removed() -> None:
    patterns = {
        "Bootstrap pill tabs": re.compile(
            r"nav-pills|data-bs-toggle\s*=\s*['\"]pill['\"]"
        ),
        "beige card headers": re.compile(r"(?:beige-card-header|card-header-beige)"),
        "legacy stepper connectors": re.compile(
            r"(?:mm-phase|setup-progress|ws)-connector"
        ),
    }
    sources = TEMPLATES + tuple(sorted(CSS_ROOT.rglob("*.css")))
    violations: list[str] = []
    for label, pattern in patterns.items():
        violations.extend(f"{label}: {item}" for item in _matches(sources, pattern))
    assert not violations, "\n".join(violations)


def test_theme_toggle_uses_single_unambiguous_icon() -> None:
    base = _read(ROOT / "templates" / "base.html")
    toggle = base[
        base.index('<label class="theme-toggle"') : base.index(
            "</label>", base.index('<label class="theme-toggle"')
        )
    ]
    assert "fa-circle-half-stroke" in toggle
    assert "fa-moon" not in toggle
    assert "fa-sun" not in toggle
