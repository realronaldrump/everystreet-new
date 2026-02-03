from fastapi.templating import Jinja2Templates


def format_number_filter(value: float | None) -> str:
    """Format a number with K/M suffix for large numbers."""
    if value is None:
        return "0"
    try:
        num = float(value)
        if num >= 1_000_000:
            return f"{num / 1_000_000:.1f}M"
        if num >= 1_000:
            return f"{num / 1_000:.1f}K"
        return str(int(num))
    except (ValueError, TypeError):
        return str(value)


def register_template_filters(templates: Jinja2Templates) -> None:
    """Register shared Jinja filters on a template environment."""
    if "format_number" not in templates.env.filters:
        templates.env.filters["format_number"] = format_number_filter
