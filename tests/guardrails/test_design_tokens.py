"""Structural guardrails for the Blueprint & Brass design language."""

import colorsys
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSS_ROOT = ROOT / "static" / "css"
VARIABLES_CSS = CSS_ROOT / "core" / "variables.css"
PAGE_CSS = tuple(sorted(CSS_ROOT.glob("*.css")))
TEMPLATES = tuple(sorted((ROOT / "templates").glob("*.html")))

HEX_COLOR = re.compile(r"(?<![\w-])#[0-9a-fA-F]{3,8}\b")
FONT_LITERAL = re.compile(r"font-size\s*:\s*[0-9]*\.?[0-9]+(?:px|rem)\b")
ACCENT_TOKEN = re.compile(
    r"--(?:glow-)?accent(?:-(?:rgb|light|dark|strong|intense))?\b"
)
SIX_DIGIT_HEX_COLOR = re.compile(r"(?<![\w-])#([0-9a-fA-F]{6})\b")
NUMERIC_RGB_COLOR = re.compile(
    r"\brgba?\(\s*(\d{1,3})\s*(?:,|\s)\s*(\d{1,3})\s*(?:,|\s)\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+%?)?\s*\)",
    re.IGNORECASE,
)
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


def test_accent_tokens_are_removed() -> None:
    css_files = tuple(sorted(CSS_ROOT.rglob("*.css")))
    assert not (violations := _matches(css_files, ACCENT_TOKEN)), "\n".join(violations)


def test_personalized_accent_setting_is_removed() -> None:
    personalization = ROOT / "static" / "js" / "modules" / "ui" / "personalization.js"
    density_manager = ROOT / "static" / "js" / "modules" / "ui" / "density-manager.js"
    sources = (
        ROOT / "templates" / "control_center.html",
        ROOT
        / "static"
        / "js"
        / "modules"
        / "features"
        / "settings"
        / "app-settings.js",
        ROOT / "static" / "js" / "modules" / "ui" / "ui-init.js",
    )
    retired_markers = re.compile(
        r"accent-color-picker|es:accent-color|window\.personalization|personalization\.js"
    )
    admin_service = _read(ROOT / "admin" / "services" / "admin_service.py")
    models = _read(ROOT / "db" / "models.py")
    app_settings_model = models[
        models.index("class AppSettings") : models.index("class ServerLog")
    ]

    assert not personalization.exists()
    assert density_manager.exists()
    assert not (violations := _matches(sources, retired_markers)), "\n".join(violations)
    assert 'payload.pop("accentColor", None)' in admin_service
    assert 'settings.pop("accentColor", None)' in admin_service
    assert "accentColor" not in app_settings_model


def _is_green_hued(red: int, green: int, blue: int) -> bool:
    hue, _lightness, saturation = colorsys.rgb_to_hls(
        red / 255, green / 255, blue / 255
    )
    hue_degrees = hue * 360
    return 75 <= hue_degrees <= 185 and saturation >= 0.15


def test_application_palette_has_no_green_hued_color_literals() -> None:
    sources = (
        tuple(sorted(CSS_ROOT.rglob("*.css")))
        + tuple(sorted((ROOT / "static" / "js").rglob("*.js")))
        + TEMPLATES
    )
    violations: list[str] = []
    for path in sources:
        for line_number, line in enumerate(_read(path).splitlines(), start=1):
            for match in SIX_DIGIT_HEX_COLOR.finditer(line):
                value = match.group(1)
                rgb = tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))
                if _is_green_hued(*rgb):
                    violations.append(
                        f"{path.relative_to(ROOT)}:{line_number}: #{value}"
                    )
            for match in NUMERIC_RGB_COLOR.finditer(line):
                rgb = tuple(int(match.group(index)) for index in (1, 2, 3))
                if max(rgb) <= 255 and _is_green_hued(*rgb):
                    violations.append(
                        f"{path.relative_to(ROOT)}:{line_number}: rgb{rgb}"
                    )

    assert not violations, "\n".join(violations)


def test_foundation_palette_uses_fixed_survey_colors() -> None:
    variables = _read(VARIABLES_CSS)
    assert "--cat-cobalt: #6f8fce" in variables
    assert "--cat-ochre: #d4a24a" in variables
    assert "--cat-coral: #c47050" in variables
    for retired_token in ("--cat-sage", "--cat-olive", "--cat-mint", "--cat-lime"):
        assert retired_token not in variables

    retired_colors = re.compile(
        r"#(?:3b8a7f|2f7268|4d9a6a|2f9e8f|b87a4a|d09868|6a9fc0|5fa0c4|3d9be9|e7f7ff)\b",
        re.IGNORECASE,
    )
    sources = (
        tuple(sorted(CSS_ROOT.rglob("*.css")))
        + tuple(sorted((ROOT / "static" / "js").rglob("*.js")))
        + TEMPLATES
    )
    assert not (violations := _matches(sources, retired_colors)), "\n".join(violations)


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


def test_runtime_theme_switch_keeps_html_and_body_in_sync() -> None:
    theme_manager = _read(
        ROOT / "static" / "js" / "modules" / "ui" / "theme-manager.js"
    )
    light_mode_toggle = "classList.toggle(CONFIG.UI.classes.lightMode, isLight)"
    assert theme_manager.count(light_mode_toggle) == 2


def test_disabled_buttons_keep_canonical_action_colors() -> None:
    buttons = _read(CSS_ROOT / "components" / "buttons.css")
    disabled_rule = buttons[
        buttons.index(".btn:disabled,") : buttons.index(
            ".btn:hover:not(:disabled, .disabled)"
        )
    ]
    assert "background-color: var(--btn-bg, transparent)" in disabled_rule
    assert "color: var(--btn-color, var(--text-primary))" in disabled_rule
    assert "border-color: var(--btn-border, transparent)" in disabled_rule


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
